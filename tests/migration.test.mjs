import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, spec, profile, Z1, Z2, T, B } from './helpers.mjs';
import { buildRoutePlan, buildRollbackPlan } from '../worker/planner.mjs';

const Z3 = '3'.repeat(32);
const NEW_MAIN = 'image.c.example';

async function startingRoute() {
  const f = await fixture();
  await f.login();
  f.cf.nextCustomStatus = 'active';
  f.cf.nextSSLStatus = 'active';
  const { plan, job } = await f.submit();
  assert.equal((await f.advance(job.id)).status, 'done');
  const original = await f.ctx.get('route:' + plan.routeId);
  // An expired public zone is no longer active, but its metadata and the source
  // SaaS/Tunnel assets may still exist. Migration must not depend on this zone.
  f.cf.zones.find(z => z.id === Z2).status = 'pending';
  f.cf.zones.push({ id: Z3, name: 'c.example', status: 'active', account: { id: B } });
  f.cf.dns.set(Z3, []);
  const targetProfile = {
    ...profile, id: 'profile-replacement', name: 'Replacement public zone',
    publicZone: { id: Z3, name: 'c.example' }
  };
  await f.ctx.put('profile:' + targetProfile.id, targetProfile);
  const next = { ...spec, routeId: plan.routeId, profileId: targetProfile.id, publicHostname: NEW_MAIN };
  return { f, original, targetProfile, next, routeId: plan.routeId };
}

test('expired public Zone: MAIN can move across Zones on the same ORIGIN/Tunnel', async () => {
  const { f, original, next, routeId, targetProfile } = await startingRoute();
  const oldDNS = structuredClone(f.cf.rows(Z2));
  const originalConfig = structuredClone(f.cf.config);
  const writesBefore = f.cf.writes().length;
  const callsBefore = f.cf.calls.length;
  const preview = await f.request('/plans', 'POST', next);
  assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
  const plan = preview.body;
  assert.deepEqual(plan.migration, {
    from: original.publicHostname, to: NEW_MAIN,
    oldProfileId: original.profileId, newProfileId: targetProfile.id
  });
  assert(plan.warnings.some(w => w.includes('旧 MAIN')));
  assert(plan.actions.some(a => a.kind === 'custom' && a.name === NEW_MAIN && a.before === null));
  assert(plan.actions.some(a => a.role === 'public' && a.name === NEW_MAIN && a.phase === 'cutover'));
  assert(!plan.actions.some(a => a.after === null), 'migration must not delete old assets');
  const ingress = plan.actions.find(a => a.kind === 'tunnel');
  assert(ingress.after.ingress.some(r => r.hostname === original.publicHostname));
  assert(ingress.after.ingress.some(r => r.hostname === NEW_MAIN));
  assert.equal(f.cf.writes().length, writesBefore, 'preview must not write Cloudflare');
  const queued = await f.request('/plans/' + plan.id + '/apply', 'POST', { acknowledge: true });
  assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
  const result = await f.advance(queued.body.id);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  const updated = await f.ctx.get('route:' + routeId);
  assert.equal(updated.id, routeId);
  assert.equal(updated.profileId, targetProfile.id);
  assert.equal(updated.publicHostname, NEW_MAIN);
  assert.equal(updated.originHostname, original.originHostname);
  assert.equal(updated.edgeHostname, original.edgeHostname);
  assert.equal(updated.service, original.service);
  assert.equal(updated.observed.status, 'ready');
  assert.deepEqual(f.cf.rows(Z2), oldDNS, 'old zone must be preserved');
  assert(f.cf.rows(Z3).some(r => r.name === NEW_MAIN && r.content === original.edgeHostname));
  assert(f.cf.customs.some(c => c.hostname === original.publicHostname));
  assert(f.cf.customs.some(c => c.hostname === NEW_MAIN));
  assert(f.cf.config.ingress.some(r => r.hostname === original.publicHostname));
  assert(f.cf.config.ingress.some(r => r.hostname === NEW_MAIN));
  assert.deepEqual(f.cf.config.originRequest, originalConfig.originRequest);
  assert.deepEqual(f.cf.config['warp-routing'], originalConfig['warp-routing']);
  assert(!f.cf.calls.slice(callsBefore).some(c => c.path.startsWith('/zones/' + Z2)),
    'expired old public Zone must not be read or mutated during migration');
});

