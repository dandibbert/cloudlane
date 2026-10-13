import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, spec, profile, Z1, Z2, B, KEY } from './helpers.mjs';
import { seal } from '../worker/core.mjs';
import { buildRoutePlan, buildRollbackPlan } from '../worker/planner.mjs';

const Z3 = '3'.repeat(32);
const Z4 = '4'.repeat(32);
const C = 'c'.repeat(32);
const NEW_MAIN = 'load.new.example';

async function routeWithNewZone() {
  const f = await fixture();
  await f.login();
  f.cf.nextCustomStatus = 'active';
  f.cf.nextSSLStatus = 'active';
  const submitted = await f.submit();
  const result = await f.advance(submitted.job.id);
  assert.equal(result.status, 'done');
  f.cf.zones.find(z => z.id === Z2).status = 'pending'; // old public Zone expired
  f.cf.zones.push({ id: Z3, name: 'new.example', status: 'active', account: { id: B } });
  f.cf.dns.set(Z3, []);
  return { f, routeId: submitted.plan.routeId, input: {
    ...spec, routeId: submitted.plan.routeId,
    destinationCredentialId: 'cred-2', destinationZoneId: Z3,
    publicHostname: NEW_MAIN
  } };
}

test('a verified new Zone is previewed without creating a profile or writing Cloudflare', async () => {
  const { f, routeId, input } = await routeWithNewZone();
  const writes = f.cf.writes().length;
  const profilesBefore = await f.ctx.list('profile:');
  const preview = await f.request('/plans', 'POST', input);
  assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
  const plan = preview.body;
  assert.equal(plan.previous.id, routeId);
  assert.equal(plan.migration.from, spec.publicHostname);
  assert.equal(plan.migration.to, NEW_MAIN);
  assert.equal(plan.profile.publicZone.id, Z3);
  assert.equal(plan.profile.sourceZone.id, Z1);
  assert.equal(plan.profile.tunnelId, profile.tunnelId);
  assert.equal(plan.newProfile.id, plan.spec.profileId);
  assert(plan.warnings.some(w => w.includes('自动保存')));
  assert(!plan.actions.some(a => a.after === null));
  assert.deepEqual(await f.ctx.list('profile:'), profilesBefore);
  assert.equal(f.cf.writes().length, writes, 'preview must remain read only');
});

