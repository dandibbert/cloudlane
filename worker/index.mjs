import { AppError, requireThat, text, cfId, tunnelId, hostname, inZone, id, now, clone, equal, digest, constantTimeEqual, seal, unseal, validateSecrets, json, safeError } from './core.mjs';
import { Cloudflare } from './cloudflare.mjs';
import { buildRoutePlan, buildRollbackPlan, buildDeletePlan, discoverRoutes, syncProfileRoutes, validateProfileLive, planDNS, applyAction, readResource, validationActions, observe, checkEdge } from './planner.mjs';

const active = job => ['queued', 'running', 'waiting', 'retrying'].includes(job.status);
const security = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
const cookieName = request => new URL(request.url).protocol === 'https:' ? '__Host-cloudlane_session' : 'cloudlane_dev_session';
function cookie(request, value, maxAge) {
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
async function bodyOf(request) {
  requireThat((request.headers.get('Content-Type') || '').startsWith('application/json'), '请求必须使用 application/json。', 415);
  const reader = request.body?.getReader();
  requireThat(reader, '请求体为空。');
  const parts = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 65536) { await reader.cancel(); throw new AppError('请求体不能超过 64 KB。', 413); }
    parts.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); requireThat(value && typeof value === 'object' && !Array.isArray(value), '请求体必须是对象。'); return value; }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('JSON 格式不正确。'); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (request.headers.get('Origin') !== url.origin) return json({ error: { code: 'CSRF', message: '跨站请求被拒绝，请从面板页面操作。' } }, 403, security);
    }
    const stub = env.CONTROL.get(env.CONTROL.idFromName('cloudlane-control-v1'));
    const response = await stub.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(security)) headers.set(key, value);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
};

