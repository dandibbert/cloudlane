import { AppError, requireThat, validateRoute, equal, clone, id, now, mergeIngress, hostname, inZone, summarizeStatus } from './core.mjs';
import { dnsBody, customBody, dnsMatches } from './cloudflare.mjs';

const dnsPath = zone => `/zones/${zone}/dns_records`;
const customPath = zone => `/zones/${zone}/custom_hostnames`;
const tunnelPath = profile => `/accounts/${profile.accountId}/cfd_tunnel/${profile.tunnelId}/configurations`;
const mark = routeId => `cloudlane:${routeId}`;
export const mutation = (kind, label, credentialId, path, before, after, extra = {}) => ({
  id: id(), kind, label, credentialId, path, before, after,
  state: 'pending', ...extra
});
const valueMatches = (kind, value, expected) => {
  if (value === null || expected === null) return value === expected;
  if (kind === 'dns') return dnsMatches(value, expected) && Object.keys(expected).filter(k => !['type', 'name', 'content', 'proxied'].includes(k)).every(k => equal(value[k], expected[k]));
  if (kind === 'custom') return Object.keys(expected).every(k => equal(value[k], expected[k]));
  return equal(value, expected);
};

export async function planDNS(ctx, { credentialId, zoneId, name, content, proxied = false, type = 'CNAME', role = 'dns', routeId, allowChange = false, phase = 'setup' }) {
  const client = await ctx.client(credentialId);
  const rows = await client.dns(zoneId, name);
  const desired = { type, name, content, ttl: 1, ...(type === 'TXT' ? {} : { proxied }) };
  let existing;
  if (type === 'TXT') {
    requireThat(!rows.some(r => r.type === 'CNAME'), `${name} 已有 CNAME，不能同时写入 TXT；面板不会删除别人的验证记录。`, 409, 'DNS_CONFLICT');
    const same = rows.filter(r => dnsMatches(r, desired));
    requireThat(same.length <= 1, `${name} 存在重复 TXT 记录，请先合并。`, 409, 'DNS_CONFLICT');
    existing = same[0];
  } else {
    requireThat(rows.length <= 1 && (!rows.length || rows[0].type === 'CNAME'), `${name} 已有 A/AAAA/TXT/多条记录，不能安全替换为 CNAME。`, 409, 'DNS_CONFLICT');
    existing = rows[0];
  }
  if (existing && dnsMatches(existing, desired)) return null;
  requireThat(!existing || allowChange, `${name} 的现有 DNS 与目标不同，请先导入接管，或在入口管理中单独预览修改。`, 409, 'UNMANAGED_CONFLICT');
  const before = existing ? { id: existing.id, value: dnsBody(existing) } : null;
  const after = existing ? { ...dnsBody(existing), ...desired } : { ...desired, comment: mark(routeId) };
  return mutation('dns', `${type} · ${name}`, credentialId, dnsPath(zoneId), before, after, { zoneId, name, type, role, phase });
}

export async function validateProfileLive(ctx, profile) {
  const src = await ctx.client(profile.sourceCredentialId);
  const dst = await ctx.client(profile.publicCredentialId);
  const [sourceZone, publicZone, tunnel] = await Promise.all([
    src.get(`/zones/${profile.sourceZone.id}`), dst.get(`/zones/${profile.publicZone.id}`),
    src.get(`/accounts/${profile.accountId}/cfd_tunnel/${profile.tunnelId}`)
  ]);
  requireThat(sourceZone.name === profile.sourceZone.name && publicZone.name === profile.publicZone.name, 'Zone 信息发生变化，请重建配置方案。', 409, 'PROFILE_DRIFT');
  requireThat(sourceZone.account?.id === profile.accountId, '源 Zone 和 Tunnel 必须在同一个 Cloudflare 账户。', 409, 'ACCOUNT_MISMATCH');
  requireThat(sourceZone.status === 'active' && publicZone.status === 'active', '源 Zone 或访问 Zone 尚未激活。', 409, 'ZONE_NOT_ACTIVE');
  requireThat(!tunnel.deleted_at && (tunnel.remote_config === true || tunnel.config_src === 'cloudflare'), '只支持 remotely-managed Tunnel；本地 config.yml 不会被远程 API 覆盖。', 409, 'LOCAL_TUNNEL');
  return { sourceZone, publicZone, tunnel };
}

export async function checkEdge(ctx, profile, edgeHostname, route = null) {
  const src = await ctx.client(profile.sourceCredentialId);
  const seen = new Set(route ? [route.originHostname, route.publicHostname] : []);
  const chain = [];
  let current = edgeHostname;
  for (let hop = 0; hop < 12; hop++) {
    requireThat(!seen.has(current), `优选入口存在 CNAME 循环：${[...chain, current].join(' → ')}`, 409, 'DNS_LOOP');
    seen.add(current); chain.push(current);
    if (!inZone(current, profile.sourceZone.name)) return chain;
    const records = await src.dns(profile.sourceZone.id, current);
    requireThat(records.length > 0, `优选入口 ${current} 没有 DNS 记录。先到「配置方案」填写待创建的入口目标。`, 409, 'EDGE_MISSING');
    requireThat(!records.some(r => r.proxied), `优选链中的 ${current} 开启了橙云，无法保留优选 DNS 结果，请先在 Cloudflare 改为 DNS only。`, 409, 'EDGE_PROXIED');
    const cnames = records.filter(r => r.type === 'CNAME');
    if (!cnames.length) {
      requireThat(records.some(r => ['A', 'AAAA'].includes(r.type)), `${current} 不是可访问的 DNS 入口。`, 409, 'EDGE_INVALID');
      return chain;
    }
    requireThat(cnames.length === 1, `${current} 存在多条 CNAME。`, 409, 'DNS_CONFLICT');
    current = hostname(cnames[0].content);
  }
  throw new AppError('CNAME 链过长（超过 12 层），已停止。', 409, 'DNS_LOOP');
}

