const stamp = Date.now();
// Offline previews can run in an opaque/about:blank context where randomUUID is unavailable.
// These identifiers never authorize real API mutations.
const demoId = () => crypto.randomUUID?.() || `demo-${Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('')}`;
const credentials = [
  { id: 'demo-credential-1', label: '个人 Cloudflare 账户', accountId: 'a'.repeat(32), createdAt: stamp },
  { id: 'demo-credential-2', label: '媒体服务账户', accountId: 'b'.repeat(32), createdAt: stamp }
];
const profiles = [
  { id: 'demo-profile-1', name: '日常服务', sourceCredentialId: credentials[0].id, publicCredentialId: credentials[0].id, accountId: credentials[0].accountId, sourceZone: { id: '1'.repeat(32), name: 'a.example' }, publicZone: { id: '2'.repeat(32), name: 'b.example' }, tunnelId: '00000000-0000-4000-8000-000000000001', tunnelName: 'netcup-origin', edgeHostname: 'speed.a.example', edgeTarget: 'preferred.example.net', validationMode: 'auto', initializeFallback: false },
  { id: 'demo-profile-2', name: '媒体与相册', sourceCredentialId: credentials[1].id, publicCredentialId: credentials[0].id, accountId: credentials[1].accountId, sourceZone: { id: '3'.repeat(32), name: 'media.example' }, publicZone: { id: '2'.repeat(32), name: 'b.example' }, tunnelId: '00000000-0000-4000-8000-000000000002', tunnelName: 'home-media', edgeHostname: 'speed.media.example', edgeTarget: 'preferred.example.net', validationMode: 'delegated', initializeFallback: false }
];
const samples = [
  ['one-mcp', 'one-mcp', 'http://localhost:24086', 0, 'ready'],
  ['Shiro Pro Checker', 'shiroprochecker', 'http://host.docker.internal:3457', 0, 'ready', 'pending_validation'],
  ['Image Gallery', 'image', 'http://localhost:63106', 0, 'ready'],
  ['Immich 相册', 'photos', 'http://localhost:2283', 1, 'ready'],
  ['Uptime Kuma', 'status', 'http://localhost:3001', 0, 'drift'],
  ['Media Library', 'library', 'http://localhost:8096', 1, 'ready']
];
export function demoState() {
  return { credentials: structuredClone(credentials), profiles: structuredClone(profiles), routes: samples.map((s, i) => ({
    id: `demo-route-${i}`, name: s[0], profileId: profiles[s[3]].id, originHostname: `${s[1]}.${profiles[s[3]].sourceZone.name}`, publicHostname: `${s[1]}.b.example`, edgeHostname: profiles[s[3]].edgeHostname, service: s[2], cutover: 'when_ready', createdAt: stamp - i * 3600000, maintenanceEnabled: true,
    remote: { syncedAt: stamp - 90000, publicHostname: `${s[1]}.b.example`, originHostname: `${s[1]}.${profiles[s[3]].sourceZone.name}`, edgeHostname: profiles[s[3]].edgeHostname, service: s[2] }, lastRemoteSyncAt: stamp - 90000,
    observed: { status: s[4], checkedAt: stamp - 90000, tunnelStatus: 'healthy', fallbackStatus: 'active', hostnameStatus: 'active', sslStatus: s[5] || 'active', dnsReady: s[4] !== 'drift', drift: s[4] === 'drift' ? ['访问域名的 DNS 被开启橙云'] : [], validationErrors: [], expiresOn: new Date(stamp + 75 * 86400000).toISOString(), originReachability: 'not_tested' }
  })), jobs: [
    { id: 'demo-job-1', routeId: 'demo-route-2', type: 'route', name: 'Image Gallery', hostname: 'image.b.example', status: 'done', step: '已完成', completed: 6, total: 6, createdAt: stamp - 3600000, updatedAt: stamp - 3400000 },
    { id: 'demo-job-2', routeId: 'demo-route-1', type: 'route', name: 'Shiro Pro Checker', hostname: 'shiroprochecker.b.example', status: 'done', step: '已完成 · SSL pending 不阻断入口', completed: 5, total: 5, createdAt: stamp - 900000, updatedAt: stamp - 90000 }
  ], discoveries: [{ profileId: 'demo-profile-1', checkedAt: stamp - 90000, candidates: [{ name: 'Notes', profileId: 'demo-profile-1', publicHostname: 'notes.b.example', originHostname: 'notes.a.example', edgeHostname: 'speed.a.example', service: 'http://localhost:5230', importable: true, errors: [], hostnameStatus: 'active', sslStatus: 'active' }] }], events: [
    { id: 'e1', at: stamp - 90000, action: '状态检查', detail: 'status.b.example 的访问 DNS 与预期不一致' },
    { id: 'e2', at: stamp - 3400000, action: '任务完成', detail: 'image.b.example 的优选配置已完成', jobId: 'demo-job-1' },
    { id: 'e3', at: stamp - 7200000, action: '导入现有记录', detail: '登记 3 条已有记录，没有修改 Cloudflare 配置' }
  ] };
}
export async function demoRequest(state, plans, path, method, body) {
  await new Promise(resolve => setTimeout(resolve, 220));
  if (path === '/state') return structuredClone(state);
  if (path === '/export') return { format: 'cloudlane-demo', ...state };
  if (path.includes('/catalog')) {
    const credential = state.credentials.find(c => path.includes(c.id));
    const ps = state.profiles.filter(p => p.sourceCredentialId === credential?.id);
    return { zones: [...ps.map(p => ({ ...p.sourceZone, status: 'active' })), { ...state.profiles[0].publicZone, status: 'active' }], tunnels: ps.map(p => ({ id: p.tunnelId, name: p.tunnelName, status: 'healthy', remote_config: true })) };
  }
  if (path === '/credentials' || (path.startsWith('/credentials/') && method === 'PUT')) {
    const item = { id: path.split('/')[2] || demoId(), label: body.label, accountId: body.accountId, createdAt: Date.now() };
    state.credentials = state.credentials.filter(x => x.id !== item.id); state.credentials.push(item); return item;
  }
  if (path === '/profiles' || (path.startsWith('/profiles/') && method === 'PUT')) {
    const catalogs = await demoRequest(state, plans, `/credentials/${body.sourceCredentialId}/catalog`, 'GET');
    const item = { ...body, id: path.split('/')[2] || demoId(), sourceZone: catalogs.zones.find(x => x.id === body.sourceZoneId) || state.profiles[0].sourceZone, publicZone: state.profiles[0].publicZone, tunnelName: catalogs.tunnels.find(x => x.id === body.tunnelId)?.name || 'demo-tunnel' };
    state.profiles = state.profiles.filter(x => x.id !== item.id); state.profiles.push(item); return item;
  }
  if (path.endsWith('/discover')) return { candidates: [{ name: 'Notes', profileId: state.profiles[0].id, publicHostname: 'notes.b.example', originHostname: 'notes.a.example', edgeHostname: 'speed.a.example', service: 'http://localhost:5230', importable: true, errors: [], hostnameStatus: 'active', sslStatus: 'active' }] };
  if (path.endsWith('/import')) {
    const route = { ...(await demoRequest(state, plans, '/profiles/demo/discover')).candidates[0], id: demoId(), observed: null, imported: true };
    if (!state.routes.some(r => r.publicHostname === route.publicHostname)) state.routes.push(route);
    return { imported: [route] };
  }
  if (path === '/plans' || path.endsWith('/edge-plan') || path.endsWith('/rollback-plan') || path.endsWith('/delete-plan')) {
    const edge = path.endsWith('/edge-plan'), rollback = path.endsWith('/rollback-plan'), deleting = path.endsWith('/delete-plan');
    const routeId = deleting ? path.split('/')[2] : body?.routeId;
    const route = deleting ? state.routes.find(r => r.id === routeId) : null;
    const profile = state.profiles.find(p => p.id === (route?.profileId || body?.profileId) || path.includes(p.id)) || state.profiles[0];
    const spec = edge ? { name: '共享入口', publicHostname: profile.edgeHostname, edgeTarget: body.target } : rollback ? { name: '撤销变更', publicHostname: 'image.b.example' } : deleting ? { ...route, ...(route?.remote || {}) } : body;
    const names = edge ? ['更新共享优选入口 CNAME'] : deleting ? ['删除访问域名 CNAME', '删除 SaaS Custom Hostname 与证书', '删除专属源域名 CNAME', '移除 2 条 Tunnel ingress（其它规则保持不变）'] : ['更新 2 条 Tunnel ingress（其它规则保持不变）', '配置源域名 Tunnel CNAME', '创建或更新 SaaS 自定义主机名', '写入 DCV 委派记录', '主机名与备用源就绪后切换访问 DNS'];
    const plan = { id: demoId(), type: edge ? 'edge' : rollback ? 'rollback' : deleting ? 'delete' : 'route', routeId: routeId || spec.routeId || demoId(), spec, profile, createdAt: Date.now(), expiresAt: Date.now() + 600000, warnings: deleting ? ['演示模式：这是云端删除预览，不会真的删除任何内容。', '共享优选入口与 SaaS Fallback Origin 会保留。'] : ['演示模式：以下是交互示例，不会请求或修改 Cloudflare。', 'SSL pending_validation 会显示，但不会阻断默认 DNS 切换。'], actions: names.map((label, i) => ({ id: `a${i}`, label, kind: i === 0 && !deleting ? 'tunnel' : deleting && i === names.length - 1 ? 'tunnel' : 'dns', state: 'pending', before: deleting ? { id: `demo-before-${i}`, value: { name: spec.publicHostname } } : null, after: deleting ? null : i === 0 ? { ingress: [{ hostname: spec.publicHostname, service: spec.service || 'http://localhost:63106' }] } : { name: spec.publicHostname, content: spec.edgeHostname || profile.edgeHostname, type: 'CNAME', proxied: i === 1 } })) };
    plans.set(plan.id, plan); return plan;
  }
  if (path.includes('/apply')) {
    const plan = plans.get(path.split('/')[2]);
    const job = { id: demoId(), type: plan.type, routeId: plan.routeId, hostname: plan.spec.publicHostname, name: plan.spec.name, status: 'done', step: '演示任务已完成（没有云端写入）', total: plan.actions.length, completed: plan.actions.length, createdAt: Date.now(), updatedAt: Date.now(), actions: plan.actions.map(a => ({ ...a, state: 'done' })) };
    state.jobs.unshift(job);
    if (plan.type === 'delete') state.routes = state.routes.filter(r => r.id !== plan.routeId);
    if (plan.type === 'route') {
      state.routes = state.routes.filter(r => r.id !== plan.routeId);
      state.routes.unshift({ ...plan.spec, id: plan.routeId, lastJobId: job.id, observed: { status: 'ready', checkedAt: Date.now(), tunnelStatus: 'healthy', fallbackStatus: 'active', hostnameStatus: 'active', sslStatus: 'active', dnsReady: true, drift: [] } });
    }
    state.events.unshift({ id: demoId(), at: Date.now(), action: '演示操作', detail: `${plan.spec.publicHostname} · 未修改云端`, jobId: job.id });
    return job;
  }
  if (path.startsWith('/jobs/')) {
    const job = state.jobs.find(j => j.id === path.split('/')[2]);
    if (!job) throw new Error('找不到演示任务。');
    if (path.endsWith('/pause')) job.status = 'paused';
    if (path.endsWith('/retry')) { job.status = 'done'; job.completed = job.total; job.step = '演示任务已完成'; }
    return { ...job, actions: job.actions || [{ label: '配置 Tunnel 规则', kind: 'tunnel', state: 'done', after: { note: '演示数据' } }], warnings: ['演示数据，不代表真实部署状态。'] };
  }
  if (path.endsWith('/sync')) {
    const itemId = path.split('/')[2];
    if (path.startsWith('/profiles/')) { for (const route of state.routes.filter(r => r.profileId === itemId)) { route.lastRemoteSyncAt = Date.now(); route.remote ||= { publicHostname: route.publicHostname, originHostname: route.originHostname, edgeHostname: route.edgeHostname, service: route.service }; route.remote.syncedAt = Date.now(); if (route.observed) route.observed.checkedAt = Date.now(); } return { profileId: itemId, checkedAt: Date.now(), routes: state.routes.filter(r => r.profileId === itemId).length, discovered: 1 }; }
    const route = state.routes.find(r => r.id === itemId);
    if (route?.observed) { route.observed.checkedAt = Date.now(); route.lastRemoteSyncAt = Date.now(); route.remote ||= { publicHostname: route.publicHostname, originHostname: route.originHostname, edgeHostname: route.edgeHostname, service: route.service }; route.remote.syncedAt = Date.now(); } return route;
  }
  if (method === 'DELETE') {
    const [_, category, itemId] = path.split('/'); state[category] = state[category].filter(x => x.id !== itemId); return { ok: true };
  }
  throw new Error('此操作不在离线演示中。真实部署后使用 Cloudflare API。');
}