export class ControlPlane {
  constructor(state, env) { this.state = state; this.env = env; this.queue = Promise.resolve(); }
  lock(fn) { const result = this.queue.then(fn, fn); this.queue = result.catch(() => {}); return result; }
  get(key) { return this.state.storage.get(key); }
  put(key, value) { return this.state.storage.put(key, value); }
  del(key) { return this.state.storage.delete(key); }
  async list(prefix) { return [...(await this.state.storage.list({ prefix })).values()]; }
  async client(credentialId) {
    const credential = await this.get(`credential:${credentialId}`);
    requireThat(credential, 'API 凭据不存在或已删除。', 404, 'CREDENTIAL_MISSING');
    return new Cloudflare(await unseal(credential.secret, this.env.ENCRYPTION_KEY, credential.id), this.env.CF_FETCH || null);
  }
  async audit(action, detail, jobId = null) {
    const event = { id: id(), at: now(), action, detail, jobId };
    await this.put(`audit:${String(event.at).padStart(16, '0')}:${event.id}`, event);
    // Keep a bounded operational log. Job journals are retained separately for explicit rollback.
    const keys = [...(await this.state.storage.list({ prefix: 'audit:' })).keys()];
    if (keys.length > 300) await this.state.storage.delete(keys.slice(0, keys.length - 300));
  }
  async ensureIdle(routeId, tid) {
    const jobs = await this.list('job:');
    requireThat(!jobs.some(j => active(j) && j.plan.routeId === routeId), '这条记录已有执行中的任务，请等待或暂停该任务。', 409, 'JOB_BUSY');
    requireThat(!jobs.some(j => active(j) && j.plan.profile?.tunnelId === tid && j.actions.some(a => a.kind === 'tunnel' && a.state !== 'done')), '这个 Tunnel 有待提交的配置变更，请稍后重试。', 409, 'TUNNEL_BUSY');
  }
  fetch(request) {
    return this.lock(async () => {
      try { return await this.handle(request); }
      catch (error) { return json({ error: safeError(error) }, error instanceof AppError ? error.status : 500); }
    });
  }
  async authenticated(request) {
    const name = cookieName(request);
    const value = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
    if (!value || !/^[a-f0-9-]{36}\.[a-f0-9-]{36}$/.test(value)) return null;
    const key = `session:${await digest(value)}`, session = await this.get(key);
    if (!session || session.expiresAt < now() || session.passwordVersion !== await digest(this.env.ADMIN_PASSWORD || '')) return null;
    return key;
  }
  async handle(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (path === '/api/bootstrap' && method === 'GET') {
      let setupError = null;
      try { await validateSecrets(this.env); } catch (e) { setupError = e.message; }
      return json({ configured: !setupError, setupError, authenticated: !!(await this.authenticated(request)), version: '0.2.2' });
    }
    if (path === '/api/login' && method === 'POST') {
      await validateSecrets(this.env);
      const ip = await digest(request.headers.get('CF-Connecting-IP') || 'local');
      const key = `rate:${ip}`, old = await this.get(key);
      const rate = old?.until > now() ? old : { count: 0, until: now() + 900000 };
      requireThat(rate.count < 8, '登录尝试过多，请 15 分钟后重试。', 429, 'LOGIN_RATE_LIMIT');
      const input = await bodyOf(request);
      rate.count++; await this.put(key, rate);
      requireThat(typeof input.password === 'string' && input.password.length <= 1024 && await constantTimeEqual(input.password, this.env.ADMIN_PASSWORD), '管理员密码不正确。', 401, 'LOGIN_FAILED');
      await this.del(key);
      const token = `${id()}.${id()}`;
      await this.put(`session:${await digest(token)}`, { expiresAt: now() + 43200000, passwordVersion: await digest(this.env.ADMIN_PASSWORD) });
      await this.audit('登录面板', '管理员会话有效期 12 小时');
      await this.arm();
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, token, 43200) });
    }
    const sessionKey = await this.authenticated(request);
    requireThat(sessionKey, '请先登录管理面板。', 401, 'AUTH_REQUIRED');
    if (path === '/api/logout' && method === 'POST') { await this.del(sessionKey); return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) }); }
    await validateSecrets(this.env);
    if (path === '/api/state' && method === 'GET') {
      const [credentials, profiles, routes, jobs, events, discoveries] = await Promise.all(['credential:', 'profile:', 'route:', 'job:', 'audit:', 'discovery:'].map(x => this.list(x)));
      return json({
        credentials: credentials.map(({ secret, ...safe }) => safe), profiles, routes,
        discoveries,
        jobs: jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(j => this.publicJob(j)),
        events: events.sort((a, b) => b.at - a.at).slice(0, 100), serverTime: now()
      });
    }
    if (path === '/api/export' && method === 'GET') {
      return json({ format: 'cloudlane-config', version: 1, exportedAt: new Date().toISOString(), credentials: (await this.list('credential:')).map(({ secret, ...meta }) => meta), profiles: await this.list('profile:'), routes: (await this.list('route:')).map(({ observed, ...r }) => r) });
    }
    if (path === '/api/credentials' && method === 'POST') {
      const input = await bodyOf(request);
      return json(await this.saveCredential(input), 201);
    }
    let match;
    if ((match = path.match(/^\/api\/credentials\/([^/]+)\/catalog$/)) && method === 'GET') {
      const credential = await this.get(`credential:${match[1]}`);
      requireThat(credential, '凭据不存在。', 404);
      const client = await this.client(credential.id);
      const zones = await client.list('/zones', { 'account.id': credential.accountId });
      let tunnels = [], warning = null;
      try { tunnels = await client.list(`/accounts/${credential.accountId}/cfd_tunnel`, { is_deleted: 'false' }); } catch (e) { warning = e.message; }
      return json({ zones: zones.map(z => ({ id: z.id, name: z.name, status: z.status, account: z.account })), tunnels: tunnels.map(t => ({ id: t.id, name: t.name, status: t.status, remote_config: t.remote_config || t.config_src === 'cloudflare' })), warning });
    }
    if ((match = path.match(/^\/api\/credentials\/([^/]+)$/))) {
      if (method === 'PUT') return json(await this.saveCredential(await bodyOf(request), match[1]));
      if (method === 'DELETE') {
        requireThat(!(await this.list('profile:')).some(p => p.sourceCredentialId === match[1] || p.publicCredentialId === match[1]), '这套凭据仍被配置方案引用，不能删除。', 409);
        requireThat(!(await this.list('job:')).some(j => active(j) && j.actions.some(a => a.credentialId === match[1])), '凭据仍被任务引用。', 409);
        await this.del(`credential:${match[1]}`); await this.audit('删除 API 凭据', match[1]); return json({ ok: true });
      }
    }
    if (path === '/api/profiles' && method === 'POST') return json(await this.saveProfile(await bodyOf(request)), 201);
    if ((match = path.match(/^\/api\/profiles\/([^/]+)$/))) {
      if (method === 'PUT') return json(await this.saveProfile(await bodyOf(request), match[1]));
      if (method === 'DELETE') {
        requireThat(!(await this.list('route:')).some(r => r.profileId === match[1]), '仍有记录使用此配置方案，不能删除。', 409);
        requireThat(!(await this.list('job:')).some(j => active(j) && j.plan.profile?.id === match[1]), '仍有任务使用此配置方案。', 409);
        await this.del(`profile:${match[1]}`); await this.audit('删除配置方案', match[1]); return json({ ok: true });
      }
    }
    if ((match = path.match(/^\/api\/profiles\/([^/]+)\/sync$/)) && method === 'POST') {
      const profile = await this.get(`profile:${match[1]}`); requireThat(profile, '方案不存在。', 404);
      const last = await this.get(`sync-rate:${profile.id}`);
      if (last && now() - last <= 3000) return json({ profileId: profile.id, checkedAt: last, throttled: true });
      await this.put(`sync-rate:${profile.id}`, now());
      return json(await syncProfileRoutes(this, profile));
    }
    if ((match = path.match(/^\/api\/profiles\/([^/]+)\/discover$/)) && method === 'POST') {
      const profile = await this.get(`profile:${match[1]}`); requireThat(profile, '方案不存在。', 404);
      return json({ candidates: await discoverRoutes(this, profile) });
    }
    if ((match = path.match(/^\/api\/profiles\/([^/]+)\/import$/)) && method === 'POST') {
      const profile = await this.get(`profile:${match[1]}`); requireThat(profile, '方案不存在。', 404);
      const input = await bodyOf(request);
      requireThat(Array.isArray(input.hostnames) && input.hostnames.length > 0 && input.hostnames.length <= 100, '每次选择 1–100 条记录。');
      const candidates = await discoverRoutes(this, profile), imported = [];
      // Re-scan server-side rather than trusting client-supplied service URLs or resource IDs.
      const selected = [...new Set(input.hostnames)].map(h => candidates.find(c => c.publicHostname === h && c.importable));
      requireThat(selected.every(Boolean), '部分记录已变化或不再可导入，请重新扫描。', 409, 'IMPORT_STALE');
      for (const candidate of selected) {
        const { errors, importable, hostnameStatus, sslStatus, ...spec } = candidate;
        const route = { ...spec, id: id(), createdAt: now(), imported: true, maintenanceEnabled: false, observed: null, nextCheckAt: now() + 1000 };
        await this.put(`route:${route.id}`, route); imported.push(route);
      }
      await this.audit('导入现有记录', `只登记 ${imported.length} 条记录，没有修改 Cloudflare 配置`); await this.arm();
      return json({ imported });
    }
    if ((match = path.match(/^\/api\/profiles\/([^/]+)\/edge-plan$/)) && method === 'POST') {
      const profile = await this.get(`profile:${match[1]}`); requireThat(profile, '方案不存在。', 404);
      const input = await bodyOf(request), target = hostname(input.target);
      requireThat(target !== profile.edgeHostname, '入口不能 CNAME 到自身。');
      const routes = await this.list('route:');
      requireThat(!routes.some(r => [r.originHostname, r.publicHostname].includes(target)), '入口不能指向已管理的源域名或访问域名。', 409, 'DNS_LOOP');
      if (inZone(target, profile.sourceZone.name)) await checkEdge(this, profile, target, { originHostname: profile.edgeHostname, publicHostname: profile.edgeHostname });
      const action = await planDNS(this, { credentialId: profile.sourceCredentialId, zoneId: profile.sourceZone.id, name: profile.edgeHostname, content: target, routeId: `edge-${profile.id}`, role: 'edge', allowChange: true });
      requireThat(action, '入口 DNS 已经是目标配置，无需更改。', 409, 'NO_CHANGES');
      const count = routes.filter(r => r.edgeHostname === profile.edgeHostname).length;
      const plan = { id: id(), type: 'edge', createdAt: now(), expiresAt: now() + 600000, routeId: `edge:${profile.id}`, profile, spec: { name: '修改共享优选入口', publicHostname: profile.edgeHostname, edgeTarget: target }, previous: null, actions: [action], warnings: [`此入口在本面板被 ${count} 条记录使用，Cloudflare 中还可能存在未导入的使用者；会一起切换，不是只修改单条记录。`], jobId: null };
      await this.put(`plan:${plan.id}`, plan); return json(plan);
    }
    if (path === '/api/plans' && method === 'POST') {
      const input = await bodyOf(request), plan = await buildRoutePlan(this, input, input.routeId);
      requireThat(new TextEncoder().encode(JSON.stringify(plan)).length < 500000, 'Tunnel 配置过大，超过此面板 500 KB 预览安全限制；未写入云端。', 413);
      await this.put(`plan:${plan.id}`, plan); return json(plan);
    }
    if ((match = path.match(/^\/api\/plans\/([^/]+)\/apply$/)) && method === 'POST') {
      const plan = await this.get(`plan:${match[1]}`); requireThat(plan, '预览已过期，请重新生成。', 404);
      if (plan.jobId) return json(this.publicJob(await this.get(`job:${plan.jobId}`))); // idempotent double-click/retry
      requireThat(plan.expiresAt > now(), '预览已超过 10 分钟，请重新生成。', 409, 'PLAN_EXPIRED');
      const input = await bodyOf(request);
      requireThat(input.acknowledge === true, '请先确认已检查变更与影响范围。');
      if (plan.type === 'delete') requireThat(input.confirmHostname === plan.spec.publicHostname, '删除云端资源时，请输入完整访问域名确认。');
      await this.ensureIdle(plan.routeId, plan.profile.tunnelId);
      // Reject stale profiles and targets before the first write; every action also rechecks immediately before mutation.
      const liveProfile = await this.get(`profile:${plan.profile.id}`);
      requireThat(equal(liveProfile, plan.profile), '配置方案已更改，请重新预览。', 409, 'STALE_PLAN');
      if (plan.type === 'route' || plan.type === 'delete') {
        const currentRoute = await this.get(`route:${plan.routeId}`);
        requireThat(equal(currentRoute, plan.previous), '此记录在预览后已变化，请重新预览。', 409, 'STALE_PLAN');
        if (plan.type === 'route') requireThat(!(await this.list('route:')).some(r => r.id !== plan.routeId && (r.publicHostname === plan.spec.publicHostname || r.originHostname === plan.spec.originHostname)), '域名已被另一条记录接管，请重新加载。', 409, 'DUPLICATE_ROUTE');
      }
      if (plan.type === 'rollback') requireThat(equal(await this.get(`route:${plan.routeId}`), plan.previous), '记录在撤销预览后已变化，请重新预览。', 409, 'STALE_PLAN');
      const jobs = await this.list('job:');
      requireThat(jobs.filter(j => active(j)).length < 30, '正在执行的任务超过 30 个，请等待部分任务完成。', 429);
      for (const action of plan.actions) requireThat(equal(await readResource(this, action), action.before), `${action.label} 自预览后发生变化，未执行任何写入。`, 409, 'STALE_PLAN');
      const job = { id: id(), plan: clone(plan), actions: clone(plan.actions), status: 'queued', createdAt: now(), updatedAt: now(), nextAt: now() + 1000, deadline: now() + 86400000, polls: 0, retries: 0, step: '等待执行', error: null };
      plan.jobId = job.id;
      await this.state.storage.transaction(async txn => {
        await txn.put(`plan:${plan.id}`, plan); await txn.put(`job:${job.id}`, job);
        if (plan.type === 'route') await txn.put(`route:${plan.routeId}`, { ...plan.previous, ...plan.spec, id: plan.routeId, createdAt: plan.previous?.createdAt || now(), pendingJobId: job.id, lastJobId: job.id, maintenanceEnabled: false, observed: plan.previous?.observed || null });
        if (plan.type === 'delete') await txn.put(`route:${plan.routeId}`, { ...plan.previous, pendingJobId: job.id, lastJobId: job.id });
        if (plan.type === 'rollback' && plan.previous) await txn.put(`route:${plan.routeId}`, { ...plan.previous, pendingJobId: job.id, lastJobId: job.id });
      });
      await this.audit('提交变更任务', `${plan.spec.publicHostname} · ${plan.actions.length} 个已知变更`, job.id); await this.arm();
      return json(this.publicJob(job), 202);
    }
    if ((match = path.match(/^\/api\/jobs\/([^/]+)$/)) && method === 'GET') {
      const job = await this.get(`job:${match[1]}`); requireThat(job, '任务不存在。', 404); return json({ ...this.publicJob(job), actions: job.actions, warnings: job.plan.warnings });
    }
    if ((match = path.match(/^\/api\/jobs\/([^/]+)\/(retry|pause|rollback-plan)$/)) && method === 'POST') {
      const job = await this.get(`job:${match[1]}`); requireThat(job, '任务不存在。', 404);
      if (match[2] === 'rollback-plan') { const plan = await buildRollbackPlan(this, job); await this.put(`plan:${plan.id}`, plan); return json(plan); }
      if (match[2] === 'pause') { requireThat(active(job), '任务已停止。', 409); job.status = 'paused'; job.step = '已暂停，已完成的云端变更保留'; }
      else {
        requireThat(['failed', 'paused'].includes(job.status), '该任务不需要恢复。', 409);
        if (['route', 'renewal'].includes(job.plan.type)) requireThat(await this.get(`route:${job.plan.routeId}`), '记录已解除管理，不能恢复旧任务。', 409, 'ROUTE_DETACHED');
        const latest = (await this.list('job:')).filter(j => j.plan.routeId === job.plan.routeId).sort((a, b) => b.createdAt - a.createdAt)[0];
        requireThat(latest?.id === job.id, '已有更新任务，不能恢复旧任务。', 409, 'NEWER_JOB');
        await this.ensureIdle(job.plan.routeId, job.plan.profile.tunnelId);
        job.status = 'queued'; job.error = null; job.nextAt = now() + 1000; job.deadline = now() + 86400000; job.retries = 0;
      }
      job.updatedAt = now(); await this.put(`job:${job.id}`, job); await this.audit(match[2] === 'pause' ? '暂停任务' : '恢复任务', job.plan.spec.publicHostname, job.id); await this.arm(); return json(this.publicJob(job));
    }
    if ((match = path.match(/^\/api\/routes\/([^/]+)\/delete-plan$/)) && method === 'POST') {
      const plan = await buildDeletePlan(this, match[1]);
      requireThat(new TextEncoder().encode(JSON.stringify(plan)).length < 500000, '删除预览过大，未执行任何写入。', 413);
      await this.put(`plan:${plan.id}`, plan);
      return json(plan);
    }
    if ((match = path.match(/^\/api\/routes\/([^/]+)\/sync$/)) && method === 'POST') {
      const route = await this.get(`route:${match[1]}`); requireThat(route, '记录不存在。', 404);
      const profile = await this.get(`profile:${route.profileId}`); requireThat(profile, '配置方案不存在。', 404);
      await syncProfileRoutes(this, profile);
      return json(await this.get(`route:${route.id}`));
    }
    if ((match = path.match(/^\/api\/routes\/([^/]+)$/)) && method === 'DELETE') {
      const route = await this.get(`route:${match[1]}`); requireThat(route, '记录不存在。', 404);
      const input = await bodyOf(request); requireThat(input.confirmHostname === route.publicHostname, '请填写完整访问域名确认。');
      requireThat(!(await this.list('job:')).some(j => active(j) && j.plan.routeId === route.id), '先暂停或完成该记录的任务。', 409);
      await this.del(`route:${route.id}`); await this.audit('解除面板管理', `${route.publicHostname}，Cloudflare 中的资源完整保留`); return json({ ok: true });
    }
    throw new AppError('API 路径不存在。', 404, 'NOT_FOUND');
  }
  async saveCredential(input, credentialId = undefined) {
    const previous = credentialId ? await this.get(`credential:${credentialId}`) : null;
    requireThat(!credentialId || previous, '凭据不存在。', 404);
    const accountId = cfId(input.accountId, '账户 ID'), label = text(input.label, '凭据名称', 80);
    requireThat(!previous || previous.accountId === accountId, '轮换 Token 时不能改变账户 ID；另一账户请新增凭据。', 409);
    const cid = credentialId || id();
    let secret = previous?.secret;
    if (input.token) {
      const token = text(input.token, 'API Token', 512);
      requireThat(!/\s/.test(token), 'API Token 不能包含空格或换行。');
      const client = new Cloudflare(token, this.env.CF_FETCH || null);
      const zones = await client.list('/zones', { 'account.id': accountId });
      requireThat(zones.length > 0, 'Token 不能读取此账户的 Zone，请核对账户 ID、Zone Read 权限和资源范围。', 403, 'TOKEN_SCOPE');
      secret = await seal(token, this.env.ENCRYPTION_KEY, cid);
    }
    requireThat(secret, '请输入 API Token。');
    const credential = { id: cid, label, accountId, secret, createdAt: previous?.createdAt || now(), updatedAt: now() };
    await this.put(`credential:${cid}`, credential); await this.audit(previous ? '更新 API 凭据' : '新增 API 凭据', label);
    const { secret: omitted, ...safe } = credential; return safe;
  }
  async saveProfile(input, profileId = undefined) {
    const previous = profileId ? await this.get(`profile:${profileId}`) : null;
    requireThat(!profileId || previous, '方案不存在。', 404);
    const sourceCred = await this.get(`credential:${input.sourceCredentialId}`), publicCred = await this.get(`credential:${input.publicCredentialId}`);
    requireThat(sourceCred && publicCred, '请先添加源账户和访问域名账户的 API 凭据。');
    const src = await this.client(sourceCred.id), dst = await this.client(publicCred.id);
    const [sourceZone, publicZone] = await Promise.all([src.get(`/zones/${cfId(input.sourceZoneId, '源 Zone ID')}`), dst.get(`/zones/${cfId(input.publicZoneId, '访问 Zone ID')}`)]);
    requireThat(sourceZone.account?.id === sourceCred.accountId && publicZone.account?.id === publicCred.accountId, 'Zone 与所选凭据的账户不匹配。', 409);
    const edgeHostname = hostname(input.edgeHostname);
    requireThat(edgeHostname !== sourceZone.name && inZone(edgeHostname, sourceZone.name), '优选入口必须是源 Zone 下的子域名。');
    const profile = { id: profileId || id(), name: text(input.name, '方案名称', 80), sourceCredentialId: sourceCred.id, publicCredentialId: publicCred.id, accountId: sourceCred.accountId, sourceZone: { id: sourceZone.id, name: sourceZone.name }, publicZone: { id: publicZone.id, name: publicZone.name }, tunnelId: tunnelId(input.tunnelId), edgeHostname, edgeTarget: input.edgeTarget ? hostname(input.edgeTarget) : '', validationMode: ['auto', 'delegated', 'txt'].includes(input.validationMode) ? input.validationMode : 'auto', initializeFallback: input.initializeFallback === true, createdAt: previous?.createdAt || now() };
    requireThat(profile.sourceZone.id !== profile.publicZone.id, '本版本使用独立的源 Zone 与访问 Zone，请分别选择两个 Zone。');
    requireThat(profile.edgeTarget !== profile.edgeHostname, '入口不能 CNAME 到自己。');
    if (previous && (await this.list('route:')).some(r => r.profileId === profile.id)) {
      for (const field of ['sourceCredentialId', 'publicCredentialId', 'accountId', 'sourceZone', 'publicZone', 'tunnelId']) requireThat(equal(previous[field], profile[field]), '方案已被记录使用：不能原地更换账户、Zone 或 Tunnel。迁移时请新建方案。', 409, 'PROFILE_IN_USE');
    }
    requireThat(!(await this.list('job:')).some(j => active(j) && j.plan.profile?.id === profile.id), '方案仍有执行中的任务，暂不能修改。', 409, 'PROFILE_BUSY');
    const live = await validateProfileLive(this, profile); profile.tunnelName = live.tunnel.name;
    await this.put(`profile:${profile.id}`, profile); await this.audit(previous ? '更新配置方案' : '新增配置方案', profile.name); return profile;
  }
  publicJob(job) {
    return { id: job.id, type: job.plan.type, routeId: job.plan.routeId, hostname: job.plan.spec.publicHostname, name: job.plan.spec.name, status: job.status, step: job.step, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt, nextAt: job.nextAt, completed: job.actions.filter(a => a.state === 'done').length, total: job.actions.length };
  }
  async arm() {
    const jobs = (await this.list('job:')).filter(active);
    const routes = await this.list('route:');
    const maintenance = routes.filter(r => !r.pendingJobId).map(r => r.nextCheckAt || now() + 1000);
    const next = Math.min(now() + 21600000, ...jobs.map(j => j.nextAt), ...maintenance);
    await this.state.storage.setAlarm(Math.max(now() + 1000, next));
  }
  alarm() {
    return this.lock(async () => {
      try {
        const job = (await this.list('job:')).filter(j => active(j) && j.nextAt <= now() + 100).sort((a, b) => a.nextAt - b.nextAt)[0];
        if (job) await this.advance(job);
        else await this.maintain();
      } finally { await this.arm(); }
    });
  }
  async advance(job) {
    const persist = async () => { job.updatedAt = now(); await this.put(`job:${job.id}`, job); };
    try {
      requireThat(now() < job.deadline, '等待超过 24 小时，已暂停。查看证书验证错误、CAA/DNSSEC/Zone hold，再恢复任务。', 409, 'WAIT_TIMEOUT');
      job.status = 'running'; job.error = null;
      let action = job.actions.find(a => a.state !== 'done' && a.phase !== 'cutover');
      if (action) {
        job.step = action.label; await applyAction(this, action, persist);
        job.retries = 0; job.nextAt = now() + 1000; await persist(); return;
      }
      if (['edge', 'rollback', 'delete'].includes(job.plan.type)) { await this.finish(job); return; }
      const validation = await validationActions(this, job);
      if (validation.actions.length) {
        job.actions.push(...validation.actions); job.step = '写入 Cloudflare 生成的验证记录'; job.nextAt = now() + 1000; await persist(); return;
      }
      const custom = validation.custom;
      requireThat(!['blocked', 'moved', 'deleted', 'pending_blocked'].includes(custom.status), `主机名验证已停止（${custom.status}）。${(custom.verification_errors || []).join('；')} 处理 CAA、Zone hold 或 DNS 问题后，编辑记录并勾选「重新触发 SaaS 验证」。`, 409, 'VALIDATION_STOPPED');
      const hostnameReady = custom.status === 'active';
      const fallback = await (await this.client(job.plan.profile.sourceCredentialId)).get(`/zones/${job.plan.profile.sourceZone.id}/custom_hostnames/fallback_origin`);
      // SSL pending_validation is non-blocking by design. The normal mode waits for the SaaS
      // hostname itself and fallback origin, but does not hold traffic DNS for certificate status.
      const canCutover = fallback?.status === 'active' && (hostnameReady || job.plan.spec.cutover === 'immediate');
      action = job.actions.find(a => a.phase === 'cutover' && a.state !== 'done');
      if (action && canCutover) {
        const inspected = await observe(this, { ...job.plan.spec, pendingJobId: job.id }, job.plan.profile);
        requireThat(!inspected.drift.length, `切换前检测到配置变化：${inspected.drift.join('；')}`, 409, 'CUTOVER_DRIFT');
        job.step = '切换访问域名到优选入口'; await applyAction(this, action, persist); job.nextAt = now() + 1000; await persist(); return;
      }
      if (hostnameReady && fallback?.status === 'active' && !action) { await this.finish(job); return; }
      job.polls++; job.status = 'waiting'; job.step = `等待验证 · 主机名 ${custom.status || 'pending'} / SSL ${custom.ssl?.status || 'pending'} / 备用源 ${fallback?.status || 'pending'}`;
      job.nextAt = now() + Math.min(900000, 15000 * 2 ** Math.min(job.polls, 6));
      if (custom.ssl?.validation_errors?.length) job.error = { code: 'VALIDATION_PENDING', message: custom.ssl.validation_errors.map(e => e.message).join('；') };
      await persist();
    } catch (error) {
      job.error = safeError(error); job.retries++;
      if (['CF_NETWORK', 'CF_RESPONSE', 'CF_RATE_LIMIT'].includes(error.code) && job.retries <= 6) {
        job.status = 'retrying'; job.step = 'API 暂不可用，稍后先核对远端状态再恢复';
        job.nextAt = now() + (error.details?.retryAfter || Math.min(300, 10 * 2 ** job.retries)) * 1000;
      } else { job.status = error.code === 'WAIT_TIMEOUT' ? 'paused' : 'failed'; job.step = '任务已停止，已完成的变更保留'; await this.audit('任务停止', error instanceof AppError ? error.message : '内部错误', job.id); }
      await persist();
    }
  }
  async finish(job) {
    const plan = job.plan;
    if (plan.type === 'delete') {
      await this.del(`route:${plan.routeId}`);
      await this.del(`discovery:${plan.profile.id}`);
    } else if (plan.type === 'rollback') {
      if (plan.restoreRoute) await this.put(`route:${plan.routeId}`, { ...plan.restoreRoute, pendingJobId: null, observed: null, nextCheckAt: now() + 1000 });
      else await this.del(`route:${plan.routeId}`);
      const original = await this.get(`job:${plan.originalJobId}`);
      if (original) {
        if (original.plan.type === 'edge') {
          const profile = await this.get(`profile:${plan.profile.id}`);
          if (profile) { profile.edgeTarget = original.plan.profile.edgeTarget; await this.put(`profile:${profile.id}`, profile); }
          for (const route of await this.list('route:')) if (route.edgeHostname === plan.profile.edgeHostname) { route.nextCheckAt = now() + 1000; await this.put(`route:${route.id}`, route); }
        }
        original.status = 'rolled_back'; original.updatedAt = now(); await this.put(`job:${original.id}`, original);
      }
    } else if (plan.type === 'edge') {
      const profile = await this.get(`profile:${plan.profile.id}`);
      if (profile) { profile.edgeTarget = plan.spec.edgeTarget; await this.put(`profile:${profile.id}`, profile); }
      for (const route of await this.list('route:')) if (route.edgeHostname === plan.profile.edgeHostname) { route.nextCheckAt = now() + 1000; await this.put(`route:${route.id}`, route); }
    } else {
      const route = await this.get(`route:${plan.routeId}`);
      if (route) {
        route.pendingJobId = null; route.lastJobId = job.id; route.dcvSuffix = plan.dcvSuffix; route.maintenanceEnabled = true; route.updatedAt = now(); route.nextCheckAt = now() + 21600000;
        try { route.observed = await observe(this, route, plan.profile); } catch (e) { route.observed = { checkedAt: now(), status: 'error', error: e.message }; }
        await this.put(`route:${route.id}`, route);
      }
    }
    job.status = 'done'; job.error = null; job.step = '已完成'; job.updatedAt = now(); await this.put(`job:${job.id}`, job); await this.audit('任务完成', plan.spec.publicHostname, job.id);
  }
  async maintain() {
    // Each alarm handles one route; it does not fan out unbounded requests against Cloudflare.
    const route = (await this.list('route:')).filter(r => !r.pendingJobId && (!r.nextCheckAt || r.nextCheckAt <= now())).sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0))[0];
    if (route) {
      const profile = await this.get(`profile:${route.profileId}`);
      try {
        route.observed = await observe(this, route, profile);
        if (route.maintenanceEnabled && !route.observed.drift.length && (route.observed.hostnameStatus !== 'active' || route.observed.sslStatus !== 'active')) {
          const plan = { id: id(), type: 'renewal', routeId: route.id, profile: clone(profile), spec: clone(route), previous: clone(route), actions: [], warnings: ['仅维护已授权的确切验证名称，不改变流量 DNS。'], dcvSuffix: route.dcvSuffix || null };
          const job = { id: id(), plan, actions: [], status: 'queued', createdAt: now(), updatedAt: now(), nextAt: now() + 1000, deadline: now() + 86400000, polls: 0, retries: 0, step: '维护证书验证', error: null };
          route.pendingJobId = job.id; route.lastJobId = job.id; await this.put(`job:${job.id}`, job); await this.audit('证书验证维护', route.publicHostname, job.id);
        }
      } catch (error) { route.observed = { ...route.observed, checkedAt: now(), status: 'error', error: error instanceof AppError ? error.message : '检查未完成' }; }
      route.nextCheckAt = now() + 21600000; await this.put(`route:${route.id}`, route);
    }
    for (const prefix of ['session:', 'rate:', 'plan:']) {
      const records = await this.state.storage.list({ prefix });
      for (const [key, record] of records) if ((record.expiresAt || record.until || Infinity) < now() && !record.jobId) await this.del(key);
    }
  }
}