export async function buildRoutePlan(ctx, input, routeId = undefined) {
  const profile = await ctx.get(`profile:${input.profileId}`);
  requireThat(profile, '请选择有效的配置方案。', 404);
  const spec = validateRoute(input, profile);
  const previous = routeId ? await ctx.get(`route:${routeId}`) : null;
  requireThat(!routeId || previous, '记录不存在。', 404);
  if (previous) {
    requireThat(previous.profileId === spec.profileId && previous.originHostname === spec.originHostname && previous.publicHostname === spec.publicHostname, '编辑时不改变域名或 Tunnel 归属；迁移请新建记录，验证后再撤下旧记录。', 409, 'MIGRATION_REQUIRED');
  }
  const routes = await ctx.list('route:');
  requireThat(!routes.some(r => r.id !== routeId && (r.publicHostname === spec.publicHostname || r.originHostname === spec.originHostname)), '这个访问域名或源域名已被另一条记录管理。', 409, 'DUPLICATE_ROUTE');
  await ctx.ensureIdle(routeId, profile.tunnelId);
  const { tunnel } = await validateProfileLive(ctx, profile);
  const src = await ctx.client(profile.sourceCredentialId);
  const rid = routeId || id(), warnings = [], actions = [];
  const add = a => { if (a) actions.push(a); };
  if (tunnel.status !== 'healthy') warnings.push(`Tunnel 状态为 ${tunnel.status || 'unknown'}。这不代表本地服务可用，最终访问仍需从你的设备验证。`);
  const config = await src.get(tunnelPath(profile));
  const rules = [spec.originHostname, spec.publicHostname].map(h => ({ hostname: h, service: spec.service, ...(spec.originRequest === undefined ? {} : { originRequest: spec.originRequest }) }));
  const merged = mergeIngress(config.config, rules, !!previous);
  if (!equal(config.config, merged)) add(mutation('tunnel', '更新 2 条 Tunnel ingress（其它规则保持不变）', profile.sourceCredentialId, tunnelPath(profile), { id: profile.tunnelId, value: config.config }, merged, { phase: 'setup', role: 'tunnel', touchedHostnames: [spec.originHostname, spec.publicHostname] }));

  // If an entry is already configured, never overwrite it as a side effect of adding a route.
  const edgeRecords = await src.dns(profile.sourceZone.id, spec.edgeHostname);
  if (!edgeRecords.length && profile.edgeTarget && spec.edgeHostname === profile.edgeHostname) {
    const target = hostname(profile.edgeTarget);
    requireThat(![spec.publicHostname, spec.originHostname, spec.edgeHostname].includes(target), '优选入口目标形成循环。', 409, 'DNS_LOOP');
    if (inZone(target, profile.sourceZone.name)) await checkEdge(ctx, profile, target, { ...spec, originHostname: spec.edgeHostname });
    add(await planDNS(ctx, { credentialId: profile.sourceCredentialId, zoneId: profile.sourceZone.id, name: spec.edgeHostname, content: target, routeId: rid, role: 'shared_edge' }));
    warnings.push(`首次创建共享优选入口 ${spec.edgeHostname}。撤销某条记录不会删除共享入口。`);
  } else {
    const chain = await checkEdge(ctx, profile, spec.edgeHostname, spec);
    warnings.push(`入口链：${chain.join(' → ')}。外部优选服务的可用性与本地线路速度不由面板保证。`);
  }
  add(await planDNS(ctx, { credentialId: profile.sourceCredentialId, zoneId: profile.sourceZone.id, name: spec.originHostname, content: `${profile.tunnelId}.cfargotunnel.com`, proxied: true, routeId: rid, allowChange: !!previous, role: 'origin' }));

  let fallback;
  try { fallback = await src.get(`${customPath(profile.sourceZone.id)}/fallback_origin`); }
  catch (error) { if (error.status === 404) fallback = null; else throw error; }
  if (!fallback?.origin) {
    requireThat(profile.initializeFallback, 'SaaS 还没有 Fallback Origin。请在配置方案中允许初始化，或先在 Cloudflare 完成 SaaS 开通与备用源设置。', 409, 'FALLBACK_MISSING');
    const fallbackName = `cloudlane-fallback.${profile.sourceZone.name}`;
    add(await planDNS(ctx, { credentialId: profile.sourceCredentialId, zoneId: profile.sourceZone.id, name: fallbackName, content: `${profile.tunnelId}.cfargotunnel.com`, proxied: true, routeId: rid, role: 'shared_fallback' }));
    add(mutation('fallback', '初始化尚未设置的 SaaS 备用源', profile.sourceCredentialId, `${customPath(profile.sourceZone.id)}/fallback_origin`, null, { origin: fallbackName }, { role: 'shared_fallback', phase: 'setup' }));
    warnings.push('将初始化 Zone 级备用源，不覆盖已有备用源；共享备用源在撤销记录时保留。SaaS 套餐/计费开通仍需账户管理员在 Cloudflare 完成。');
  }
  const custom = await src.custom(profile.sourceZone.id, spec.publicHostname);
  const wantedCustom = { hostname: spec.publicHostname, custom_origin_server: spec.originHostname };
  if (!custom) {
    add(mutation('custom', '创建 SaaS 自定义主机名', profile.sourceCredentialId, customPath(profile.sourceZone.id), null, wantedCustom, {
      zoneId: profile.sourceZone.id, name: spec.publicHostname, role: 'custom', phase: 'setup',
      createBody: { ...wantedCustom, ssl: { method: 'txt', type: 'dv', ...(spec.publicHostname.length > 64 ? { cloudflare_branding: true } : {}), settings: { min_tls_version: '1.2' } } }
    }));
  } else if (custom.custom_origin_server !== spec.originHostname || input.revalidate === true) {
    requireThat(previous, '已有 SaaS 自定义主机名使用不同回源地址，请先检查并导入接管。', 409, 'UNMANAGED_CONFLICT');
    const before = customBody(custom), after = { ...before, custom_origin_server: spec.originHostname };
    const patchBody = { custom_origin_server: spec.originHostname };
    if (input.revalidate === true) {
      requireThat(custom.ssl?.method && custom.ssl?.type && !before.has_custom_certificate, '无法安全刷新：证书必须是有明确 method/type 的 Cloudflare 管理证书，而不是手工上传证书。', 409, 'VALIDATION_REFRESH_UNSUPPORTED');
      patchBody.ssl = { method: custom.ssl.method, type: custom.ssl.type };
      warnings.push('将以原 SSL method/type 发起一次 no-change PATCH，重新触发 Cloudflare 验证。此验证事件不可撤回，且不会自动修复 CAA、Zone hold 或外部 DNS。');
    }
    add(mutation('custom', input.revalidate === true ? '重新触发 SaaS 验证，保留原 method/type' : '仅更新 SaaS 自定义回源，保留证书设置', profile.sourceCredentialId, customPath(profile.sourceZone.id), { id: custom.id, value: before }, after, { zoneId: profile.sourceZone.id, name: spec.publicHostname, role: 'custom', phase: 'setup', patchBody, eventOnly: equal(before, after) }));
  }
  // Dynamic tokens are not yet available. Authorize only these exact DNS names, not arbitrary CF fields.
  let dcvSuffix = null;
  const acmeExisting = await (await ctx.client(profile.publicCredentialId)).dns(profile.publicZone.id, `_acme-challenge.${spec.publicHostname}`);
  const retainTXT = profile.validationMode === 'auto' && acmeExisting.some(r => r.type === 'TXT');
  if (retainTXT) warnings.push('已有 ACME TXT 记录：自动模式保留 TXT 验证，不把它强行替换成 DCV CNAME。');
  if (profile.validationMode !== 'txt' && !retainTXT) {
    try {
      const delegation = await src.get(`/zones/${profile.sourceZone.id}/dcv_delegation/uuid`);
      requireThat(typeof delegation?.uuid === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(delegation.uuid), 'Cloudflare 返回了未知的 DCV UUID 格式。', 502, 'DCV_FORMAT');
      dcvSuffix = `${delegation.uuid}.dcv.cloudflare.com`;
    } catch (error) {
      if (profile.validationMode === 'delegated' || ![403, 404].includes(error.status)) throw error;
      warnings.push('DCV Delegation 不可用，自动退回 TXT 验证；续期时保留本面板的定时维护。');
    }
  }
  if (dcvSuffix) {
    if (`${spec.publicHostname}.${dcvSuffix}`.length > 253) {
      requireThat(profile.validationMode !== 'delegated', '完整 DCV 委派目标超过 DNS 域名长度限制，请改用 TXT 验证。');
      dcvSuffix = null; warnings.push('访问域名较长，DCV 委派目标超过 DNS 长度限制，自动改用 TXT 验证。');
    }
  }
  if (dcvSuffix) {
    add(await planDNS(ctx, { credentialId: profile.publicCredentialId, zoneId: profile.publicZone.id, name: `_acme-challenge.${spec.publicHostname}`, content: `${spec.publicHostname}.${dcvSuffix}`, routeId: rid, role: 'dcv', phase: 'setup' }));
  } else {
    const dst = await ctx.client(profile.publicCredentialId);
    const acme = await dst.dns(profile.publicZone.id, `_acme-challenge.${spec.publicHostname}`);
    requireThat(!acme.some(r => r.type === 'CNAME'), '现有 ACME CNAME 与 TXT 验证冲突，请使用对应的 DCV Delegation，或先在 Cloudflare 检查该记录。', 409, 'DNS_CONFLICT');
  }
  const ownerRecords = await (await ctx.client(profile.publicCredentialId)).dns(profile.publicZone.id, `_cf-custom-hostname.${spec.publicHostname}`);
  requireThat(!ownerRecords.some(r => r.type === 'CNAME'), '主机名所有权验证处已有 CNAME，无法安全增加 TXT。', 409, 'DNS_CONFLICT');
  const publicDNS = await planDNS(ctx, { credentialId: profile.publicCredentialId, zoneId: profile.publicZone.id, name: spec.publicHostname, content: spec.edgeHostname, routeId: rid, allowChange: !!previous, phase: 'cutover', role: 'public' });
  add(publicDNS);
  if (spec.cutover === 'immediate') warnings.push('你选择了立即切换 DNS：证书签发前 HTTPS 可能无法访问。');
  if (spec.originRequest?.noTLSVerify) warnings.push('已明确开启 noTLSVerify：cloudflared 将不校验本地 HTTPS 服务证书。');
  warnings.push('所有权与证书验证状态会持续显示，但 SSL pending_validation 不再阻断默认 DNS 切换；默认只等待 SaaS 主机名 active 与备用源 active。');
  return { id: id(), type: 'route', createdAt: now(), expiresAt: now() + 600000, routeId: rid, profile: clone(profile), previous, spec, actions, warnings, dcvSuffix, jobId: null };
}

