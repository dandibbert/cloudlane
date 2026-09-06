import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, spec, profile, Z1, Z2 } from './helpers.mjs';
import { buildRoutePlan, buildRollbackPlan, buildDeletePlan, syncProfileRoutes, applyAction, observe } from '../worker/planner.mjs';

async function completed() {
  const f = await fixture(); await f.login();
  f.cf.nextCustomStatus = 'active'; f.cf.nextSSLStatus = 'active';
  const submitted = await f.submit();
  const job = await f.advance(submitted.job.id);
  assert.equal(job.status, 'done');
  return { ...f, job, routeId: submitted.plan.routeId };
}

test('shared edge change and rollback restore both real DNS and preset metadata', async () => {
  const f = await fixture(); await f.login();
  const { body: plan } = await f.request(`/profiles/${profile.id}/edge-plan`, 'POST', { target: 'new-preferred.example.net' });
  assert.equal(f.cf.writes().length, 0);
  const { body: queued } = await f.request(`/plans/${plan.id}/apply`, 'POST', { acknowledge: true, confirmHostname: profile.edgeHostname });
  const job = await f.advance(queued.id); assert.equal(job.status, 'done');
  assert.equal((await f.ctx.get(`profile:${profile.id}`)).edgeTarget, 'new-preferred.example.net');
  const inverse = await buildRollbackPlan(f.ctx, job); await f.ctx.put(`plan:${inverse.id}`, inverse);
  const { body: undo } = await f.request(`/plans/${inverse.id}/apply`, 'POST', { acknowledge: true, confirmHostname: profile.edgeHostname });
  const result = await f.advance(undo.id); assert.equal(result.status, 'done');
  assert.equal(f.cf.rows(Z1)[0].content, profile.edgeTarget);
  assert.equal((await f.ctx.get(`profile:${profile.id}`)).edgeTarget, profile.edgeTarget);
  await assert.rejects(buildRollbackPlan(f.ctx, result), { code: 'ROLLBACK_OF_ROLLBACK' });
});

test('external custom-hostname TLS settings change blocks destructive rollback', async () => {
  const f = await completed(); f.cf.customs[0].ssl.settings.min_tls_version = '1.3';
  await assert.rejects(buildRollbackPlan(f.ctx, f.job), { code: 'ROLLBACK_DRIFT' });
});

test('lost custom-hostname create response is reconciled without claiming deletion ownership', async () => {
  const f = await fixture(); const plan = await buildRoutePlan(f.ctx, spec);
  const action = plan.actions.find(a => a.kind === 'custom');
  f.cf.interrupt = (path, method) => path.endsWith('/custom_hostnames') && method === 'POST';
  await assert.rejects(applyAction(f.ctx, action, async () => {}));
  assert.equal(action.state, 'writing');
  await applyAction(f.ctx, action, async () => {});
  assert.equal(action.ownershipUncertain, true); assert(action.notice);
  assert.equal(f.cf.writes().filter(c => c.path.endsWith('/custom_hostnames')).length, 1);
  const dns = plan.actions.find(a => a.kind === 'dns' && a.role === 'origin');
  await applyAction(f.ctx, dns, async () => {});
  const inverse = await buildRollbackPlan(f.ctx, { id: 'test-job', status: 'done', plan, actions: [dns, action] });
  assert(!inverse.actions.some(a => a.kind === 'custom'));
});

test('explicit revalidation preserves original certificate method/type and is not undoable', async () => {
  const f = await completed(); delete f.cf.customs[0].ssl.custom_key;
  const plan = await buildRoutePlan(f.ctx, { ...spec, revalidate: true }, f.routeId);
  const action = plan.actions.find(a => a.kind === 'custom');
  assert.deepEqual(action.patchBody.ssl, { method: 'txt', type: 'dv' }); assert.equal(action.eventOnly, true);
  await applyAction(f.ctx, action, async () => {});
  assert.equal(f.cf.calls.at(-1).method, 'PATCH');
  assert.equal(f.cf.customs[0].ssl.settings.min_tls_version, '1.2');
});

test('manual certificates cannot be refreshed as Cloudflare managed certificates', async () => {
  const f = await completed();
  await assert.rejects(buildRoutePlan(f.ctx, { ...spec, revalidate: true }, f.routeId), { code: 'VALIDATION_REFRESH_UNSUPPORTED' });
});

test('fallback loss is drift, never ready; blocked hostname stops instead of endless polling', async () => {
  const f = await completed(); const route = await f.ctx.get(`route:${f.routeId}`);
  f.cf.fallback = null;
  const status = await observe(f.ctx, route, profile);
  assert.equal(status.fallbackStatus, 'missing'); assert.equal(status.status, 'drift');
  const other = await fixture(); await other.login(); other.cf.nextCustomStatus = 'blocked';
  const { job } = await other.submit(); const stopped = await other.advance(job.id);
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.error.code, 'VALIDATION_STOPPED');
  assert(!other.cf.rows(Z2).some(r => r.name === spec.publicHostname));
});

test('maintenance only creates validation jobs for previously approved records', async () => {
  const f = await completed(); let route = await f.ctx.get(`route:${f.routeId}`);
  f.cf.customs[0].ssl.status = 'pending_validation';
  route.nextCheckAt = 0; route.maintenanceEnabled = false; await f.ctx.put(`route:${route.id}`, route);
  await f.ctx.maintain(); assert.equal((await f.ctx.list('job:')).length, 1);
  route = await f.ctx.get(`route:${route.id}`); route.nextCheckAt = 0; route.maintenanceEnabled = true; await f.ctx.put(`route:${route.id}`, route);
  await f.ctx.maintain(); const renewal = (await f.ctx.list('job:')).find(j => j.plan.type === 'renewal');
  assert(renewal); assert.equal(renewal.actions.length, 0); assert(renewal.plan.warnings[0].includes('不改变流量 DNS'));
});

