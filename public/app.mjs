import { html, raw, ic, button, iconButton, badge, routeBadge, jobBadge, notice, empty, field, selectField, checked, disabled, yes, ago, date, pretty } from './ui.mjs';
import { demoState, demoRequest } from './demo.mjs';

const isDemo = window.CLOUDLANE_OFFLINE_DEMO === true || new URLSearchParams(location.search).get('demo') === '1';
const memory = isDemo ? demoState() : null;
const demoPlans = new Map();
const S = { demo: isDemo, authenticated: isDemo, configured: true, setupError: '', loading: !isDemo, page: 'routes', data: memory || { credentials: [], profiles: [], routes: [], jobs: [], events: [], discoveries: [], topology: null }, modal: null, draft: {}, error: '', busy: false, syncing: false, syncError: '', search: '', filterProfile: '', tab: 'all', catalogs: {}, candidates: [], selected: new Set(), mobileMenu: false, lastLoaded: null };
const root = document.getElementById('app');
const byId = (group, id) => S.data[group]?.find(x => x.id === id);
const profileOf = route => byId('profiles', route.profileId);
const liveOf = route => ({ ...route, ...(route.remote || {}) });
const remoteStamp = () => Math.max(0, S.data.topology?.checkedAt || 0, ...S.data.routes.map(r => r.lastRemoteSyncAt || r.remote?.syncedAt || 0), ...(S.data.discoveries || []).map(d => d.checkedAt || 0));
const activeJobs = () => S.data.jobs.filter(j => ['queued', 'running', 'waiting', 'retrying'].includes(j.status));
const optionize = (items, key = 'name') => items.map(x => ({ value: x.id, label: x[key] }));
const jobOf = route => S.data.jobs.find(j => j.id === route.pendingJobId);
function stateOf(route) {
  const job = jobOf(route);
  // Certificate maintenance is intentionally non-blocking for traffic readiness.
  // Keep the live Cloudflare route status visible while renewal/validation runs.
  if (job?.type === 'renewal') return route.observed?.status || 'unknown';
  if (job?.status === 'failed') return 'error';
  if (job?.status === 'waiting') return 'pending';
  if (job) return 'waiting_dns';
  return route.observed?.status || 'unknown';
}
const attention = route => ['drift', 'offline', 'error', 'degraded'].includes(stateOf(route));
const fmtCount = n => String(n).padStart(2, '0');
const errors = () => S.error ? notice(S.error, 'red') : '';
const checkbox = (name, label, hint = '', value = false) => html`<label class="checkbox-label"><input type="checkbox" name="${name}" ${checked(value)}><span><strong>${label}</strong>${hint ? html`<small>${hint}</small>` : ''}</span></label>`;
const submitButton = (label, glyph = 'arrow', tone = 'primary') => html`<button type="submit" class="btn ${tone} ${S.busy ? 'spinner' : ''}" ${disabled(S.busy)}>${ic(S.busy ? 'refresh' : glyph)}<span>${S.busy ? '正在处理…' : label}</span></button>`;
const formButtons = (label, glyph = 'arrow') => html`${button('取消', 'close', '', 'btn', 'type="button"')}${submitButton(label, glyph)}`;