export async function readResource(ctx, action) {
  const client = await ctx.client(action.credentialId);
  if (action.kind === 'tunnel') {
    const value = await client.get(action.path);
    return { id: action.before?.id || '', value: value.config };
  }
  if (action.kind === 'fallback') {
    let row;
    try { row = await client.get(action.path); } catch (e) { if (e.status !== 404) throw e; }
    return row?.origin ? { id: 'fallback', value: { origin: row.origin } } : null;
  }
  if (action.kind === 'custom') {
    const row = await client.custom(action.zoneId, action.name);
    return row ? { id: row.id, value: customBody(row) } : null;
  }
  const rows = await client.dns(action.zoneId, action.name);
  if (action.before?.id) {
    const exact = rows.find(r => r.id === action.before.id);
    if (exact) return { id: exact.id, value: dnsBody(exact) };
    requireThat(!rows.length || action.type === 'TXT', `${action.name} 的 DNS ID 已变化，请重新预览。`, 409, 'STALE_PLAN');
  }
  if (action.type === 'TXT') {
    requireThat(!rows.some(r => r.type === 'CNAME'), `${action.name} 新出现了 CNAME 冲突。`, 409, 'STALE_PLAN');
    const desired = action.after || action.before?.value;
    const exact = rows.filter(r => dnsMatches(r, desired));
    requireThat(exact.length <= 1, '验证 TXT 出现重复值。', 409, 'STALE_PLAN');
    return exact[0] ? { id: exact[0].id, value: dnsBody(exact[0]) } : null;
  }
  requireThat(rows.length <= 1, `${action.name} 新出现了多条 DNS。`, 409, 'STALE_PLAN');
  return rows[0] ? { id: rows[0].id, value: dnsBody(rows[0]) } : null;
}