test('MAIN migration can be rolled back without accessing the expired old Zone', async () => {
  const { f, original, next, routeId } = await startingRoute();
  const baseline = structuredClone(f.cf.config);
  const { plan, job } = await f.submit(next);
  const done = await f.advance(job.id);
  assert.equal(done.status, 'done');
  const inverse = await buildRollbackPlan(f.ctx, done);
  await f.ctx.put('plan:' + inverse.id, inverse);
  const applied = await f.request('/plans/' + inverse.id + '/apply', 'POST', { acknowledge: true });
  assert.equal(applied.response.status, 202, JSON.stringify(applied.body));
  assert.equal((await f.advance(applied.body.id)).status, 'done');
  const restored = await f.ctx.get('route:' + routeId);
  assert.equal(restored.publicHostname, original.publicHostname);
  assert.equal(restored.profileId, original.profileId);
  assert.deepEqual(f.cf.config, baseline);
  assert(!f.cf.customs.some(c => c.hostname === NEW_MAIN));
  assert(!f.cf.rows(Z3).some(r => r.name === NEW_MAIN));
  assert(f.cf.customs.some(c => c.hostname === original.publicHostname));
});

test('migration refuses an existing foreign MAIN ingress and Custom Hostname', async () => {
  const { f, next } = await startingRoute();
  const writes = f.cf.writes().length;
  f.cf.config.ingress.unshift({ hostname: NEW_MAIN, service: next.service });
  await assert.rejects(buildRoutePlan(f.ctx, next, next.routeId), { code: 'UNMANAGED_CONFLICT' });
  f.cf.config.ingress.shift();
  f.cf.customs.push({ id: 'foreign-custom', hostname: NEW_MAIN, custom_origin_server: next.originHostname, ssl: { status: 'active' } });
  await assert.rejects(buildRoutePlan(f.ctx, next, next.routeId), { code: 'UNMANAGED_CONFLICT' });
  f.cf.customs.pop();
  f.cf.rows(Z3).push({ id: 'foreign-dns', name: NEW_MAIN, type: 'CNAME', proxied: false, content: 'somewhere.example', ttl: 1 });
  await assert.rejects(buildRoutePlan(f.ctx, next, next.routeId), { code: 'UNMANAGED_CONFLICT' });
  assert.equal(f.cf.writes().length, writes);
});

test('moving MAIN never permits changing ORIGIN or the source topology', async () => {
  const { f, next, targetProfile } = await startingRoute();
  const writes = f.cf.writes().length;
  await assert.rejects(buildRoutePlan(f.ctx, { ...next, originHostname: 'different.a.example' }, next.routeId), { code: 'MIGRATION_REQUIRED' });
  await assert.rejects(buildRoutePlan(f.ctx, { ...next, revalidate: true }, next.routeId), { code: 'MIGRATION_REQUIRED' });
  await f.ctx.put('profile:' + targetProfile.id, { ...targetProfile, tunnelId: '00000000-0000-4000-8000-000000000009' });
  await assert.rejects(buildRoutePlan(f.ctx, next, next.routeId), { code: 'MIGRATION_REQUIRED' });
  assert.equal(f.cf.writes().length, writes);
});

test('MAIN may change within the same Zone without a new profile', async () => {
  const { f, original, routeId } = await startingRoute();
  // The old Zone must still be active for a same-Zone replacement.
  f.cf.zones.find(z => z.id === Z2).status = 'active';
  const plan = await buildRoutePlan(f.ctx, { ...spec, publicHostname: 'image-new.b.example' }, routeId);
  assert.equal(plan.migration.from, original.publicHostname);
  assert.equal(plan.migration.to, 'image-new.b.example');
  assert.equal(plan.profile.id, profile.id);
});

test('apply-time race guard allows aliases sharing ORIGIN on the same source Tunnel', async () => {
  const { f, next, routeId } = await startingRoute();
  await f.ctx.put('route:other-alias', { ...spec, id: 'other-alias', profileId: profile.id, publicHostname: 'other.b.example' });
  const { body: preview, response } = await f.request('/plans', 'POST', next);
  assert.equal(response.status, 200, JSON.stringify(preview));
  const applied = await f.request('/plans/' + preview.id + '/apply', 'POST', { acknowledge: true });
  assert.equal(applied.response.status, 202, JSON.stringify(applied.body));
  assert.equal((await f.advance(applied.body.id)).status, 'done');
  assert.equal((await f.ctx.get('route:' + routeId)).publicHostname, NEW_MAIN);
});