test('rollback preview cannot silently discard later local metadata changes', async () => {
  const f = await completed(); const inverse = await buildRollbackPlan(f.ctx, f.job); await f.ctx.put(`plan:${inverse.id}`, inverse);
  const route = await f.ctx.get(`route:${f.routeId}`); route.name = 'Changed after preview'; await f.ctx.put(`route:${route.id}`, route);
  const result = await f.request(`/plans/${inverse.id}/apply`, 'POST', { acknowledge: true, confirmHostname: spec.publicHostname });
  assert.equal(result.response.status, 409); assert.equal(result.body.error.code, 'STALE_PLAN');
});

test('long hostname uses managed certificate branding instead of invalid CN', async () => {
  const f = await fixture(); const publicHostname = `${'a'.repeat(40)}.${'b'.repeat(25)}.b.example`;
  const plan = await buildRoutePlan(f.ctx, { ...spec, publicHostname });
  assert.equal(plan.actions.find(a => a.kind === 'custom').createBody.ssl.cloudflare_branding, true);
});

test('profile synchronization refreshes managed rows from live Cloudflare state', async () => {
  const f = await completed();
  const originRule = f.cf.config.ingress.find(x => x.hostname === spec.originHostname);
  originRule.service = 'http://localhost:7777';
  const publicDNS = f.cf.rows(Z2).find(r => r.name === spec.publicHostname);
  publicDNS.content = 'new-speed.a.example';
  const writesBefore = f.cf.writes().length;
  const result = await syncProfileRoutes(f.ctx, profile);
  assert.equal(result.routes, 1);
  const route = await f.ctx.get(`route:${f.routeId}`);
  assert.equal(route.remote.service, 'http://localhost:7777');
  assert.equal(route.remote.edgeHostname, 'new-speed.a.example');
  assert(route.observed.drift.some(x => x.includes('访问 DNS')));
  assert.equal(f.cf.writes().length, writesBefore, 'synchronization must be read-only against Cloudflare');
  const state = await f.request('/state');
  assert.equal(state.body.routes[0].remote.service, 'http://localhost:7777');
  assert.equal(state.body.discoveries[0].profileId, profile.id);
});

test('cloud delete removes only route-owned resources and preserves unrelated Tunnel configuration', async () => {
  const f = await completed();
  const untouched = structuredClone(f.cf.config.ingress.find(x => x.hostname === 'untouched.a.example'));
  const globals = { originRequest: structuredClone(f.cf.config.originRequest), warp: structuredClone(f.cf.config['warp-routing']) };
  const plan = await buildDeletePlan(f.ctx, f.routeId);
  assert.equal(plan.type, 'delete');
  assert(plan.actions.some(a => a.kind === 'custom'));
  assert(plan.actions.some(a => a.kind === 'tunnel'));
  await f.ctx.put(`plan:${plan.id}`, plan);
  assert.equal((await f.request(`/plans/${plan.id}/apply`, 'POST', { acknowledge: true, confirmHostname: 'wrong.b.example' })).response.status, 400);
  const queued = await f.request(`/plans/${plan.id}/apply`, 'POST', { acknowledge: true, confirmHostname: spec.publicHostname });
  assert.equal(queued.response.status, 202);
  const done = await f.advance(queued.body.id);
  assert.equal(done.status, 'done');
  assert.equal(await f.ctx.get(`route:${f.routeId}`), undefined);
  assert.equal(f.cf.customs.length, 0);
  assert(!f.cf.rows(Z2).some(r => [spec.publicHostname, `_cf-custom-hostname.${spec.publicHostname}`, `_acme-challenge.${spec.publicHostname}`].includes(r.name)));
  assert(!f.cf.rows(Z1).some(r => r.name === spec.originHostname));
  assert(f.cf.rows(Z1).some(r => r.name === profile.edgeHostname), 'shared edge must survive route deletion');
  assert(!f.cf.config.ingress.some(r => [spec.publicHostname, spec.originHostname].includes(r.hostname)));
  assert.deepEqual(f.cf.config.ingress.find(x => x.hostname === 'untouched.a.example'), untouched);
  assert.deepEqual(f.cf.config.originRequest, globals.originRequest);
  assert.deepEqual(f.cf.config['warp-routing'], globals.warp);
  assert.equal(f.cf.config.ingress.at(-1).service, 'http_status:404');
  assert.equal(f.cf.fallback.status, 'active', 'SaaS fallback is shared and must survive');
});

test('cloud delete preserves origin DNS and ingress when another SaaS hostname shares that origin', async () => {
  const f = await completed();
  f.cf.customs.push({ id: 'shared-ch', hostname: 'other.b.example', custom_origin_server: spec.originHostname, status: 'active', ssl: { status: 'active' } });
  const plan = await buildDeletePlan(f.ctx, f.routeId);
  assert(plan.warnings.some(w => w.includes('共享')));
  const tunnel = plan.actions.find(a => a.kind === 'tunnel');
  assert(tunnel.after.ingress.some(r => r.hostname === spec.originHostname));
  assert(!tunnel.after.ingress.some(r => r.hostname === spec.publicHostname));
  assert(!plan.actions.some(a => a.role === 'delete_origin'));
});