export async function applyAction(ctx, action, persist) {
  if (action.state === 'done') return;
  const current = await readResource(ctx, action);
  // Reconcile an interrupted response before resending. For DNS creation the unique comment is included.
  if (action.state === 'writing' && valueMatches(action.kind, current?.value || null, action.after)) {
    if (action.kind === 'custom' && action.before === null) {
      action.ownershipUncertain = true;
      action.notice = '响应中断后匹配到此主机名，但无法唯一确认创建者。继续验证，撤销时不会删除这个主机名。';
    }
    action.applied = current; action.state = 'done'; await persist(); return;
  }
  requireThat(equal(current, action.before), `${action.label} 自预览后已发生变化，已停止，未强制覆盖。请重新预览。`, 409, 'STALE_PLAN');
  action.state = 'writing'; await persist(); // write-ahead journal before any remote mutation
  const client = await ctx.client(action.credentialId);
  let result;
  if (action.kind === 'tunnel') result = await client.write(action.path, 'PUT', { config: action.after });
  else if (action.kind === 'fallback') result = await client.write(action.path, action.after ? 'PUT' : 'DELETE', action.after || undefined);
  else if (action.after === null) result = await client.write(`${action.path}/${action.before.id}`, 'DELETE');
  else if (action.before === null) result = await client.write(action.path, 'POST', action.createBody || action.after);
  else result = await client.write(`${action.path}/${action.before.id}`, 'PATCH', action.kind === 'custom' ? action.patchBody || { custom_origin_server: action.after.custom_origin_server } : action.after);
  // Store the server-normalized state; rollback must compare against this exact state.
  if (action.after === null) action.applied = null;
  else if (action.kind === 'tunnel') action.applied = { id: action.before.id, value: result.config || action.after };
  else if (action.kind === 'fallback') action.applied = { id: 'fallback', value: { origin: result.origin } };
  else action.applied = { id: result.id, value: action.kind === 'dns' ? dnsBody(result) : customBody(result) };
  requireThat(action.after === null || !!action.applied?.id, 'Cloudflare 未返回资源 ID；保留写入中状态，稍后核对。', 502, 'CF_RESPONSE');
  action.state = 'done'; await persist();
}

export async function validationActions(ctx, job) {
  const { profile, spec } = job.plan;
  const src = await ctx.client(profile.sourceCredentialId);
  const custom = await src.custom(profile.sourceZone.id, spec.publicHostname);
  requireThat(custom, 'SaaS 自定义主机名不存在。', 409, 'CUSTOM_MISSING');
  requireThat(custom.custom_origin_server === spec.originHostname, 'SaaS 自定义回源被外部修改，验证已停止。', 409, 'CUSTOM_DRIFT');
  const candidates = [];
  const owner = custom.ownership_verification;
  if (owner?.type?.toLowerCase() === 'txt' && owner.name && owner.value) {
    const name = hostname(owner.name, true);
    requireThat(name === `_cf-custom-hostname.${spec.publicHostname}`, 'Cloudflare 返回非预期所有权验证名称；停止自动 DNS 写入。', 409, 'VALIDATION_SCOPE');
    candidates.push({ name, content: owner.value });
  }
  if (!job.plan.dcvSuffix) {
    for (const record of custom.ssl?.validation_records || []) {
      if (!record.txt_name || !record.txt_value) continue;
      const name = hostname(record.txt_name, true);
      requireThat(name === `_acme-challenge.${spec.publicHostname}`, 'Cloudflare 返回非预期证书验证名称；停止自动 DNS 写入。', 409, 'VALIDATION_SCOPE');
      candidates.push({ name, content: record.txt_value });
    }
  }
  const actions = [];
  for (const candidate of candidates) {
    const action = await planDNS(ctx, { ...candidate, credentialId: profile.publicCredentialId, zoneId: profile.publicZone.id, routeId: job.plan.routeId, type: 'TXT', role: 'validation', phase: 'validation' });
    if (action && !actions.some(a => equal(a.after, action.after))) actions.push(action);
  }
  return { actions, custom };
}

