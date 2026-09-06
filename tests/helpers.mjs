import Worker, { ControlPlane } from '../worker/index.mjs';
import { seal } from '../worker/core.mjs';
export const A = 'a'.repeat(32), B = 'b'.repeat(32), Z1 = '1'.repeat(32), Z2 = '2'.repeat(32), T = '00000000-0000-4000-8000-000000000001';
export const PASSWORD = 'a-very-long-test-password-123';
export const KEY = Buffer.alloc(32, 123).toString('base64');
export const spec = { profileId: 'profile-1', name: 'Image', originHostname: 'image.a.example', publicHostname: 'image.b.example', edgeHostname: 'speed.a.example', service: 'http://localhost:1111', cutover: 'when_ready' };
export const profile = { id: 'profile-1', name: 'Everyday', sourceCredentialId: 'cred-1', publicCredentialId: 'cred-2', accountId: A, sourceZone: { id: Z1, name: 'a.example' }, publicZone: { id: Z2, name: 'b.example' }, tunnelId: T, tunnelName: 'test-origin', edgeHostname: 'speed.a.example', edgeTarget: 'preferred.example.net', validationMode: 'auto', initializeFallback: false };
const copy = x => structuredClone(x);
export class MemoryStorage {
  constructor() { this.data = new Map(); this.alarm = null; }
  async get(key) { return copy(this.data.get(key)); }
  async put(key, value) { this.data.set(key, copy(value)); }
  async delete(keys) { if (Array.isArray(keys)) return keys.map(k => this.data.delete(k)).filter(Boolean).length; return this.data.delete(keys); }
  async list({ prefix = '' } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, copy(v)])); }
  async transaction(fn) { const before = copy(this.data); try { return await fn(this); } catch (e) { this.data = before; throw e; } }
  async setAlarm(value) { this.alarm = value; }
}
export class MockCloudflare {
  constructor() {
    this.zones = [{ id: Z1, name: 'a.example', status: 'active', account: { id: A } }, { id: Z2, name: 'b.example', status: 'active', account: { id: B } }];
    this.tunnel = { id: T, name: 'test-origin', status: 'healthy', remote_config: true };
    this.config = { ingress: [{ hostname: 'untouched.a.example', service: 'http://localhost:9000', originRequest: { httpHostHeader: 'private.local' } }, { service: 'http_status:404' }], originRequest: { connectTimeout: 30 }, 'warp-routing': { enabled: true } };
    this.dns = new Map([[Z1, [{ id: 'edge-id', type: 'CNAME', name: 'speed.a.example', content: 'preferred.example.net', ttl: 1, proxied: false, comment: 'owned by someone else' }]], [Z2, []]]);
    this.customs = [];
    this.fallback = { origin: 'fallback.a.example', status: 'active' };
    this.uuid = 'abc123def456ghi7'; this.uuidStatus = 200; this.calls = []; this.serial = 0; this.nextCustomStatus = 'pending'; this.nextSSLStatus = 'pending_validation'; this.interrupt = null; this.quoteTXT = false;
  }
  rows(zone) { return this.dns.get(zone); }
  writes() { return this.calls.filter(c => c.method !== 'GET'); }
  ready() { for (const ch of this.customs) { ch.status = 'active'; ch.ssl.status = 'active'; } }
  result(value, list = false) { return Response.json({ success: true, result: copy(value), errors: [], ...(list ? { result_info: { total_pages: 1 } } : {}) }); }
  error(status, message) { return Response.json({ success: false, errors: [{ code: 999, message }] }, { status }); }
  fetch = async (input, init = {}) => {
    const u = new URL(input), route = u.pathname.replace('/client/v4', ''), method = init.method || 'GET';
    const data = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ path: route, query: Object.fromEntries(u.searchParams), method, data });
    if (this.fail && this.fail(route, method)) return this.error(403, 'Missing permission');
    let response;
    if (route === '/zones') response = this.result(this.zones.filter(z => !u.searchParams.get('account.id') || z.account.id === u.searchParams.get('account.id')), true);
    else if (/^\/zones\/[^/]+$/.test(route)) response = this.result(this.zones.find(z => z.id === route.split('/')[2]));
    else if (route.endsWith('/configurations')) { if (method === 'PUT') this.config = copy(data.config); response = this.result({ config: this.config, version: 10 }); }
    else if (route.includes('/cfd_tunnel/')) response = this.result(this.tunnel);
    else if (route.endsWith('/cfd_tunnel')) response = this.result([this.tunnel], true);
    else if (route.endsWith('/dcv_delegation/uuid')) response = this.uuidStatus === 200 ? this.result({ uuid: this.uuid }) : this.error(this.uuidStatus, 'DCV unavailable');
    else if (route.endsWith('/fallback_origin')) {
      if (method === 'PUT') this.fallback = { ...data, status: 'active' };
      else if (method === 'DELETE') this.fallback = null;
      response = this.fallback ? this.result(this.fallback) : this.error(404, 'No fallback configured');
    } else if (route.includes('/dns_records')) {
      const bits = route.split('/'), zone = bits[2], rid = bits[4], rows = this.rows(zone);
      if (method === 'GET') response = this.result(rows.filter(r => !u.searchParams.get('name') || r.name === u.searchParams.get('name')), true);
      else if (method === 'POST') {
        const row = { id: `dns-${++this.serial}`, ...copy(data), ...(data.type === 'TXT' && this.quoteTXT ? { content: `"${data.content}"` } : {}) }; rows.push(row); response = this.result(row);
      } else if (method === 'PATCH') { const row = rows.find(r => r.id === rid); if (!row) return this.error(404, 'DNS missing'); Object.assign(row, data); response = this.result(row); }
      else if (method === 'DELETE') { this.dns.set(zone, rows.filter(r => r.id !== rid)); response = this.result({ id: rid }); }
    } else if (route.includes('/custom_hostnames')) {
      const rid = route.split('/')[4];
      if (method === 'GET') response = this.result(this.customs.filter(c => !u.searchParams.get('hostname') || c.hostname === u.searchParams.get('hostname')), true);
      else if (method === 'POST') {
        const row = { ...copy(data), id: `ch-${++this.serial}`, status: this.nextCustomStatus, ssl: { ...copy(data.ssl), status: this.nextSSLStatus, validation_records: [{ txt_name: `_acme-challenge.${data.hostname}`, txt_value: `dcv-${data.hostname}` }], custom_key: 'NEVER-STORE-THIS-PRIVATE-KEY' }, ownership_verification: { type: 'txt', name: `_cf-custom-hostname.${data.hostname}`, value: `owner-${data.hostname}` } }; this.customs.push(row); response = this.result(row);
      } else if (method === 'PATCH') { const row = this.customs.find(c => c.id === rid); const ssl = data.ssl ? { ...row.ssl, ...data.ssl } : row.ssl; Object.assign(row, data, { ssl }); response = this.result(row); }
      else if (method === 'DELETE') { this.customs = this.customs.filter(c => c.id !== rid); response = this.result({ id: rid }); }
    }
    if (!response) throw new Error(`Unmocked API ${method} ${route}`);
    if (this.interrupt?.(route, method)) { this.interrupt = null; throw new Error('Network interrupted after commit'); }
    return response;
  };
}
export async function fixture(overrides = {}) {
  const storage = new MemoryStorage(), cf = new MockCloudflare();
  const env = { ADMIN_PASSWORD: PASSWORD, ENCRYPTION_KEY: KEY, CF_FETCH: cf.fetch, ...overrides };
  const controller = new ControlPlane({ storage }, env);
  env.CONTROL = { idFromName: x => x, get: () => controller }; env.ASSETS = { fetch: () => new Response('asset') };
  await storage.put('credential:cred-1', { id: 'cred-1', label: 'Source', accountId: A, secret: await seal('source-token', KEY, 'cred-1') });
  await storage.put('credential:cred-2', { id: 'cred-2', label: 'Public', accountId: B, secret: await seal('public-token', KEY, 'cred-2') });
  await storage.put(`profile:${profile.id}`, profile);
  let cookie = '';
  async function request(url, method = 'GET', body, headers = {}) {
    const response = await Worker.fetch(new Request(`https://cloudlane.example/api${url}`, { method, headers: { 'Origin': 'https://cloudlane.example', 'Cookie': cookie, 'CF-Connecting-IP': '192.0.2.1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }), env);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { response, body: await response.json() };
  }
  async function login() { return request('/login', 'POST', { password: PASSWORD }); }
  async function submit(input = spec) {
    const preview = await request('/plans', 'POST', input);
    if (!preview.response.ok) throw new Error(`Preview failed: ${JSON.stringify(preview.body)}`);
    const result = await request(`/plans/${preview.body.id}/apply`, 'POST', { acknowledge: true, confirmHostname: input.publicHostname });
    if (!result.response.ok) throw new Error(`Apply failed: ${JSON.stringify(result.body)}`);
    return { plan: preview.body, job: result.body };
  }
  async function advance(jobId, until = ['waiting', 'done', 'failed', 'paused'], max = 30) {
    for (let i = 0; i < max; i++) { const job = await controller.get(`job:${jobId}`); await controller.advance(job); const next = await controller.get(`job:${jobId}`); if (until.includes(next.status)) return next; }
    throw new Error('Job did not settle');
  }
  return { storage, cf, env, ctx: controller, request, login, submit, advance };
}