async function api(path, method = 'GET', body) {
  if (S.demo) return demoRequest(memory, demoPlans, path, method, body);
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务未返回 JSON。请检查 Workers 部署、域名和 Cloudflare Access 配置。'); }
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') { S.authenticated = false; S.modal = null; S.draft = {}; }
    throw new Error(data.error?.message || `请求未完成（${response.status}）。`);
  }
  return data;
}
async function loadState() { S.data = await api('/state'); S.data.discoveries ||= []; S.lastLoaded = Date.now(); }
async function syncAllProfiles({ notify = false } = {}) {
  if (S.demo || !S.authenticated || S.syncing) return;
  S.syncing = true; S.syncError = ''; render();
  const failures = [];
  try {
    // A fresh installation has credentials but no local profile mappings yet. In that case first
    // perform a read-only topology scan. Unambiguous existing chains are adopted locally only;
    // Cloudflare is not mutated and certificate maintenance stays disabled for imported routes.
    if (!S.data.profiles.length && S.data.credentials.length) {
      try {
        const topology = await api('/topology/sync', 'POST', { adopt: true });
        if (!topology.adoptedRoutes && topology.issues?.length) {
          failures.push(`自动发现: ${topology.issues.slice(0, 3).map(x => `${x.scope ? `${x.scope}: ` : ''}${x.message}`).join('；')}`);
        }
      }
      catch (e) { failures.push(`自动发现: ${e.message}`); }
      await loadState();
    }
    for (const profile of S.data.profiles) { try { await api(`/profiles/${profile.id}/sync`, 'POST', {}); } catch (e) { failures.push(`${profile.name}: ${e.message}`); } }
    await loadState();
    S.syncError = failures.join('；');
    if (notify) toast(failures.length ? `同步完成，但 ${failures.length} 套方案需要检查` : '已从 Cloudflare 重新同步', !!failures.length);
  } finally { S.syncing = false; render(); }
}
async function catalog(id, force = false) {
  if (!id) return;
  if (!S.catalogs[id] || force) S.catalogs[id] = await api(`/credentials/${id}/catalog`);
}
function toast(message, error = false) {
  const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`;
  node.innerHTML = String(html`${ic(error ? 'alert' : 'check')}<span>${message}</span>`);
  const region = document.getElementById('toast-region'); region.replaceChildren(node);
  setTimeout(() => node.remove(), 5500);
}
async function work(fn) {
  if (S.busy) return;
  S.busy = true; S.error = ''; render();
  try { await fn(); }
  catch (e) { S.error = e.message; if (!S.modal && S.authenticated) toast(e.message, true); }
  finally { S.busy = false; render(); }
}
let returnFocus = null, lastModal = null;
function openModal(kind, draft = {}, extra = {}) {
  returnFocus = document.activeElement?.dataset.action ? { action: document.activeElement.dataset.action, id: document.activeElement.dataset.id } : null;
  S.modal = { kind, ...extra }; S.draft = structuredClone(draft); S.error = ''; render();
}
function closeModal() { if (S.busy) return; S.modal = null; S.draft = {}; S.error = ''; S.candidates = []; S.selected.clear(); render(); }
function brand() { return html`<div class="brand"><div class="brand-logo">${ic('cloud')}</div><div><div class="brand-name">Cloudlane</div><div class="brand-sub">云径 · EVERY ROUTE, IN SYNC</div></div></div>`; }
const navigation = [ ['routes', '服务与域名', 'route'], ['profiles', '配置方案', 'layers'], ['tunnels', 'Tunnel 资源', 'server'], ['credentials', 'API 凭据', 'key'], ['jobs', '执行任务', 'pulse'], ['activity', '操作记录', 'clock'], ['help', '使用指南', 'help'] ];
function header(title, description, actions = '', eyebrow = 'YOUR WORKSPACE') { return html`<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="head-actions">${actions}</div></div>`; }
function render() {
  root.setAttribute('aria-busy', String(S.busy));
  const focus = document.activeElement;
  const focused = focus && root.contains(focus) ? { id: focus.id, name: focus.name, action: focus.dataset?.action, item: focus.dataset?.id, selection: typeof focus.selectionStart === 'number' ? [focus.selectionStart, focus.selectionEnd] : null } : null;
  const scroll = document.querySelector('.modal-body')?.scrollTop || 0;
  if (S.loading) root.innerHTML = String(html`<div class="login-page"><div class="login-card">${brand()}<h1>正在连接工作区</h1><p>安全读取配置与执行状态…</p><div class="skeleton"></div></div></div>`);
  else if (!S.authenticated) root.innerHTML = String(loginView());
  else root.innerHTML = String(shell());
  document.body.classList.toggle('modal-open', !!S.modal);
  const shellNode = root.querySelector('.app-shell');
  if (shellNode && S.modal) { shellNode.inert = true; shellNode.setAttribute('aria-hidden', 'true'); }
  const modalNode = document.querySelector('[role="dialog"]');
  if (S.busy) for (const node of root.querySelectorAll('form input,form select,form textarea,form button,[role="dialog"] button')) node.disabled = true;
  if (modalNode) {
    const body = modalNode.querySelector('.modal-body'); if (body) body.scrollTop = scroll;
    if (lastModal !== S.modal.kind) setTimeout(() => modalNode.querySelector('input:not([readonly]),select,textarea,button')?.focus(), 0);
  }
  if (focused && (!modalNode || lastModal === S.modal?.kind)) {
    let next = focused.id && document.getElementById(focused.id);
    if (!next && focused.name) next = [...root.querySelectorAll('[name]')].find(x => x.name === focused.name);
    if (!next && focused.action) next = [...root.querySelectorAll('[data-action]')].find(x => x.dataset.action === focused.action && x.dataset.id === focused.item);
    if (next && !next.disabled && (!modalNode || modalNode.contains(next))) { next.focus({ preventScroll: true }); if (focused.selection && next.setSelectionRange) { try { next.setSelectionRange(...focused.selection); } catch { /* select/number input */ } } }
  }
  if (!S.modal && lastModal && returnFocus) [...root.querySelectorAll('[data-action]')].find(x => x.dataset.action === returnFocus.action && x.dataset.id === returnFocus.id)?.focus({ preventScroll: true });
  lastModal = S.modal?.kind || null;
}
function loginView() {
  return html`<main class="login-page"><div class="login-card">${brand()}<div class="eyebrow">WELCOME TO YOUR CONTROL PLANE</div><h1>让每一条连接，都有迹可循。</h1><p>管理 Tunnel、优选域名与证书，从一个轻盈的工作区开始。</p>${S.setupError ? notice(S.setupError, 'amber', '完成部署设置后即可登录') : ''}${errors()}${S.configured ? html`<form data-form="login">${field('管理密码', 'password', S.draft.password, { type: 'password', required: true, autocomplete: 'current-password', placeholder: '输入 Worker Secret 中的管理密码' })}${submitButton('进入工作区', 'arrow')}</form>` : notice('在 Cloudflare Workers 中设置 ADMIN_PASSWORD 和 ENCRYPTION_KEY 两个 Secret，然后刷新页面。部署说明见项目 README。', 'blue')}${button('先看看交互演示', 'demo', 'spark', 'text-btn')}<div class="login-foot">API 凭据仅在服务端解密使用<br>自托管 · 无外部分析脚本 · 无第三方字体请求</div></div></main>`;
}
function shell() {
  const name = navigation.find(n => n[0] === S.page)?.[1] || '优选记录';
  return html`<div class="app-shell ${S.mobileMenu ? 'menu-open' : ''}"><div class="mobile-backdrop" data-action="menu"></div><aside class="sidebar">${brand()}<div class="workspace"><span class="workspace-avatar">S</span><div><strong>我的工作区</strong><small>${S.demo ? '演示模式' : '自托管管理面板'}</small></div>${ic('down')}</div><div class="nav-heading">工作空间</div><nav class="nav-list" aria-label="主导航">${navigation.slice(0, 4).map(([key, title, glyph]) => navItem(key, title, glyph))}</nav><div class="nav-heading">管理与安全</div><nav class="nav-list" aria-label="管理导航">${navigation.slice(4).map(([key, title, glyph]) => navItem(key, title, glyph))}</nav><div class="sidebar-bottom"><div class="sidebar-hint">${ic('shield')}<strong>每次变更，先有预览</strong><p>保留原有配置<br>只执行你确认过的变更</p></div><div class="version"><span class="dot"></span> Cloudlane <span>v0.2.5</span></div></div></aside><div class="main-shell"><header class="topbar"><div class="breadcrumb">${iconButton('展开导航', 'menu', 'menu', '', `aria-expanded="${S.mobileMenu}"`)}<span>工作空间</span>${ic('chevron')}<strong>${name}</strong></div><div class="topbar-right"><span class="top-status"><span class="dot"></span>${S.demo ? '交互演示 · 不连接 API' : S.syncing ? '正在同步 Cloudflare…' : remoteStamp() ? `Cloudflare 同步于 ${ago(remoteStamp())}` : '等待首次 Cloudflare 同步'}</span>${badge(S.demo ? 'DEMO' : 'SELF-HOSTED', S.demo ? 'pink' : 'blue', 'cloud')}${iconButton('从 Cloudflare 同步', 'refresh-state', 'refresh')}${S.demo ? '' : iconButton('退出登录', 'logout', 'logout')}<div class="avatar">S</div></div></header><main class="main-content" id="main-content">${S.demo ? html`<div class="demo-banner">${ic('spark')}<span>你正在探索演示工作区。这里的记录与状态均为示例，所有操作只在内存中模拟。</span>${button('连接自己的账户', 'leave-demo', 'arrow', 'text-btn')}</div>` : ''}${pages[S.page]()}<footer class="page-footer"><span>Cloudlane · 少一点配置，多一点顺畅。</span><span>配置状态不等于业务可用性 ${ic('shield')}</span></footer></main></div></div>${S.modal ? modalView() : ''}`;
}
function navItem(key, title, glyph) { return html`<button class="nav-item" data-action="navigate" data-id="${key}" ${S.page === key ? raw('aria-current="page"') : ''} title="${title}">${ic(glyph)}<span>${title}</span>${key === 'routes' && S.data.routes.length ? html`<span class="nav-count">${S.data.routes.length}</span>` : key === 'jobs' && activeJobs().length ? html`<span class="nav-count">${activeJobs().length}</span>` : ''}</button>`; }
function groupRoutesByService(rows) {
  const groups = new Map();
  for (const route of rows) {
    const p = profileOf(route), live = liveOf(route);
    const key = [p?.accountId || p?.id || 'missing', p?.sourceZone?.id || 'missing', p?.tunnelId || 'missing', live.service || route.service || 'unknown'].join('|');
    if (!groups.has(key)) groups.set(key, { key, service: live.service || route.service || '未识别服务', routes: [], tunnelNames: new Set(), sourceZones: new Set(), publicZones: new Set(), origins: new Set() });
    const group = groups.get(key);
    group.routes.push(route);
    if (p?.tunnelName) group.tunnelNames.add(p.tunnelName);
    if (p?.sourceZone?.name) group.sourceZones.add(p.sourceZone.name);
    if (p?.publicZone?.name) group.publicZones.add(p.publicZone.name);
    if (live.originHostname) group.origins.add(live.originHostname);
  }
  return [...groups.values()].sort((a, b) => ([...a.tunnelNames][0] || '').localeCompare([...b.tunnelNames][0] || '') || a.service.localeCompare(b.service));
}
function serviceGroup(group, groupIndex) {
  const tunnel = [...group.tunnelNames].join(' / ') || 'Tunnel 已移除';
  const source = [...group.sourceZones].join(' / ') || '未知源 Zone';
  const publicZones = group.publicZones.size;
  const shared = group.origins.size === 1 && group.routes.length > 1;
  return html`<section class="service-cluster"><header class="service-cluster-head"><div class="service-icon ${groupIndex % 2 ? 'pink' : ''}">${ic('server')}</div><div class="service-cluster-main"><div class="eyebrow">TUNNEL SERVICE</div><h3 title="${group.service}">${group.service}</h3><p>${tunnel} · ${source}${publicZones > 1 ? ` · ${publicZones} 个访问 Zone` : ''}</p></div><div class="service-cluster-meta">${badge(`${group.routes.length} 个访问域名`, 'blue', 'globe')}${shared ? badge(`共享源 × ${group.routes.length}`, 'pink', 'cloud') : badge(`${group.origins.size} 个源域名`, 'neutral', 'cloud')}</div></header><div class="record-list service-routes">${group.routes.map((r, i) => recordCard(r, groupIndex + i))}</div></section>`;
}
function routePage() {
  const rows = S.data.routes;
  const allServiceGroups = groupRoutesByService(rows);
  const ready = rows.filter(r => stateOf(r) === 'ready').length;
  const pending = rows.filter(r => ['pending', 'waiting_dns'].includes(stateOf(r))).length;
  const sslPending = rows.filter(r => r.observed?.sslStatus && r.observed.sslStatus !== 'active' && r.observed.sslStatus !== 'missing').length;
  const discovered = (S.data.discoveries || []).flatMap(d => d.candidates || []).filter(c => c.importable);
  const q = S.search.toLowerCase();
  const filtered = rows.filter(r => {
    const live = liveOf(r);
    return (!S.filterProfile || r.profileId === S.filterProfile) && (S.tab === 'all' || (S.tab === 'ready' ? stateOf(r) === 'ready' : stateOf(r) !== 'ready')) && [r.name, r.publicHostname, r.originHostname, r.service, live.publicHostname, live.originHostname, live.service, live.edgeHostname, profileOf(r)?.tunnelName].some(x => x?.toLowerCase().includes(q));
  });
  const filteredServiceGroups = groupRoutesByService(filtered);
  const stats = [
    ['Tunnel 服务', allServiceGroups.length, `${rows.length} 个访问域名`, 'server', '', '组'],
    ['配置就绪', ready, sslPending ? `${sslPending} 条 SSL 仍处理中 · 不阻断` : '当前远端配置核对通过', 'check', '', '条'],
    ['等待前置', pending, '等待主机名 / Fallback / DNS', 'clock', 'pink', '条'],
    ['需要关注', rows.filter(attention).length, '发现远端变化，不静默覆盖', 'pulse', 'amber', '条']
  ];
  const emptyAction = !S.data.credentials.length ? ['new-credential', '添加 API 凭据'] : !S.data.profiles.length ? ['refresh-state', '扫描 Cloudflare'] : ['new-route', '新建优选域名'];
  return html`${header('服务与优选域名', '先看 Tunnel 实际指向的服务，再看这个服务挂了哪些源域名、SaaS 主机名和优选访问域名。Cloudflare 仍是事实源。', html`${button('导入现有记录', 'import', 'download')}${button('新建优选域名', 'new-route', 'plus', 'btn primary')}`, 'TUNNEL FIRST, ROUTES UNDER IT')}${S.syncError ? notice(S.syncError, 'amber', '部分同步需要检查') : ''}${discovered.length ? html`<div class="demo-banner remote-discovery">${ic('download')}<span>最近同步发现 ${discovered.length} 条可识别、但尚未纳入管理的访问域名。</span>${button('查看并导入', 'import', 'arrow', 'text-btn')}</div>` : ''}<section class="stats" aria-label="服务概览">${stats.map(([title, count, hint, glyph, tone, unit]) => html`<article class="stat ${tone}"><div class="stat-top">${title}${ic(glyph)}</div><div class="stat-bottom"><span class="stat-number">${fmtCount(count)}</span><span class="stat-unit">${unit}</span></div><p class="stat-hint">${hint}</p></article>`)}</section><div class="connection-strip"><div class="strip-icon">${ic('server')}</div><div class="strip-intro"><h3>Tunnel → Service</h3><p>一个服务可以挂多个源域名和访问域名</p></div><div class="mini-flow">${[['server', 'Tunnel 服务'], ['cloud', '共享/独立源'], ['spark', '优选入口'], ['globe', '访问域名']].map(([glyph, label], i) => html`${i ? html`<span class="flow-arrow">${ic('arrow')}</span>` : ''}<span class="flow-node">${ic(glyph)}${label}</span>`)}</div></div><div class="section-heading"><h2>所有 Tunnel 服务 <span>${allServiceGroups.length}</span></h2>${button('配置导出', 'export', 'download', 'text-btn')}</div><div class="toolbar"><label class="search-box">${ic('search')}<input id="route-search" type="search" placeholder="搜索服务、Tunnel、域名…" value="${S.search}" aria-label="搜索服务与域名"><kbd>⌘ K</kbd></label><label class="filter-select"><select id="profile-filter" aria-label="按配置方案筛选"><option value="">所有配置方案</option>${S.data.profiles.map(p => html`<option value="${p.id}" ${yes(S.filterProfile === p.id)}>${p.name}</option>`)}</select>${ic('down')}</label><div class="tabs" role="group" aria-label="按状态筛选">${[['all', '全部', rows.length], ['ready', '已就绪', ready], ['attention', '待处理', rows.length - ready]].map(([key, label, count]) => html`<button class="tab ${S.tab === key ? 'active' : ''}" data-action="tab" data-id="${key}" aria-pressed="${S.tab === key}">${label}<em>${count}</em></button>`)}</div></div>${rows.length ? html`<div class="service-clusters">${filtered.length ? filteredServiceGroups.map(serviceGroup) : empty('没有匹配的服务或域名', '试试另一个关键词，或清除筛选条件。', 'clear-filters', '清除筛选', 'search')}</div><div class="list-footer"><span>显示 ${filtered.length} / ${rows.length} 个访问域名，归入 ${filteredServiceGroups.length} 个 Tunnel 服务</span><span>${ic('info')} 同一个源域名被多个 SaaS 主机名共享是正常拓扑；删除单个访问域名时会保留仍被其它主机名使用的源资源。</span></div>` : html`<div class="setup-steps">${[['1', '添加 API 凭据', '读取 Zone 与 Tunnel'], ['2', '自动发现或创建方案', '按 Tunnel / service 识别现有链路'], ['3', '管理访问域名', '共享源域名无需拆开']].map(([n, title, hint]) => html`<div class="setup-step"><span>${n}</span><div><strong>${title}</strong><small>${hint}</small></div></div>`)}</div>${empty('还没有识别到 Tunnel 服务', '已有 Cloudflare 配置会先只读扫描；也可以手动创建新的配置方案和访问域名。', emptyAction[0], emptyAction[1])}`}`;
}
function recordCard(r, index) {
  const p = profileOf(r), o = r.observed, status = stateOf(r), job = jobOf(r), live = liveOf(r);
  const sharedOriginUsers = S.data.routes.filter(other => {
    const op = profileOf(other), ol = liveOf(other);
    return op?.accountId === p?.accountId && op?.sourceZone?.id === p?.sourceZone?.id && op?.tunnelId === p?.tunnelId && ol.originHostname === live.originHostname;
  }).length;
  const sslText = o?.sslStatus === 'active' ? 'SSL · active' : o?.sslStatus ? `SSL · ${o.sslStatus}${status === 'ready' ? ' · 不阻断' : ''}` : job ? job.step : 'SSL · 未检查';
  return html`<article class="record-card ${attention(r) ? 'warning' : ''}"><div class="record-identity"><div class="service-icon ${index % 3 === 1 ? 'pink' : ''}">${ic('globe')}</div><div><button class="record-title" data-action="detail" data-id="${r.id}">${r.name}</button><p class="service-url">${sharedOriginUsers > 1 ? `共享源 · ${sharedOriginUsers} 个访问域名` : '独立源域名'}</p><div class="record-group">${ic('folder')}<span>${p?.publicZone?.name || p?.name || '方案已移除'}</span><span class="divider">/</span><span>${p?.name || '未知方案'}</span></div></div></div><div class="domain-map"><span class="domain-label">MAIN</span><button class="domain-value main" title="查看连接详情" data-action="detail" data-id="${r.id}">${live.publicHostname}</button><span class="domain-label origin">ORIGIN</span><span class="domain-value">${live.originHostname}</span><span class="domain-label edge">EDGE</span><span class="domain-value">${live.edgeHostname}</span></div><div class="record-status">${job?.status === 'paused' ? jobBadge('paused') : routeBadge(status)}<span class="ssl-line" title="${o?.sslStatus || '尚未检查'}">${ic(o?.sslStatus === 'active' ? 'lock' : 'clock')}${sslText}</span></div><div class="record-actions">${iconButton('诊断与状态', 'detail', 'pulse', r.id)}${iconButton('编辑访问域名', 'edit-route', 'edit', r.id)}${iconButton('打开访问域名', 'visit', 'external', r.id)}</div></article>`;
}
function profilesPage() {
  return html`${header('配置方案', '把账户、域名、Tunnel 与优选入口组合起来。不同业务，互不混淆。', button('新建方案', 'new-profile', 'plus', 'btn primary'), 'A PLACE FOR EVERY ROUTE')}${S.data.profiles.length ? html`<div class="resources-grid">${S.data.profiles.map(p => html`<article class="resource-card"><div class="resource-top"><div class="service-icon">${ic('layers')}</div><div><h2>${p.name}</h2><p>${S.data.routes.filter(r => r.profileId === p.id).length} 条记录 · ${p.validationMode === 'txt' ? 'TXT 自动验证' : p.validationMode === 'delegated' ? 'DCV 委派' : '自动选择验证方式'}</p></div>${iconButton('编辑方案', 'edit-profile', 'edit', p.id)}</div><div class="resource-values">${resourceValue('源 Zone', p.sourceZone.name)}${resourceValue('访问 Zone', p.publicZone.name)}${resourceValue('Tunnel', p.tunnelName)}${resourceValue('优选入口', p.edgeHostname)}${resourceValue('入口预设目标', p.edgeTarget || '沿用已有 DNS')}</div><div class="resource-foot"><button class="btn small" data-action="import-profile" data-id="${p.id}">${ic('download')}导入记录</button><button class="btn small soft" data-action="edit-edge" data-id="${p.id}">${ic('spark')}修改共享入口</button>${iconButton('删除未使用的方案', 'delete-profile', 'trash', p.id)}</div></article>`)}</div>` : empty('先定义一套连接方式', '同一方案下的记录可以复用 Tunnel、源域名和优选入口。访问域名可以使用另一个账户的凭据。', 'new-profile', '创建配置方案', 'layers')}${notice('修改方案里的入口预设不会自动改变已有记录。需要切换共享入口的目标时，请使用「修改共享入口」，单独查看影响范围并确认。', 'blue')}`;
}
function resourceValue(label, value) { return html`<div class="resource-value"><span>${label}</span><strong title="${value}">${value}</strong></div>`; }
function tunnelsPage() {
  const tunnels = new Map();
  for (const p of S.data.profiles) tunnels.set(`${p.sourceCredentialId}:${p.tunnelId}`, { id: p.tunnelId, credentialId: p.sourceCredentialId, name: p.tunnelName, status: 'unknown', remote_config: true });
  for (const [cid, cat] of Object.entries(S.catalogs)) for (const t of cat.tunnels || []) tunnels.set(`${cid}:${t.id}`, { ...t, credentialId: cid });
  return html`${header('Tunnel 资源', '只管理远程配置的 Tunnel；本地 config.yml 保持原样。', button('重新读取资源', 'refresh-catalogs', 'refresh', 'btn primary'), 'KNOW YOUR TUNNELS')}${!Object.keys(S.catalogs).length ? notice('下方先展示方案中引用的 Tunnel。点击「重新读取资源」，获取 Token 可访问的完整列表与实时连接状态。') : ''}${Object.values(S.catalogs).filter(c => c.warning).map(c => notice(c.warning, 'amber', '部分资源读取受限'))}<div class="resources-grid">${[...tunnels.values()].map(t => html`<article class="resource-card"><div class="resource-top"><div class="service-icon">${ic('server')}</div><div><h2>${t.name}</h2><p>${byId('credentials', t.credentialId)?.label}</p></div>${badge(t.status === 'healthy' ? '连接正常' : t.status === 'unknown' ? '未读取状态' : t.status, t.status === 'healthy' ? 'blue' : 'neutral')}</div><div class="resource-values">${resourceValue('配置方式', t.remote_config ? 'Cloudflare 远程管理' : '本地管理 · 只读')}${resourceValue('Tunnel ID', t.id)}${resourceValue('关联方案', S.data.profiles.filter(p => p.tunnelId === t.id).map(p => p.name).join('、') || '尚未关联')}</div><div class="resource-foot"><span>连接正常不代表 localhost 服务正常。</span>${iconButton('复制 Tunnel ID', 'copy', 'copy', t.id)}</div></article>`)}</div>${!tunnels.size ? empty('还没有读取到 Tunnel', '先添加包含 Tunnel 读取权限的源账户凭据，再刷新资源。', 'new-credential', '添加 API 凭据', 'server') : ''}`;
}
function credentialsPage() {
  return html`${header('API 凭据', '授权分开管理，密钥只留在服务端。', button('添加凭据', 'new-credential', 'plus', 'btn primary'), 'SECURE BY DESIGN')}${notice('Token 使用 Worker Secret 保存的 AES-GCM 密钥加密保存。浏览器不会持久化 Token，面板也不会提供明文读取接口。', 'blue', '密钥不出服务端存储边界')}<div class="resources-grid">${S.data.credentials.map(c => html`<article class="resource-card"><div class="resource-top"><div class="service-icon pink">${ic('key')}</div><div><h2>${c.label}</h2><p>账户级授权范围由你的 Token 决定</p></div>${badge('已保存', 'blue', 'lock')}</div><div class="resource-values">${resourceValue('Account ID', c.accountId)}${resourceValue('Token', '•••••••••••••••• · 无法回显')}${resourceValue('使用此凭据', `${S.data.profiles.filter(p => p.sourceCredentialId === c.id || p.publicCredentialId === c.id).length} 套配置方案`)}</div><div class="resource-foot"><button class="btn small" data-action="edit-credential" data-id="${c.id}">${ic('key')}轮换 / 编辑</button>${iconButton('删除未使用的凭据', 'delete-credential', 'trash', c.id)}</div></article>`)}</div>${!S.data.credentials.length ? empty('连接你的 Cloudflare 账户', '可以添加多套 Token；源 Zone 与 Tunnel 需要属于同一账户。', 'new-credential', '添加第一套凭据', 'key') : ''}<section class="guide-card"><h2>${ic('shield')} 最小权限建议</h2><p><strong>源账户：</strong>Account → Cloudflare Tunnel → Edit；Zone → Zone → Read、DNS → Edit、SSL and Certificates → Edit。把资源范围限制到需要管理的账户和 Zone。</p><p><strong>只管理访问域名的账户：</strong>Zone → Zone → Read、DNS → Edit。可以复用同一 Token，也可以单独提供另一账户的 Token。</p><p>添加时只验证可读的 Zone。实际写权限不足会在对应步骤显示 Cloudflare 错误，不会自动扩大权限或启用付费产品。</p></section>`;
}
function jobsPage() { return html`${header('执行任务', '每一次变更，都有预览、步骤和结果。关掉网页后任务仍由服务端执行。', button('刷新任务', 'refresh-state', 'refresh'), 'CHANGES, WITH A PAPER TRAIL')}<div class="record-list">${S.data.jobs.map(j => html`<article class="job-row"><div><h3>${j.name || j.hostname}</h3><p>${j.hostname}</p></div>${jobBadge(j.status)}<div class="job-progress"><div><span>${j.step}</span><small>${j.completed}/${j.total}</small></div><progress value="${j.completed}" max="${Math.max(1, j.total)}" aria-label="已完成步骤"></progress></div>${iconButton('查看任务详情', 'job', 'arrow', j.id)}</article>`)}</div>${!S.data.jobs.length ? empty('这里会记录每一次执行', '创建记录时先生成预览。确认执行后，任务才会开始写入 Cloudflare。', '', '', 'pulse') : ''}`; }
function activityPage() { return html`${header('操作记录', '账户接入、配置变化和任务结果，一目了然。', button('刷新记录', 'refresh-state', 'refresh'), 'A CLEAR HISTORY')}<div class="activity-list">${S.data.events.map(e => html`<article class="activity-row"><div class="activity-symbol">${ic(e.jobId ? 'pulse' : 'clock')}</div><div class="activity-text"><h3>${e.action}</h3><p>${e.detail}</p></div><time datetime="${new Date(e.at).toISOString()}">${date(e.at)}</time>${e.jobId ? iconButton('查看关联任务', 'job', 'arrow', e.jobId) : ''}</article>`)}</div>${!S.data.events.length ? empty('一切，从第一步开始', '操作日志保留最近 300 条；任务变更快照单独保存。', '', '', 'clock') : ''}`; }
function helpPage() { return html`${header('让配置，保持简单。', '远端事实、修改边界和删除行为都明确展示，不靠猜。', '', 'A LITTLE GUIDANCE')}<div class="guide-grid"><section class="guide-card"><h2>${ic('route')} 一条记录，怎样连起来</h2><p>访问域名 <code>1.b.com</code> 以 DNS-only CNAME 指向 <code>speed.a.com</code>。源 Zone 的 SaaS 自定义主机名将它回源到 <code>1.a.com</code>，再通过 Tunnel 到本地服务。</p><p>Tunnel 中保留源域名与访问域名两条精确 ingress。填写的 <code>localhost:1111</code> 指 cloudflared 所在机器，而不是 Worker。</p></section><section class="guide-card"><h2>${ic('shield')} Tunnel 不会被“重建”</h2><p>Cloudflare 的远程 Tunnel 配置更新 API 是整份配置替换，因此面板采用“先读取 → 只合并/移除目标 hostname → 再核对 → 写回完整配置”的方式。不会删除 Tunnel，也不会把其它 ingress、全局 originRequest 或未知字段清空。</p><p>若预览后其它地方改过同一 Tunnel，执行会停止并要求重新预览，不把旧快照覆盖回去。</p></section><section class="guide-card"><h2>${ic('lock')} SSL pending 不阻断入口</h2><p>SaaS 主机名状态与 SSL 证书状态分开展示。默认只等待主机名 active 与 Fallback Origin active；SSL 仍为 <code>pending_validation</code> 时也允许按正常策略切换访问 DNS。</p><p>证书验证记录仍会生成和维护，pending 只是可见状态，不再把整条记录判定为“未就绪”。</p></section><section class="guide-card"><h2>${ic('cloud')} 远端状态是事实源</h2><p>本地 Durable Object 只保存管理映射、名称、备注、凭据引用和任务日志。进入面板及手动刷新时，会按配置方案重新读取 Tunnel、SaaS Custom Hostname、源 Zone DNS 与访问 Zone DNS。</p><p>检测到 Cloudflare 中的服务地址、优选入口或回源发生变化时，卡片显示最近同步到的远端值，并把与管理映射的差异标记出来。</p></section><section class="guide-card"><h2>${ic('trash')} 解除管理与云端删除是两回事</h2><p>“仅解除管理”只移除本地映射，适合保留现有 Cloudflare 配置；“删除云端资源”则先生成删除预览，再删除这条记录可明确归属的访问 DNS、验证 DNS、Custom Hostname、专属源 DNS 与精确 Tunnel ingress。</p><p>共享优选入口和 SaaS Fallback Origin不会随单条记录删除；源域名若被其它 Custom Hostname 共享，也会保留。</p></section><section class="guide-card"><h2>${ic('spark')} 优选，不等于自动测速</h2><p>这里负责管理你选定的入口，不从 Worker 测一个 IP 就宣称它适合你的网络。最终速度受直连线路、运营商、入口维护和终端网络影响。</p><p>当前支持两个独立 Zone、HTTP/HTTPS 精确子域名和远程管理 Tunnel。根域名、通配符、路径拆分、SSH/TCP 和外部 DNS 暂不自动接管。</p></section></div>`; }

const pages = { routes: routePage, profiles: profilesPage, tunnels: tunnelsPage, credentials: credentialsPage, jobs: jobsPage, activity: activityPage, help: helpPage };

function modalFrame(title, subtitle, content, footer, { form = '', drawer = false, narrow = false } = {}) {
  return html`<div class="overlay ${drawer ? 'drawer-overlay' : ''}"><section class="modal ${drawer ? 'drawer' : ''} ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">${form ? raw(`<form data-form="${form}">`) : ''}<header class="modal-head"><div><div class="eyebrow">CLOUDLANE WORKSPACE</div><h2 id="modal-title">${title}</h2><p>${subtitle}</p></div>${iconButton('关闭对话框', 'close', 'x', '', 'type="button"')}</header><div class="modal-body">${errors()}${content}</div><footer class="modal-footer">${footer}</footer>${form ? raw('</form>') : ''}</section></div>`;
}
function modalView() {
  switch (S.modal.kind) {
    case 'credential': return credentialModal();
    case 'profile': return profileModal();
    case 'route': return routeModal();
    case 'plan': return planModal();
    case 'detail': return detailModal();
    case 'job': return jobModal();
    case 'import': return importModal();
    case 'edge': return edgeModal();
    case 'delete': return deleteModal();
    default: return '';
  }
}
function credentialModal() {
  const d = S.draft;
  return modalFrame(d.id ? '编辑 API 凭据' : '连接 Cloudflare 账户', '可以为不同账户或不同权限范围添加独立凭据。', html`<div class="form-grid">${field('凭据名称', 'label', d.label, { required: true, wide: true, placeholder: '例如：个人账户 · Tunnel 与 DNS' })}${field('Cloudflare Account ID', 'accountId', d.accountId, { required: true, readonly: !!d.id, wide: true, pattern: '[A-Fa-f0-9]{32}', hint: '账户 ID，不是 Zone ID。可以在 Cloudflare 账户概览中复制。' })}${field(d.id ? '新 API Token（留空则保留）' : 'API Token', 'token', '', { type: 'password', required: !d.id, wide: true, autocomplete: 'new-password', hint: '只接受 API Token，不使用 Global API Key。提交后无法回显。' })}</div>${notice('源账户需要 Tunnel Edit、Zone Read、DNS Edit、SSL and Certificates Edit。访问域名账户需要 Zone Read 和 DNS Edit。', 'blue')}`, formButtons('验证并保存', 'shield'), { form: 'credential', narrow: true });
}
function profileModal() {
  const d = S.draft, source = S.catalogs[d.sourceCredentialId], dest = S.catalogs[d.publicCredentialId];
  const used = d.id && S.data.routes.some(r => r.profileId === d.id), credentials = optionize(S.data.credentials, 'label');
  return modalFrame(d.id ? '编辑配置方案' : '新建配置方案', '一套方案定义一组账户、Zone、Tunnel 与默认优选入口。', html`${used ? notice('这套方案已有记录。账户、Zone 和 Tunnel 锁定；迁移请创建新方案。', 'blue') : ''}<div class="form-grid">${field('方案名称', 'name', d.name, { required: true, wide: true, placeholder: '例如：日常服务 / 家庭媒体' })}${selectField('源账户凭据', 'sourceCredentialId', d.sourceCredentialId, credentials, { required: true, disabled: used })}${selectField('访问域名凭据', 'publicCredentialId', d.publicCredentialId, credentials, { required: true, disabled: used })}${selectField('源 Zone（a.com）', 'sourceZoneId', d.sourceZoneId, optionize(source?.zones || []), { required: true, disabled: used, hint: '需要已启用 Cloudflare for SaaS。' })}${selectField('访问 Zone（b.com）', 'publicZoneId', d.publicZoneId, optionize(dest?.zones || []), { required: true, disabled: used })}${selectField('Cloudflare Tunnel', 'tunnelId', d.tunnelId, (source?.tunnels || []).map(t => ({ value: t.id, label: `${t.name}${t.remote_config ? '' : ' · 本地配置，不支持'}`, disabled: !t.remote_config })), { required: true, disabled: used, wide: true, hint: '仅支持源账户内、由 Cloudflare 远程管理的 Tunnel。' })}${field('默认优选入口', 'edgeHostname', d.edgeHostname, { required: true, placeholder: 'speed.a.com' })}${field('入口 CNAME 预设目标（可选）', 'edgeTarget', d.edgeTarget, { placeholder: '你已有的优选域名', hint: '仅在入口不存在时创建，不会覆盖已有入口。' })}${selectField('证书验证方式', 'validationMode', d.validationMode, [{ value: 'auto', label: '自动 · 优先 DCV 委派' }, { value: 'delegated', label: '仅 DCV 委派' }, { value: 'txt', label: 'TXT 自动维护' }], { required: true, wide: true })}</div>${source?.warning ? notice(source.warning, 'amber') : ''}<div class="form-section">${checkbox('initializeFallback', '允许初始化缺失的 SaaS 备用源', '只在源 Zone 没有备用源时创建专用 Tunnel CNAME，不修改已有备用源，也不替你开通 SaaS。', d.initializeFallback)}</div>`, formButtons('保存方案', 'check'), { form: 'profile' });
}
function wizard(step) { return html`<div class="wizard-steps"><span class="wizard-step ${step === 1 ? 'active' : ''}"><span>1</span>填写连接</span><span class="wizard-connector"></span><span class="wizard-step ${step === 2 ? 'active' : ''}"><span>2</span>检查变更</span><span class="wizard-connector"></span><span class="wizard-step"><span>3</span>确认并跟踪</span></div>`; }
function routeModal() {
  const d = S.draft, p = byId('profiles', d.profileId);
  return modalFrame(d.id ? '编辑优选记录' : '新建优选记录', '完整预览会在下一步生成；现在还不会修改 Cloudflare。', html`${wizard(1)}${d.id ? html`<div class="form-section">${checkbox('revalidate', '重新触发 SaaS 验证', '验证卡住或解除 Zone hold 后使用。会保留原 method/type 发起一次 PATCH；已有任务请先暂停。', d.revalidate)}</div>` : ''}<div class="form-grid">${selectField('配置方案', 'profileId', d.profileId, optionize(S.data.profiles), { required: true, disabled: !!d.id, wide: true, hint: p ? `${p.sourceZone.name} → ${p.publicZone.name} · ${p.tunnelName}` : '' })}${field('记录名称', 'name', d.name, { required: true, placeholder: '例如：Image Gallery' })}${!d.id ? field('快捷填入子域名', 'slug', d.slug, { placeholder: '例如：image', hint: '输入后自动补全下方两个域名，也可以手动修改。' }) : field('管理状态', 'management', d.imported ? '已导入 · 确认变更后启用自动维护' : '面板管理', { readonly: true })}${field('访问域名 · MAIN', 'publicHostname', d.publicHostname, { required: true, readonly: !!d.id, placeholder: `image.${p?.publicZone.name || 'b.com'}` })}${field('源域名 · ORIGIN', 'originHostname', d.originHostname, { required: true, readonly: !!d.id, placeholder: `image.${p?.sourceZone.name || 'a.com'}` })}${field('本地服务地址', 'service', d.service, { required: true, wide: true, placeholder: 'http://localhost:1111', hint: '这是 cloudflared 所在环境的地址。容器内的 localhost 与宿主机不是一回事。' })}${field('优选入口 · EDGE', 'edgeHostname', d.edgeHostname, { required: true, wide: true, hint: '指定已有优选域名。更改共享入口目标请到配置方案单独操作。' })}${selectField('DNS 切换时机', 'cutover', d.cutover, [{ value: 'when_ready', label: '推荐 · SaaS 主机名与备用源就绪后切换（不等待 SSL）' }, { value: 'immediate', label: '风险选项 · 配置写入后立即切换，可能短暂不可用' }], { required: true, wide: true })}<label class="field wide"><span>备注</span><textarea id="field-note" name="note" rows="2" maxlength="500" placeholder="用途、设备或需要记住的事项…">${d.note || ''}</textarea></label></div><details class="form-section"><summary>高级回源参数 · originRequest</summary><label class="field wide"><span>JSON 对象</span><textarea id="field-originRequestJSON" name="originRequestJSON" rows="6" spellcheck="false" placeholder='{"httpHostHeader":"example.internal"}'>${d.originRequestJSON || ''}</textarea><small>留空保留已有参数。输入 {} 可清空这两条规则的参数；其它规则和全局配置不会被修改。HTTPS 默认不关闭证书校验。</small></label></details>`, formButtons('生成变更预览', 'arrow'), { form: 'route' });
}
function planModal() {
  const p = S.modal.plan, d = S.draft, destructive = p.type === 'delete';
  const title = destructive ? '确认删除云端资源' : '检查变更，确认后再执行';
  return modalFrame(title, `这份预览有效至 ${date(p.expiresAt)}。写入前还会重新核对远端状态。`, html`${p.type === 'route' ? wizard(2) : ''}<div class="route-summary"><div><small>${p.type === 'edge' ? '共享入口' : '访问域名'}</small><strong>${p.spec.publicHostname}</strong></div>${ic('arrow')}<div><small>${destructive ? '操作' : p.type === 'edge' ? '新的 CNAME 目标' : '本地服务 / 目标'}</small><strong>${destructive ? '删除该记录的云端资源' : p.spec.service || p.spec.edgeTarget || p.spec.originHostname || '撤销本次变更'}</strong></div></div>${p.warnings?.map(w => notice(w, destructive ? 'red' : 'amber'))}<div class="plan-list">${p.actions.map((a, i) => actionView(a, i))}</div>${!p.actions.length ? notice('已知配置全部一致。执行后仍会核对 SaaS 状态，并按需要补充 Cloudflare 返回的验证记录。', 'blue') : ''}${p.type === 'route' ? html`<div class="dynamic-note">${ic('info')} 所有权 / 证书验证值可能在提交后才生成。SSL pending_validation 会显示，但不阻断默认访问 DNS 切换。</div>` : ''}<div class="form-section">${checkbox('acknowledge', destructive ? '我已检查将被删除的云端资源' : '我已检查变更与影响范围', destructive ? '删除不可一键撤销。共享入口与 Fallback 不会随单条记录删除。' : '这会修改 Cloudflare 配置；普通变更无需再手输一遍域名。', d.acknowledge)}${destructive ? field('输入完整访问域名确认云端删除', 'confirmHostname', d.confirmHostname, { required: true, placeholder: p.spec.publicHostname, wide: true }) : ''}</div>`, html`${button('取消', 'close', '', 'btn', 'type="button"')}${submitButton(destructive ? '确认删除云端资源' : '确认并开始执行', destructive ? 'trash' : 'play', destructive ? 'danger' : 'primary')}`, { form: 'apply' });
}
function actionView(a, i) {
  return html`<div class="plan-step"><div class="plan-step-head">${ic(a.state === 'done' ? 'check' : a.phase === 'cutover' ? 'clock' : 'spark')}<strong>${i + 1}. ${a.label}</strong>${badge(a.state === 'done' ? '已完成' : a.state === 'writing' ? '核对写入' : a.phase === 'cutover' ? '验证后执行' : a.before ? '更新' : '新增', a.state === 'done' ? 'blue' : 'pink')}</div>${a.notice ? notice(a.notice, 'amber') : ''}<details><summary>查看配置差异</summary><div class="diff"><div><small>BEFORE · 变更前</small><pre>${pretty(a.before?.value ?? a.before)}</pre></div><div><small>AFTER · 变更后</small><pre>${pretty(a.after)}</pre></div></div></details></div>`;
}
function detailModal() {
  const r = byId('routes', S.modal.id); if (!r) return modalFrame('记录不存在', '', empty('这条记录已移除', '关闭后刷新工作区。'), button('关闭', 'close'), { drawer: true });
  const p = profileOf(r), o = r.observed || {}, j = jobOf(r), live = liveOf(r);
  const nodes = [['MAIN · 访问域名', live.publicHostname, 'globe'], ['EDGE · 优选入口', live.edgeHostname, 'spark'], ['ORIGIN · SaaS 自定义回源', live.originHostname, 'cloud'], [p?.tunnelName || 'Tunnel', live.service, 'server']];
  const sslValue = o.sslStatus && o.sslStatus !== 'active' ? `${o.sslStatus} · 不阻断入口` : o.sslStatus || '未检查';
  return modalFrame(r.name, '下方路径与状态来自最近一次 Cloudflare 同步。', html`<div class="detail-badges">${routeBadge(stateOf(r))}${badge(r.imported ? '已导入' : '面板创建', 'neutral')}${r.remote ? badge(`远端 · ${ago(r.remote.syncedAt)}`, 'blue', 'refresh') : badge('等待远端同步', 'neutral')}</div><div class="detail-flow">${nodes.map(([label, value, glyph], i) => html`<div class="detail-node"><div class="detail-node-icon ${i % 2 ? 'pink' : ''}">${ic(glyph)}</div><div class="detail-node-body"><small>${label}</small><strong>${value}</strong></div>${iconButton('复制', 'copy', 'copy', value)}</div>`)}</div>${j ? notice(html`<strong>${j.step}</strong><br>${j.error?.message || '服务端会继续推进任务，无需保持此页面打开。'}`, j.status === 'failed' ? 'red' : 'pink') : ''}<section class="detail-section"><h3>状态与诊断 <small>${ago(o.checkedAt)}</small></h3><div class="diagnostics">${diagnostic('Tunnel 连接', o.tunnelStatus || '未检查', o.tunnelStatus !== 'healthy')}${diagnostic('SaaS 主机名', o.hostnameStatus || '未检查', o.hostnameStatus !== 'active')}${diagnostic('SSL 证书', sslValue, false)}${diagnostic('SaaS 备用源', o.fallbackStatus || '未检查', o.fallbackStatus !== 'active')}${diagnostic('访问 DNS', o.dnsReady ? '已指向 DNS-only 优选入口' : '与管理映射不一致', !o.dnsReady)}${diagnostic('本地服务可达性', '未探测 · 请在实际访问端验证', false)}</div>${o.error ? notice(o.error, 'red') : ''}${o.drift?.map(x => notice(x, 'amber', '检测到远端变化'))}${o.validationErrors?.map(e => notice(e.message || String(e), 'amber', 'SSL 验证提示 · 不阻断入口'))}${o.hostnameErrors?.map(e => notice(typeof e === 'string' ? e : e.message, 'amber', '主机名验证提示'))}</section><section class="detail-section"><h3>记录信息</h3><dl class="detail-meta"><dt>配置方案</dt><dd>${p?.name || '—'}</dd><dt>切换策略</dt><dd>${r.cutover === 'immediate' ? '立即切换（风险选项）' : '主机名 + Fallback 就绪后切换，不等待 SSL'}</dd><dt>证书到期</dt><dd>${date(o.expiresOn)}</dd><dt>最近远端同步</dt><dd>${date(r.lastRemoteSyncAt || r.remote?.syncedAt)}</dd><dt>备注</dt><dd>${r.note || '暂无备注'}</dd></dl></section>`, html`<button class="text-btn" data-action="detach" data-id="${r.id}">仅解除管理</button><button class="btn danger" data-action="delete-cloud" data-id="${r.id}">${ic('trash')}删除云端资源</button>${r.lastJobId ? html`<button class="btn" data-action="job" data-id="${r.lastJobId}">${ic('log')}任务</button>` : ''}<button class="btn" data-action="sync" data-id="${r.id}" ${disabled(S.busy)}>${ic('refresh')}同步</button><button class="btn primary" data-action="edit-route" data-id="${r.id}">${ic('edit')}编辑</button>`, { drawer: true });
}
function diagnostic(label, value, warn) { return html`<div class="diagnostic ${warn ? 'warn' : ''}">${ic(warn ? 'clock' : 'check')}<span>${label}</span><strong>${value}</strong></div>`; }
function jobModal() {
  const j = S.modal.job, isActive = ['queued', 'running', 'waiting', 'retrying'].includes(j.status);
  return modalFrame(j.name || '执行任务', j.hostname, html`<div class="detail-badges">${jobBadge(j.status)}${badge(`${j.completed} / ${j.total} 步`, 'neutral')}</div>${notice(j.step, j.status === 'failed' ? 'red' : 'blue')}${j.error ? notice(`${j.error.message} [${j.error.code}]`, 'amber') : ''}${j.warnings?.map(w => notice(w, 'amber'))}<div class="plan-list">${j.actions?.map(actionView)}</div><dl class="detail-meta"><dt>提交时间</dt><dd>${date(j.createdAt)}</dd><dt>最近更新</dt><dd>${date(j.updatedAt)}</dd><dt>下次检查</dt><dd>${isActive ? date(j.nextAt) : '任务已停止'}</dd></dl>${notice('暂停不会撤回已完成的变更；撤销需要生成新预览。若远端已有更新，撤销将停止以保护更新后的配置。')}`, html`${button('刷新', 'refresh-job', 'refresh', 'btn', disabled(S.busy).toString())}${isActive ? button('暂停任务', 'pause-job', 'pause') : ['paused', 'failed'].includes(j.status) ? button('恢复任务', 'retry-job', 'play', 'btn primary') : ''}${!['rollback', 'delete'].includes(j.type) && ['done', 'paused', 'failed'].includes(j.status) ? button('预览撤销', 'rollback-job', 'undo', 'btn danger') : ''}`, { drawer: true });
}
function importModal() {
  return modalFrame('导入现有优选记录', '只读取和登记，不会修改 DNS、Tunnel 或 SaaS 配置。', html`${selectField('扫描配置方案', 'profileId', S.draft.profileId, optionize(S.data.profiles), { required: true, wide: true })}<div class="btn-row">${button('扫描 Cloudflare 配置', 'scan-import', 'search', 'btn soft', disabled(S.busy).toString())}</div>${S.modal.scanned ? S.candidates.length ? html`<div class="section-heading"><h3>识别到 ${S.candidates.length} 条候选</h3>${button('选择可导入项', 'select-import', '', 'text-btn')}</div>${S.candidates.map(c => html`<label class="candidate"><input type="checkbox" name="candidate" value="${c.publicHostname}" ${checked(S.selected.has(c.publicHostname))} ${disabled(!c.importable)}><div><strong>${c.publicHostname}</strong><p>${c.originHostname} → ${c.service}</p>${c.errors?.map(e => html`<small>${e}</small>`)}</div>${badge(c.importable ? '可导入' : '需手动核对', c.importable ? 'blue' : 'amber')}</label>`)}` : empty('没有新的可识别组合', '已管理的记录会跳过。只有 SaaS 回源、源 DNS 与两条 Tunnel 规则明确对应时才允许自动导入。', '', '', 'search') : notice('扫描范围是所选方案的源 Zone、访问 Zone 和 Tunnel。路径规则、不同本地服务、不同回源参数等有歧义的组合不会直接接管。')}`, html`${button('取消', 'close', '', 'btn', 'type="button"')}${submitButton(`导入 ${S.selected.size} 条记录`, 'download')}`, { form: 'import' });
}
function edgeModal() {
  const p = S.modal.profile;
  return modalFrame('修改共享优选入口', p.edgeHostname, html`${notice(`当前面板有 ${S.data.routes.filter(r => r.edgeHostname === p.edgeHostname).length} 条记录引用此入口。Cloudflare 中还可能有未导入的引用者；修改会一起生效。`, 'amber', '这不是单条记录的变更')}${field('新的 CNAME 目标', 'target', S.draft.target, { required: true, placeholder: '你选定的优选域名', wide: true })}${notice('只改变这一条 DNS-only CNAME。不会检测或保证新目标的直连速度，也不会自动改写其它 Zone 中的记录。')}`, formButtons('预览入口变更'), { form: 'edge', narrow: true });
}
function deleteModal() {
  const m = S.modal, route = m.category === 'routes';
  return modalFrame(route ? '仅解除面板管理' : '删除未使用的配置', m.label, html`${notice(route ? '只移除 Cloudlane 的本地管理映射；Cloudflare 上的 DNS、SaaS、证书和 Tunnel ingress 全部保留。需要真正删除云端资源，请在记录详情里使用「删除云端资源」。' : '只删除面板元数据。正在被方案、记录或任务引用的资源无法删除。', route ? 'blue' : 'amber')}${checkbox('confirmDelete', route ? '确认停止管理这条记录' : '确认删除这项面板配置', route ? '这是本地操作，不要求重复输入域名。' : '不会删除任何 Cloudflare 资源。', S.draft.confirmDelete)}`, html`${button('取消', 'close', '', 'btn', 'type="button"')}${submitButton(route ? '解除管理' : '删除面板配置', 'trash', route ? 'primary' : 'danger')}`, { form: 'delete', narrow: true });
}


async function startCredential(id) { openModal('credential', id ? { ...byId('credentials', id), token: '' } : {}); }
async function startProfile(id) {
  if (!S.data.credentials.length) { toast('先添加 API 凭据，再创建配置方案。'); return startCredential(); }
  const old = id && byId('profiles', id), first = S.data.credentials[0].id;
  const draft = old ? { ...old, sourceZoneId: old.sourceZone.id, publicZoneId: old.publicZone.id } : { sourceCredentialId: first, publicCredentialId: first, validationMode: 'auto', initializeFallback: false };
  openModal('profile', draft);
  await work(async () => { await Promise.all([...new Set([draft.sourceCredentialId, draft.publicCredentialId])].map(x => catalog(x))); });
}
function startRoute(id) {
  if (!S.data.profiles.length) { toast('先创建配置方案，再添加记录。'); return startProfile(); }
  const old = id && byId('routes', id), p = S.data.profiles.find(x => x.id === S.filterProfile) || S.data.profiles[0];
  openModal('route', old ? { ...old, service: old.remote?.service || old.service, edgeHostname: old.remote?.edgeHostname || old.edgeHostname, originRequest: old.remote?.originRequest ?? old.originRequest, originRequestJSON: (old.remote?.originRequest ?? old.originRequest) === undefined ? '' : pretty(old.remote?.originRequest ?? old.originRequest) } : { profileId: p.id, edgeHostname: p.edgeHostname, service: 'http://localhost:', cutover: 'when_ready', slug: '', name: '', publicHostname: '', originHostname: '' });
}
function startImport(profileId) {
  if (!S.data.profiles.length) { toast('先选择好账户、Zone 和 Tunnel。'); return startProfile(); }
  S.candidates = []; S.selected.clear(); openModal('import', { profileId: profileId || S.data.profiles[0].id }, { scanned: false });
}
async function showJob(id) { const job = await api(`/jobs/${id}`); openModal('job', {}, { job }); }
function showPlan(plan) { openModal('plan', { confirmHostname: '', acknowledge: false }, { plan }); }
async function doAction(action, target) {
  const id = target?.dataset.id;
  if (action === 'close') return closeModal();
  if (action === 'menu') { S.mobileMenu = !S.mobileMenu; return render(); }
  if (action === 'navigate') { S.page = id; S.mobileMenu = false; S.error = ''; return render(); }
  if (action === 'tab') { S.tab = id; return render(); }
  if (action === 'clear-filters') { S.tab = 'all'; S.search = ''; S.filterProfile = ''; return render(); }
  if (action === 'demo') { location.href = `${location.pathname}?demo=1`; return; }
  if (action === 'leave-demo') { if (window.CLOUDLANE_OFFLINE_DEMO) { S.page = 'help'; render(); toast('此文件是离线演示。请部署 ZIP 中的 Workers 项目后添加自己的凭据。'); } else location.href = location.pathname; return; }
  if (S.busy) return;
  if (action === 'new-credential' || action === 'edit-credential') return startCredential(id);
  if (action === 'new-profile' || action === 'edit-profile') return startProfile(id);
  if (action === 'new-route' || action === 'edit-route') return startRoute(id);
  if (action === 'detail') return openModal('detail', {}, { id });
  if (action === 'import' || action === 'import-profile') return startImport(id);
  if (action === 'edit-edge') { const profile = byId('profiles', id); return openModal('edge', { target: profile.edgeTarget }, { profile }); }
  if (action === 'delete-cloud') return work(async () => showPlan(await api(`/routes/${id}/delete-plan`, 'POST', {})));
  if (action === 'detach' || action.startsWith('delete-')) {
    const category = action === 'detach' ? 'routes' : action === 'delete-profile' ? 'profiles' : 'credentials', item = byId(category, id);
    return openModal('delete', {}, { id, category, label: item.publicHostname || item.name || item.label });
  }
  if (action === 'copy') { try { await navigator.clipboard.writeText(id); toast('已复制'); } catch { toast('浏览器未允许剪贴板访问，请手动选择文字复制。', true); } return; }
  if (action === 'visit') {
    if (S.demo) return toast('演示使用 .example 保留域名，不会打开真实服务。');
    const row = byId('routes', id), host = row ? liveOf(row).publicHostname : ''; if (host && /^[a-zA-Z0-9.-]+$/.test(host)) window.open(`https://${host}`, '_blank', 'noopener,noreferrer'); return;
  }
  if (action === 'select-import') { S.selected = new Set(S.candidates.filter(c => c.importable).map(c => c.publicHostname)); return render(); }
  if (action === 'refresh-state') return syncAllProfiles({ notify: true });
  await work(async () => {
    switch (action) {
      case 'refresh-state': await loadState(); break;
      case 'logout': await api('/logout', 'POST', {}); S.authenticated = false; S.data = { credentials: [], profiles: [], routes: [], jobs: [], events: [] }; S.draft = {}; S.catalogs = {}; break;
      case 'refresh-catalogs': for (const c of S.data.credentials) await catalog(c.id, true); toast('资源列表已更新'); break;
      case 'scan-import': {
        if (!S.draft.profileId) throw new Error('请选择扫描方案。');
        S.candidates = (await api(`/profiles/${S.draft.profileId}/discover`, 'POST', {})).candidates; S.selected = new Set(S.candidates.filter(c => c.importable).map(c => c.publicHostname)); S.modal.scanned = true; break;
      }
      case 'sync': await api(`/routes/${id}/sync`, 'POST', {}); await loadState(); toast('已重新检查云端配置'); break;
      case 'job': await showJob(id); break;
      case 'refresh-job': S.modal.job = await api(`/jobs/${S.modal.job.id}`); await loadState(); break;
      case 'pause-job': case 'retry-job': await api(`/jobs/${S.modal.job.id}/${action === 'pause-job' ? 'pause' : 'retry'}`, 'POST', {}); S.modal.job = await api(`/jobs/${S.modal.job.id}`); await loadState(); break;
      case 'rollback-job': showPlan(await api(`/jobs/${S.modal.job.id}/rollback-plan`, 'POST', {})); break;
      case 'export': { const data = await api('/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `cloudlane-config-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast('已导出配置元数据，不包含密钥或可恢复的任务数据库。'); break; }
    }
  });
}
root.addEventListener('click', e => {
  const target = e.target.closest('[data-action]'); if (!target) return;
  e.preventDefault(); doAction(target.dataset.action, target).catch(e => { S.error = e.message; render(); toast(e.message, true); });
});
root.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'route-search') {
    S.search = el.value;
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(() => {
      if (!S.modal && document.activeElement?.id === 'route-search') render();
    }, 120);
    return;
  }
  const previousSlug = S.draft.slug;
  if (el.name && el.name !== 'candidate') S.draft[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  if (el.name === 'slug' && !S.draft.id) {
    const p = byId('profiles', S.draft.profileId), slug = el.value.trim().toLowerCase();
    if (p) {
      S.draft.publicHostname = slug ? `${slug}.${p.publicZone.name}` : '';
      S.draft.originHostname = slug ? `${slug}.${p.sourceZone.name}` : '';
      if (!S.draft.name || S.draft.name === previousSlug) S.draft.name = slug;
      // High-frequency typing must not rebuild the whole modal. Replacing the focused
      // input node on every keystroke causes visible flicker and cursor jumps in Chromium/WebKit.
      const form = el.closest('form');
      const publicInput = form?.querySelector('input[name="publicHostname"]');
      const originInput = form?.querySelector('input[name="originHostname"]');
      const nameInput = form?.querySelector('input[name="name"]');
      if (publicInput) publicInput.value = S.draft.publicHostname;
      if (originInput) originInput.value = S.draft.originHostname;
      if (nameInput && (!nameInput.value || nameInput.value === previousSlug)) nameInput.value = S.draft.name;
    }
  }
});
root.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'profile-filter') { S.filterProfile = el.value; return render(); }
  if (el.name === 'candidate') { el.checked ? S.selected.add(el.value) : S.selected.delete(el.value); return render(); }
  if (!el.name) return;
  S.draft[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  if (el.name === 'profileId' && S.modal?.kind === 'route') {
    const p = byId('profiles', el.value); if (p) { S.draft.edgeHostname = p.edgeHostname; if (S.draft.slug) { S.draft.originHostname = `${S.draft.slug}.${p.sourceZone.name}`; S.draft.publicHostname = `${S.draft.slug}.${p.publicZone.name}`; } } render();
  }
  if (el.name === 'profileId' && S.modal?.kind === 'import') { S.candidates = []; S.selected.clear(); S.modal.scanned = false; render(); }
  if (['sourceCredentialId', 'publicCredentialId'].includes(el.name)) {
    if (el.name === 'sourceCredentialId') { S.draft.sourceZoneId = ''; S.draft.tunnelId = ''; } else S.draft.publicZoneId = '';
    work(async () => { await catalog(el.value); });
  }
  if (el.name === 'sourceZoneId' && !S.draft.edgeHostname) { const z = S.catalogs[S.draft.sourceCredentialId]?.zones.find(z => z.id === el.value); if (z) { S.draft.edgeHostname = `speed.${z.name}`; render(); } }
});
root.addEventListener('submit', e => {
  const form = e.target.closest('form[data-form]'); if (!form) return; e.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const draft = { ...S.draft, ...values };
  for (const el of form.querySelectorAll('input[type="checkbox"][name]')) if (el.name !== 'candidate') draft[el.name] = el.checked;
  const kind = form.dataset.form;
  work(async () => {
    if (kind === 'login') { await api('/login', 'POST', { password: draft.password }); S.authenticated = true; S.draft = {}; await loadState(); return; }
    if (kind === 'credential') { await api(`/credentials${draft.id ? `/${draft.id}` : ''}`, draft.id ? 'PUT' : 'POST', { label: draft.label, accountId: draft.accountId, token: draft.token || undefined }); S.catalogs = {}; S.draft.token = ''; }
    if (kind === 'profile') await api(`/profiles${draft.id ? `/${draft.id}` : ''}`, draft.id ? 'PUT' : 'POST', draft);
    if (kind === 'route') {
      let originRequest;
      if (draft.originRequestJSON?.trim()) { try { originRequest = JSON.parse(draft.originRequestJSON); } catch { throw new Error('originRequest 不是有效 JSON。'); } }
      return showPlan(await api('/plans', 'POST', { profileId: draft.profileId, routeId: draft.id, name: draft.name, publicHostname: draft.publicHostname, originHostname: draft.originHostname, edgeHostname: draft.edgeHostname, service: draft.service, originRequest, note: draft.note, cutover: draft.cutover, revalidate: draft.revalidate === true }));
    }
    if (kind === 'apply') {
      if (!draft.acknowledge) throw new Error('请先确认已检查变更与影响范围。');
      const destructive = S.modal.plan.type === 'delete';
      if (destructive && draft.confirmHostname !== S.modal.plan.spec.publicHostname) throw new Error('输入的域名与删除预览不一致。');
      const job = await api(`/plans/${S.modal.plan.id}/apply`, 'POST', { acknowledge: true, ...(destructive ? { confirmHostname: draft.confirmHostname } : {}) }); await loadState(); await showJob(job.id); toast(S.demo ? '演示执行完成，没有云端写入' : destructive ? '云端删除任务已提交' : '任务已提交，可在任务详情中跟踪'); return;
    }
    if (kind === 'import') { if (!S.selected.size) throw new Error('请先扫描并选择可导入的记录。'); await api(`/profiles/${draft.profileId}/import`, 'POST', { hostnames: [...S.selected] }); }
    if (kind === 'edge') return showPlan(await api(`/profiles/${S.modal.profile.id}/edge-plan`, 'POST', { target: draft.target }));
    if (kind === 'delete') { if (!draft.confirmDelete) throw new Error('请先勾选确认。'); await api(`/${S.modal.category}/${S.modal.id}`, 'DELETE', S.modal.category === 'routes' ? { confirmHostname: S.modal.label } : {}); }
    await loadState(); S.modal = null; S.draft = {}; S.error = '';
    if (kind === 'credential') {
      await syncAllProfiles();
      toast(S.syncError ? '凭据已保存；自动发现有项目需要检查' : '凭据已保存并完成 Cloudflare 同步', !!S.syncError);
      return;
    }
    toast(kind === 'import' ? '导入完成，没有修改 Cloudflare' : kind === 'delete' ? '面板记录已移除，Cloudflare 资源保留' : '已保存');
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (S.modal) closeModal(); else if (S.mobileMenu) { S.mobileMenu = false; render(); } }
  if (S.modal && e.key === 'Tab') {
    const nodes = [...document.querySelectorAll('[role="dialog"] button:not([disabled]),[role="dialog"] input:not([disabled]),[role="dialog"] select:not([disabled]),[role="dialog"] textarea:not([disabled]),[role="dialog"] summary')].filter(x => x.getClientRects().length);
    if (!nodes.length) return;
    if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0].focus(); }
  }
  if (!S.modal && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && S.authenticated) { e.preventDefault(); S.page = 'routes'; render(); document.getElementById('route-search')?.focus(); }
});
async function boot() {
  render();
  let syncAfterBoot = false;
  if (!S.demo) {
    try { const b = await api('/bootstrap'); S.configured = b.configured; S.setupError = b.setupError; S.authenticated = b.authenticated; if (S.authenticated) { await loadState(); syncAfterBoot = true; } }
    catch (e) { S.error = e.message; S.configured = false; }
    finally { S.loading = false; render(); }
    if (syncAfterBoot) syncAllProfiles();
  } else { S.lastLoaded = Date.now(); render(); }
}
setInterval(async () => {
  if (S.demo || !S.authenticated || S.busy || S.syncing || (S.modal && !['job', 'detail'].includes(S.modal.kind)) || document.hidden) return;
  const currentModal = S.modal;
  try {
    const state = await api('/state');
    if (S.busy || S.modal !== currentModal) return;
    S.data = state; S.lastLoaded = Date.now();
    if (S.modal?.kind === 'job') { const job = await api(`/jobs/${S.modal.job.id}`); if (S.modal !== currentModal || S.busy) return; S.modal.job = job; }
    render();
  } catch { /* retain last known state; explicit refresh exposes errors */ }
}, 20000);
setInterval(() => { if (!S.demo && S.authenticated && !S.busy && !S.syncing && !document.hidden && Date.now() - remoteStamp() > 300000) syncAllProfiles(); }, 300000);
boot();