export async function observe(ctx, route, profile) {
  const src = await ctx.client(profile.sourceCredentialId), dst = await ctx.client(profile.publicCredentialId);
  const [config, tunnel, sourceDNS, publicDNS, custom, fallback] = await Promise.all([
    src.get(tunnelPath(profile)), src.get(`/accounts/${profile.accountId}/cfd_tunnel/${profile.tunnelId}`),
    src.dns(profile.sourceZone.id, route.originHostname), dst.dns(profile.publicZone.id, route.publicHostname),
    src.custom(profile.sourceZone.id, route.publicHostname),
    src.get(`${customPath(profile.sourceZone.id)}/fallback_origin`).catch(e => { if (e.status === 404) return null; throw e; })
  ]);
  const drift = [];
  for (const host of [route.originHostname, route.publicHostname]) {
    const matches = (config.config?.ingress || []).filter(r => r.hostname === host);
    if (matches.length !== 1 || matches[0]?.path || matches[0]?.service !== route.service || (route.originRequest !== undefined && !equal(matches[0]?.originRequest || {}, route.originRequest))) drift.push(`Tunnel 规则不一致：${host}`);
  }
  if (sourceDNS.length !== 1 || !dnsMatches(sourceDNS[0], { type: 'CNAME', name: route.originHostname, content: `${profile.tunnelId}.cfargotunnel.com`, proxied: true })) drift.push('源域名的 CNAME/橙云配置不一致');
  if (!custom || custom.custom_origin_server !== route.originHostname) drift.push('SaaS 自定义回源不一致或已删除');
  if (fallback?.status !== 'active') drift.push(`SaaS 备用源尚未就绪：${fallback?.status || 'missing'}`);
  const dnsReady = publicDNS.length === 1 && dnsMatches(publicDNS[0], { type: 'CNAME', name: route.publicHostname, content: route.edgeHostname, proxied: false });
  if (!dnsReady && !route.pendingJobId) drift.push('访问域名未指向预期优选入口，或被开启橙云');
  let edgeChain = [];
  try { edgeChain = await checkEdge(ctx, profile, route.edgeHostname, route); } catch (error) { drift.push(error.message); }
  const result = { checkedAt: now(), tunnelStatus: tunnel.status, hostnameStatus: custom?.status || 'missing', sslStatus: custom?.ssl?.status || 'missing', fallbackStatus: fallback?.status || 'missing', dnsReady, drift, edgeChain, validationErrors: custom?.ssl?.validation_errors || [], hostnameErrors: custom?.verification_errors || [], expiresOn: custom?.ssl?.expires_on || null, originReachability: 'not_tested' };
  result.status = summarizeStatus(result, !!route.pendingJobId);
  return result;
}


const cleanDNSName = value => String(value || '').replace(/\.$/, '').toLowerCase();
const matchingIngress = (config, host) => (config?.ingress || []).filter(r => cleanDNSName(r.hostname) === cleanDNSName(host));

async function profileSnapshot(ctx, profile) {
  const src = await ctx.client(profile.sourceCredentialId), dst = await ctx.client(profile.publicCredentialId);
  const { tunnel } = await validateProfileLive(ctx, profile);
  const [config, customs, sourceRecords, publicRecords, fallback] = await Promise.all([
    src.get(tunnelPath(profile)),
    src.list(customPath(profile.sourceZone.id)),
    src.list(dnsPath(profile.sourceZone.id)),
    dst.list(dnsPath(profile.publicZone.id)),
    src.get(`${customPath(profile.sourceZone.id)}/fallback_origin`).catch(e => { if (e.status === 404) return null; throw e; })
  ]);
  return { src, dst, tunnel, config, customs, sourceRecords, publicRecords, fallback };
}

function candidateFromSnapshot(profile, snap, ch, managed) {
  const main = matchingIngress(snap.config.config, ch.hostname);
  const origin = matchingIngress(snap.config.config, ch.custom_origin_server);
  if (!main.length && !origin.length) return null;
  const errors = [];
  if (managed.some(r => r.originHostname === ch.custom_origin_server) || snap.customs.filter(c => c.custom_origin_server === ch.custom_origin_server).length > 1) errors.push('源域名被多条记录共享，需要人工确认所有权');
  if (main.length !== 1 || origin.length !== 1 || main[0]?.path || origin[0]?.path) errors.push('缺少成对规则，或存在路径/重复规则');
  if (main[0]?.service !== origin[0]?.service) errors.push('两个 hostname 对应不同服务');
  if (!equal(main[0]?.originRequest || {}, origin[0]?.originRequest || {})) errors.push('两个 hostname 的 originRequest 不同，需要人工确认');
  const originDNS = snap.sourceRecords.filter(r => cleanDNSName(r.name) === cleanDNSName(ch.custom_origin_server));
  if (originDNS.length !== 1 || !dnsMatches(originDNS[0], { type: 'CNAME', name: ch.custom_origin_server, content: `${profile.tunnelId}.cfargotunnel.com`, proxied: true })) errors.push('源 DNS 未指向选中的 Tunnel（或未开启橙云）');
  const publicDNS = snap.publicRecords.filter(r => cleanDNSName(r.name) === cleanDNSName(ch.hostname));
  let edge = profile.edgeHostname;
  if (publicDNS.length === 1 && publicDNS[0].type === 'CNAME' && !publicDNS[0].proxied) edge = cleanDNSName(publicDNS[0].content);
  const spec = { profileId: profile.id, name: ch.hostname.split('.')[0], originHostname: cleanDNSName(ch.custom_origin_server), publicHostname: cleanDNSName(ch.hostname), edgeHostname: edge, service: origin[0]?.service || main[0]?.service || '', originRequest: origin[0]?.originRequest ?? main[0]?.originRequest, cutover: 'when_ready' };
  try { validateRoute(spec, profile); } catch (e) { errors.push(e.message); }
  return { ...spec, errors, hostnameStatus: ch.status, sslStatus: ch.ssl?.status, importable: !errors.length };
}