test('approving a new Zone creates its profile atomically, keeps the record ID and preserves old resources', async () => {
  const { f, routeId, input } = await routeWithNewZone();
  const oldRecords = structuredClone(f.cf.rows(Z2));
  const oldCustom = f.cf.customs.find(c => c.hostname === spec.publicHostname);
  const writesBefore = f.cf.writes().length, callsBefore = f.cf.calls.length;
  const preview = await f.request('/plans', 'POST', input);
  const plan = preview.body;
  const approval = await f.request('/plans/' + plan.id + '/apply', 'POST', { acknowledge: true });
  assert.equal(approval.response.status, 202, JSON.stringify(approval.body));
  const stored = await f.ctx.get('profile:' + plan.profile.id);
  assert.deepEqual(stored, plan.newProfile);
  const done = await f.advance(approval.body.id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  const after = await f.ctx.get('route:' + routeId);
  assert.equal(after.id, routeId);
  assert.equal(after.profileId, stored.id);
  assert.equal(after.publicHostname, NEW_MAIN);
  assert.equal(after.originHostname, spec.originHostname);
  assert.equal(after.edgeHostname, spec.edgeHostname);
  assert.equal(after.service, spec.service);
  assert.equal(after.observed.status, 'ready');
  assert.deepEqual(f.cf.rows(Z2), oldRecords);
  assert(f.cf.customs.some(c => c.id === oldCustom.id));
  assert(f.cf.customs.some(c => c.hostname === NEW_MAIN));
  assert(f.cf.rows(Z3).some(r => r.name === NEW_MAIN));
  assert(f.cf.config.ingress.some(r => r.hostname === spec.publicHostname));
  assert(f.cf.config.ingress.some(r => r.hostname === NEW_MAIN));
  assert(f.cf.writes().length > writesBefore);
  assert(!f.cf.calls.slice(callsBefore).some(c => c.path.startsWith('/zones/' + Z2)),
    'expired old public Zone must never be required for migration');
});

test('new Zone preview is rejected if it became inactive before approval, leaving the profile unsaved', async () => {
  const { f, input } = await routeWithNewZone();
  const { body: plan } = await f.request('/plans', 'POST', input);
  const writes = f.cf.writes().length;
  f.cf.zones.find(z => z.id === Z3).status = 'pending';
  const approval = await f.request('/plans/' + plan.id + '/apply', 'POST', { acknowledge: true });
  assert.equal(approval.response.status, 409);
  assert.equal(approval.body.error.code, 'ZONE_NOT_ACTIVE');
  assert.equal(await f.ctx.get('profile:' + plan.profile.id), undefined);
  assert.equal(f.cf.writes().length, writes);
});

test('new Zone preview validates account ownership and active state server-side', async () => {
  const { f, input } = await routeWithNewZone();
  const writes = f.cf.writes().length;
  await assert.rejects(buildRoutePlan(f.ctx, { ...input, destinationCredentialId: 'cred-1' }, input.routeId), { code: 'ZONE_MISMATCH' });
  f.cf.zones.find(z => z.id === Z3).status = 'pending';
  await assert.rejects(buildRoutePlan(f.ctx, input, input.routeId), { code: 'ZONE_NOT_ACTIVE' });
  assert.equal(f.cf.writes().length, writes);
});

test('existing compatible profile is reused for the Zone instead of duplicated', async () => {
  const { f, input } = await routeWithNewZone();
  const existing = {
    ...profile, id: 'existing-destination', publicZone: { id: Z3, name: 'new.example' }
  };
  await f.ctx.put('profile:' + existing.id, existing);
  const plan = await buildRoutePlan(f.ctx, input, input.routeId);
  assert.equal(plan.profile.id, existing.id);
  assert.equal(plan.spec.profileId, existing.id);
  assert.equal(plan.newProfile, null);
});

test('Zone selection can use a saved credential from a different Cloudflare account', async () => {
  const { f, input } = await routeWithNewZone();
  await f.ctx.put('credential:cred-3', {
    id: 'cred-3', label: 'Third Account', accountId: C,
    secret: await seal('third-token', KEY, 'cred-3')
  });
  f.cf.zones.push({ id: Z4, name: 'third.example', status: 'active', account: { id: C } });
  f.cf.dns.set(Z4, []);
  const plan = await buildRoutePlan(f.ctx, {
    ...input, publicHostname: 'load.third.example', destinationCredentialId: 'cred-3',
    destinationZoneId: Z4
  }, input.routeId);
  assert.equal(plan.profile.publicCredentialId, 'cred-3');
  assert.equal(plan.profile.publicZone.name, 'third.example');
});

test('same-Zone hostname edit preserves the existing profile and rejects apex names', async () => {
  const { f, routeId } = await routeWithNewZone();
  f.cf.zones.find(z => z.id === Z2).status = 'active';
  const input = { ...spec, destinationCredentialId: 'cred-2', destinationZoneId: Z2,
    publicHostname: 'image-alt.b.example' };
  const plan = await buildRoutePlan(f.ctx, input, routeId);
  assert.equal(plan.newProfile, null);
  assert.equal(plan.profile.id, profile.id);
  await assert.rejects(buildRoutePlan(f.ctx, { ...input, publicHostname: 'b.example' }, routeId), /访问域名必须是访问 Zone 下的子域名/);
  await assert.rejects(buildRoutePlan(f.ctx, { ...input, publicHostname: 'image.other.example' }, routeId), /访问域名必须是访问 Zone 下的子域名/);
});

test('a stale parallel preview cannot persist a second auto-generated Zone profile', async () => {
  const { f, input } = await routeWithNewZone();
  const p1 = await f.request('/plans', 'POST', input);
  const p2 = await f.request('/plans', 'POST', input);
  assert.equal(p1.response.status, 200);
  assert.equal(p2.response.status, 200);
  const applied1 = await f.request('/plans/' + p1.body.id + '/apply', 'POST', { acknowledge: true });
  assert.equal(applied1.response.status, 202);
  // While job #1 is queued the server returns JOB_BUSY; after it completes,
  // preview #2 must still be rejected as stale rather than creating a profile.
  assert.equal((await f.advance(applied1.body.id)).status, 'done');
  const applied2 = await f.request('/plans/' + p2.body.id + '/apply', 'POST', { acknowledge: true });
  assert.equal(applied2.response.status, 409);
  assert.equal(applied2.body.error.code, 'STALE_PLAN');
  assert.equal((await f.ctx.list('profile:')).length, 2);
});

test('rollback restores original route and removes only the newly provisioned MAIN assets', async () => {
  const { f, routeId, input } = await routeWithNewZone();
  const { plan, job } = await f.submit(input);
  const done = await f.advance(job.id);
  assert.equal(done.status, 'done');
  const inverse = await buildRollbackPlan(f.ctx, done);
  await f.ctx.put('plan:' + inverse.id, inverse);
  const applied = await f.request('/plans/' + inverse.id + '/apply', 'POST', { acknowledge: true });
  assert.equal(applied.response.status, 202);
  assert.equal((await f.advance(applied.body.id)).status, 'done');
  const restored = await f.ctx.get('route:' + routeId);
  assert.equal(restored.publicHostname, spec.publicHostname);
  assert.equal(restored.profileId, profile.id);
  assert(f.cf.customs.some(c => c.hostname === spec.publicHostname));
  assert(!f.cf.customs.some(c => c.hostname === NEW_MAIN));
  assert(!f.cf.rows(Z3).some(r => r.name === NEW_MAIN));
});