/**
 * Refresh one profile from Cloudflare in a single bounded snapshot. Local route rows are only
 * mappings/preferences; service/origin/edge/status shown by the UI are refreshed from this snapshot.
 * A per-profile endpoint is used so multiple profiles do not accumulate into one Worker subrequest burst.
 */
export async function syncProfileRoutes(ctx, profile) {
  const snap = await profileSnapshot(ctx, profile);
  const allManaged = await ctx.list('route:');
  const managed = allManaged.filter(r => r.profileId === profile.id);
  const customsByHost = new Map(snap.customs.map(c => [cleanDNSName(c.hostname), c]));
  const checkedAt = now();

  for (const route of managed) {
    if (route.pendingJobId) continue; // job state owns the in-flight snapshot
    const custom = customsByHost.get(cleanDNSName(route.publicHostname));
    const currentOrigin = cleanDNSName(custom?.custom_origin_server || route.originHostname);
    const main = matchingIngress(snap.config.config, route.publicHostname);
    const origin = matchingIngress(snap.config.config, route.originHostname);
    const liveOrigin = matchingIngress(snap.config.config, currentOrigin);
    const sourceDNS = snap.sourceRecords.filter(r => cleanDNSName(r.name) === cleanDNSName(route.originHostname));
    const publicDNS = snap.publicRecords.filter(r => cleanDNSName(r.name) === cleanDNSName(route.publicHostname));
    const livePublicCname = publicDNS.length === 1 && publicDNS[0].type === 'CNAME' && !publicDNS[0].proxied ? cleanDNSName(publicDNS[0].content) : null;
    const drift = [];
    if (main.length !== 1 || main[0]?.path) drift.push(`Tunnel 访问域名规则异常：${route.publicHostname}`);
    if (origin.length !== 1 || origin[0]?.path) drift.push(`Tunnel 源域名规则异常：${route.originHostname}`);
    if (main.length === 1 && origin.length === 1 && main[0].service !== origin[0].service) drift.push('两条 Tunnel 规则当前指向不同服务');
    if (!custom) drift.push('SaaS 自定义主机名已删除');
    else if (currentOrigin !== cleanDNSName(route.originHostname)) drift.push(`SaaS 回源已改为 ${currentOrigin}`);
    if (sourceDNS.length !== 1 || !dnsMatches(sourceDNS[0], { type: 'CNAME', name: route.originHostname, content: `${profile.tunnelId}.cfargotunnel.com`, proxied: true })) drift.push('源域名 CNAME / 橙云与当前 Tunnel 不一致');
    const dnsReady = publicDNS.length === 1 && dnsMatches(publicDNS[0], { type: 'CNAME', name: route.publicHostname, content: route.edgeHostname, proxied: false });
    if (!dnsReady) drift.push(livePublicCname ? `访问 DNS 当前指向 ${livePublicCname}` : '访问 DNS 不再是预期的 DNS-only CNAME');
    if (snap.fallback?.status !== 'active') drift.push(`SaaS 备用源状态：${snap.fallback?.status || 'missing'}`);

    const remote = {
      syncedAt: checkedAt,
      publicHostname: cleanDNSName(route.publicHostname),
      originHostname: currentOrigin,
      edgeHostname: livePublicCname || route.edgeHostname,
      service: liveOrigin[0]?.service || main[0]?.service || origin[0]?.service || route.service,
      originRequest: liveOrigin[0]?.originRequest ?? main[0]?.originRequest ?? origin[0]?.originRequest,
      publicDnsType: publicDNS[0]?.type || 'missing',
      publicDnsProxied: publicDNS[0]?.proxied ?? null
    };
    const observed = {
      checkedAt,
      tunnelStatus: snap.tunnel.status,
      hostnameStatus: custom?.status || 'missing',
      sslStatus: custom?.ssl?.status || 'missing',
      fallbackStatus: snap.fallback?.status || 'missing',
      dnsReady,
      drift,
      edgeChain: livePublicCname ? [livePublicCname] : [],
      validationErrors: custom?.ssl?.validation_errors || [],
      hostnameErrors: custom?.verification_errors || [],
      expiresOn: custom?.ssl?.expires_on || null,
      originReachability: 'not_tested'
    };
    observed.status = summarizeStatus(observed, false);
    route.remote = remote;
    route.observed = observed;
    route.lastRemoteSyncAt = checkedAt;
    route.nextCheckAt = now() + 21600000;
    await ctx.put(`route:${route.id}`, route);
  }

  const unmanaged = [];
  for (const ch of snap.customs) {
    if (!ch.hostname || !ch.custom_origin_server || !inZone(cleanDNSName(ch.hostname), profile.publicZone.name) || !inZone(cleanDNSName(ch.custom_origin_server), profile.sourceZone.name)) continue;
    if (allManaged.some(r => cleanDNSName(r.publicHostname) === cleanDNSName(ch.hostname))) continue;
    const candidate = candidateFromSnapshot(profile, snap, ch, allManaged);
    if (candidate) unmanaged.push(candidate);
  }
  await ctx.put(`discovery:${profile.id}`, { profileId: profile.id, checkedAt, candidates: unmanaged });
  return { profileId: profile.id, checkedAt, routes: managed.length, discovered: unmanaged.length };
}

async function deleteExactDNS(client, credentialId, zoneId, desired, label, role) {
  const rows = await client.dns(zoneId, desired.name);
  const matches = rows.filter(r => dnsMatches(r, desired));
  requireThat(matches.length <= 1, `${desired.name} 存在重复目标记录，删除已停止。`, 409, 'DNS_CONFLICT');
  if (!matches.length) return null;
  const row = matches[0];
  return mutation('dns', label, credentialId, dnsPath(zoneId), { id: row.id, value: dnsBody(row) }, null, { zoneId, name: desired.name, type: desired.type, role, phase: 'setup' });
}

export async function buildDeletePlan(ctx, routeId) {
  const route = await ctx.get(`route:${routeId}`);
  requireThat(route, '记录不存在。', 404);
  const profile = await ctx.get(`profile:${route.profileId}`);
  requireThat(profile, '配置方案不存在，无法安全定位云端资源。', 409, 'PROFILE_MISSING');
  await ctx.ensureIdle(route.id, profile.tunnelId);
  const snap = await profileSnapshot(ctx, profile);
  const actions = [], warnings = [];
  const add = action => { if (action) actions.push(action); };
  const custom = snap.customs.find(c => cleanDNSName(c.hostname) === cleanDNSName(route.publicHostname));
  const otherOriginUsers = snap.customs.filter(c => cleanDNSName(c.hostname) !== cleanDNSName(route.publicHostname) && cleanDNSName(c.custom_origin_server) === cleanDNSName(route.originHostname));
  const sharedOrigin = otherOriginUsers.length > 0;

  if (custom) {
    requireThat(cleanDNSName(custom.custom_origin_server) === cleanDNSName(route.originHostname), `SaaS 主机名当前回源 ${custom.custom_origin_server}，与记录映射不同。请先同步并检查后再删除。`, 409, 'DELETE_DRIFT');
    const owner = custom.ownership_verification;
    if (owner?.type?.toLowerCase() === 'txt' && owner.name && owner.value) {
      const ownerName = hostname(owner.name, true);
      if (ownerName === `_cf-custom-hostname.${route.publicHostname}`) add(await deleteExactDNS(snap.dst, profile.publicCredentialId, profile.publicZone.id, { type: 'TXT', name: ownerName, content: owner.value }, '删除主机名所有权 TXT', 'delete_validation'));
    }
    for (const record of custom.ssl?.validation_records || []) {
      if (!record.txt_name || !record.txt_value) continue;
      const name = hostname(record.txt_name, true);
      if (name === `_acme-challenge.${route.publicHostname}`) add(await deleteExactDNS(snap.dst, profile.publicCredentialId, profile.publicZone.id, { type: 'TXT', name, content: record.txt_value }, '删除证书验证 TXT', 'delete_validation'));
    }
  }
  if (route.dcvSuffix) {
    const name = `_acme-challenge.${route.publicHostname}`, content = `${route.publicHostname}.${route.dcvSuffix}`;
    add(await deleteExactDNS(snap.dst, profile.publicCredentialId, profile.publicZone.id, { type: 'CNAME', name, content, proxied: false }, '删除 DCV Delegation CNAME', 'delete_validation'));
  }

  const publicRows = snap.publicRecords.filter(r => cleanDNSName(r.name) === cleanDNSName(route.publicHostname));
  if (publicRows.length === 1 && publicRows[0].type === 'CNAME') {
    const row = publicRows[0];
    add(mutation('dns', '删除访问域名 CNAME', profile.publicCredentialId, dnsPath(profile.publicZone.id), { id: row.id, value: dnsBody(row) }, null, { zoneId: profile.publicZone.id, name: route.publicHostname, type: row.type, role: 'delete_public', phase: 'setup' }));
    if (cleanDNSName(row.content) !== cleanDNSName(route.edgeHostname)) warnings.push(`访问 DNS 已改为 ${row.content}；删除预览按当前远端值显示，执行前仍会再次核对。`);
  } else if (publicRows.length) {
    warnings.push('访问域名当前不是唯一 CNAME；为避免删除后来添加的其它记录，删除计划会保留这些 DNS。');
  }

  if (custom) add(mutation('custom', '删除 SaaS Custom Hostname（Cloudflare 会同时删除其证书）', profile.sourceCredentialId, customPath(profile.sourceZone.id), { id: custom.id, value: customBody(custom) }, null, { zoneId: profile.sourceZone.id, name: route.publicHostname, role: 'delete_custom', phase: 'setup' }));

  if (!sharedOrigin) {
    add(await deleteExactDNS(snap.src, profile.sourceCredentialId, profile.sourceZone.id, { type: 'CNAME', name: route.originHostname, content: `${profile.tunnelId}.cfargotunnel.com`, proxied: true }, '删除源域名 Tunnel CNAME', 'delete_origin'));
  } else {
    warnings.push(`源域名仍被 ${otherOriginUsers.length} 个 SaaS 主机名共享；保留源 DNS 和对应 Tunnel ingress。`);
  }

  const removeHosts = [route.publicHostname, ...(!sharedOrigin ? [route.originHostname] : [])];
  const afterConfig = clone(snap.config.config);
  for (const host of removeHosts) {
    const matches = (afterConfig.ingress || []).map((r, i) => cleanDNSName(r.hostname) === cleanDNSName(host) ? i : -1).filter(i => i >= 0);
    requireThat(matches.length <= 1 && !matches.some(i => afterConfig.ingress[i]?.path), `${host} 当前有路径规则或重复规则，不能自动删除。`, 409, 'DELETE_INGRESS_CONFLICT');
    if (matches.length === 1) afterConfig.ingress.splice(matches[0], 1);
  }
  if (!equal(afterConfig, snap.config.config)) add(mutation('tunnel', `移除 ${removeHosts.length} 条 Tunnel ingress（其它规则保持不变）`, profile.sourceCredentialId, tunnelPath(profile), { id: profile.tunnelId, value: snap.config.config }, afterConfig, { role: 'delete_tunnel', phase: 'setup', touchedHostnames: removeHosts }));

  requireThat(actions.length > 0, '远端已经没有可明确归属于这条记录的资源。可以直接解除面板管理。', 409, 'NOTHING_TO_DELETE');
  warnings.unshift('这是云端删除：访问 DNS、SaaS Custom Hostname、专属源 DNS 与两条精确 Tunnel ingress 会按预览删除。共享优选入口与 SaaS Fallback Origin 永远不会随单条记录删除。');
  return { id: id(), type: 'delete', createdAt: now(), expiresAt: now() + 600000, routeId: route.id, profile: clone(profile), previous: clone(route), spec: { ...clone(route), ...(route.remote || {}) }, actions, warnings, jobId: null };
}

export async function buildRollbackPlan(ctx, original) {
  requireThat(original && ['done', 'failed', 'paused', 'cancelled'].includes(original.status), '只有已结束、失败或暂停的任务可以预览撤销。', 409);
  requireThat(!['rollback', 'delete'].includes(original.plan.type), original.plan.type === 'delete' ? '云端删除任务不能一键撤销；需要恢复时请重新创建或导入记录。' : '撤销任务不能再次撤销；需要重新配置时请生成新的记录变更。', 409, 'ROLLBACK_OF_ROLLBACK');
  const currentProfile = await ctx.get(`profile:${original.plan.profile.id}`);
  requireThat(currentProfile, '原配置方案已移除，无法安全撤销。', 409, 'PROFILE_MISSING');
  for (const key of ['sourceCredentialId', 'publicCredentialId', 'accountId', 'sourceZone', 'publicZone', 'tunnelId']) requireThat(equal(currentProfile[key], original.plan.profile[key]), '原配置方案的资源归属已改变，不能安全撤销。', 409, 'PROFILE_DRIFT');
  const route = await ctx.get(`route:${original.plan.routeId}`);
  requireThat(!route?.lastJobId || route.lastJobId === original.id, '这条记录已有更新的任务，不能越过新任务撤销旧任务。', 409, 'NEWER_JOB');
  await ctx.ensureIdle(original.plan.routeId, original.plan.profile?.tunnelId);
  if (original.plan.type === 'edge') {
    const latest = (await ctx.list('job:')).filter(j => j.plan.type === 'edge' && j.plan.routeId === original.plan.routeId && j.status !== 'rolled_back').sort((a, b) => b.createdAt - a.createdAt)[0];
    requireThat(!latest || latest.id === original.id, '共享入口已有更新任务，不能越过新任务撤销。', 409, 'NEWER_JOB');
  }
  const actions = [];
  requireThat(!original.actions.some(a => a.state === 'writing'), '存在结果未确认的写入，请先恢复任务核对远端，再暂停并预览撤销。', 409, 'UNCERTAIN_WRITE');
  for (const a of [...original.actions].reverse()) {
    if (a.state !== 'done' || a.role?.startsWith('shared_') || a.ownershipUncertain || a.eventOnly) continue;
    // Shared config gets an exact-state guard, never a blind replay of an old Tunnel snapshot.
    const inverse = { ...clone(a), id: id(), before: a.applied, after: a.before?.value || null, applied: undefined, state: 'pending', createBody: undefined, patchBody: undefined, label: `撤销 · ${a.label}`, phase: 'setup' };
    requireThat(equal(await readResource(ctx, inverse), inverse.before), `${a.label} 在执行后又被修改，无法安全撤销。不会覆盖更新后的配置。`, 409, 'ROLLBACK_DRIFT');
    actions.push(inverse);
  }
  requireThat(actions.length > 0, '没有可安全撤销的远程变更。导入/复用的资源不会被删除。', 409, 'NOTHING_TO_ROLLBACK');
  return { id: id(), type: 'rollback', createdAt: now(), expiresAt: now() + 600000, routeId: original.plan.routeId, profile: currentProfile, spec: original.plan.spec, previous: route, restoreRoute: original.plan.previous, originalJobId: original.id, actions, warnings: [original.plan.type === 'edge' ? '撤销会恢复共享入口的原 DNS 目标，所有引用此入口的服务都会受到影响。' : '撤销可能中断该域名访问，并删除本任务新建的证书。共享优选入口和备用源会保留；导入/复用资源不删除。'], jobId: null };
}

export async function discoverRoutes(ctx, profile) {
  const snap = await profileSnapshot(ctx, profile);
  const managed = await ctx.list('route:');
  const candidates = [];
  for (const ch of snap.customs) {
    if (!ch.hostname || !ch.custom_origin_server || !inZone(cleanDNSName(ch.hostname), profile.publicZone.name) || !inZone(cleanDNSName(ch.custom_origin_server), profile.sourceZone.name)) continue;
    if (managed.some(r => cleanDNSName(r.publicHostname) === cleanDNSName(ch.hostname))) continue;
    const candidate = candidateFromSnapshot(profile, snap, ch, managed);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
