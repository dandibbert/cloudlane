export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT', details = undefined) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export const requireThat = (condition, message, status = 400, code = 'INVALID_INPUT') => {
  if (!condition) throw new AppError(message, status, code);
};
export const now = () => Date.now();
export const id = () => crypto.randomUUID();
export const clone = value => structuredClone(value);
export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const equal = (a, b) => canonical(a) === canonical(b);
export async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function constantTimeEqual(a, b) {
  const aa = await digest(String(a)), bb = await digest(String(b));
  let delta = 0;
  for (let i = 0; i < aa.length; i++) delta |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return delta === 0;
}
const to64 = bytes => btoa(String.fromCharCode(...bytes));
const from64 = string => Uint8Array.from(atob(string), c => c.charCodeAt(0));
async function key(secret) {
  let bytes;
  try { bytes = from64(secret || ''); } catch { /* validated below */ }
  requireThat(bytes?.length === 32, 'ENCRYPTION_KEY 必须是 32 字节随机密钥的 Base64 编码。', 503, 'SETUP_REQUIRED');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(text, secret, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, await key(secret), new TextEncoder().encode(text));
  return { v: 1, iv: to64(iv), data: to64(new Uint8Array(ciphertext)) };
}
export async function unseal(value, secret, context) {
  try {
    requireThat(value?.v === 1, '凭据格式不受支持。');
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(value.iv), additionalData: new TextEncoder().encode(context) }, await key(secret), from64(value.data)));
  } catch { throw new AppError('无法解密 API 凭据。请检查 ENCRYPTION_KEY 是否被替换，或重新录入 Token。', 503, 'CREDENTIAL_DECRYPT_FAILED'); }
}
export async function validateSecrets(env) {
  requireThat(typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 16, '请先设置至少 16 字符的 ADMIN_PASSWORD 和 ENCRYPTION_KEY。', 503, 'SETUP_REQUIRED');
  await key(env.ENCRYPTION_KEY);
}
export function text(value, field, max = 160) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${field}不能为空，且不能超过 ${max} 个字符。`);
  return value.trim();
}
export function cfId(value, field = 'ID') {
  requireThat(typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value), `${field}应为 32 位十六进制 ID。`);
  return value.toLowerCase();
}
export function tunnelId(value) {
  requireThat(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value), 'Tunnel ID 格式不正确。');
  return value.toLowerCase();
}
export function hostname(value, allowUnderscore = false) {
  const input = text(value, '域名', 253).replace(/\.$/, '').toLowerCase();
  requireThat(!/[\s/@?#:\\*%]/.test(input), '请输入完整域名，不要包含协议、路径、端口、通配符或空格。');
  let normalized;
  try { normalized = new URL(`https://${input}`).hostname; } catch { throw new AppError('域名格式不正确。'); }
  const regex = allowUnderscore ? /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/ : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  requireThat(normalized.length <= 253 && normalized.includes('.') && !/^\d+(\.\d+){3}$/.test(normalized) && normalized.split('.').every(x => regex.test(x)), '域名格式不正确（支持自动转换国际化域名）。');
  return normalized;
}
export const inZone = (host, zone) => host === zone || host.endsWith(`.${zone}`);
export function serviceURL(value) {
  const input = text(value, '本地服务地址', 2048);
  let parsed;
  try { parsed = new URL(input); } catch { throw new AppError('本地服务地址格式错误，例如 http://localhost:1111。'); }
  requireThat(['http:', 'https:'].includes(parsed.protocol), '本面板只管理 HTTP/HTTPS 服务；不会把 SSH/TCP Tunnel 改成网页优选。');
  requireThat(!parsed.username && !parsed.password && !parsed.search && !parsed.hash && (!parsed.pathname || parsed.pathname === '/'), '服务地址不能包含账号密码、查询参数、片段或路径。');
  requireThat(!!parsed.hostname && !/[\s\r\n]/.test(input), '服务地址无效。');
  return `${parsed.protocol}//${parsed.host}`;
}
export function originOptions(value) {
  if (value === undefined || value === null) return undefined;
  requireThat(typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 12000, 'originRequest 必须是 JSON 对象（最多 12 KB）。');
  for (const k of Object.keys(value)) requireThat(!['__proto__', 'constructor', 'prototype'].includes(k), 'originRequest 包含不安全字段。');
  if ('noTLSVerify' in value) requireThat(typeof value.noTLSVerify === 'boolean', 'noTLSVerify 必须是布尔值。');
  for (const k of ['httpHostHeader', 'originServerName']) if (k in value) requireThat(typeof value[k] === 'string' && !/[\r\n]/.test(value[k]), `${k} 格式错误。`);
  return clone(value);
}
export function validateRoute(input, profile) {
  const originHostname = hostname(input.originHostname), publicHostname = hostname(input.publicHostname);
  const edgeHostname = hostname(input.edgeHostname || profile.edgeHostname);
  requireThat(inZone(originHostname, profile.sourceZone.name) && originHostname !== profile.sourceZone.name, '源域名必须是源 Zone 下的子域名。');
  requireThat(inZone(publicHostname, profile.publicZone.name) && publicHostname !== profile.publicZone.name, '访问域名必须是访问 Zone 下的子域名；根域名与通配符需要单独的迁移方案。');
  requireThat(new Set([originHostname, publicHostname, edgeHostname]).size === 3, '源域名、访问域名和优选入口不能相同，否则可能形成回源循环。');
  requireThat(inZone(edgeHostname, profile.sourceZone.name), '优选入口必须位于这套方案的源 Zone 中。');
  return { name: text(input.name, '记录名称', 80), profileId: profile.id, originHostname, publicHostname, edgeHostname, service: serviceURL(input.service), originRequest: originOptions(input.originRequest), note: String(input.note || '').slice(0, 500), cutover: input.cutover === 'immediate' ? 'immediate' : 'when_ready' };
}
export function mergeIngress(config, desiredRules, allowChange = false) {
  const out = clone(config || {});
  requireThat(Array.isArray(out.ingress) && out.ingress.length, 'Tunnel 没有有效远程 ingress 配置；请先在 Cloudflare 初始化 Tunnel。', 409, 'INVALID_INGRESS');
  const catchalls = out.ingress.map((r, i) => !r.hostname && !r.path ? i : -1).filter(i => i >= 0);
  requireThat(catchalls.length === 1 && catchalls[0] === out.ingress.length - 1, 'Tunnel 的兜底规则异常；面板不会重排或替换现有规则。', 409, 'INVALID_INGRESS');
  for (const rule of desiredRules) {
    const matches = out.ingress.map((r, i) => r.hostname?.toLowerCase() === rule.hostname ? i : -1).filter(i => i >= 0);
    requireThat(matches.length <= 1 && !matches.some(i => !!out.ingress[i].path), `${rule.hostname} 有路径规则或重复规则，不能自动接管。`, 409, 'INGRESS_CONFLICT');
    if (matches.length) {
      const current = out.ingress[matches[0]];
      const merged = { ...current, service: rule.service };
      if (rule.originRequest !== undefined) merged.originRequest = clone(rule.originRequest);
      requireThat(allowChange || equal(current, merged), `${rule.hostname} 已有不同的 Tunnel 规则，请先从「导入现有记录」接管。`, 409, 'UNMANAGED_CONFLICT');
      out.ingress[matches[0]] = merged;
    } else {
      // Exact hostnames must be placed before matching wildcard routes and the final catch-all.
      let index = out.ingress.findIndex(r => r.hostname?.startsWith('*.') && rule.hostname.endsWith(r.hostname.slice(1)));
      if (index < 0) index = out.ingress.length - 1;
      out.ingress.splice(index, 0, clone(rule));
    }
  }
  return out;
}
export function summarizeStatus(observed, pending = false) {
  if (!observed) return 'unknown';
  if (observed.error) return 'error';
  if (observed.tunnelStatus === 'down' || observed.tunnelStatus === 'inactive') return 'offline';
  if (observed.drift?.length) return 'drift';
  // SSL issuance is intentionally informational: an existing or edge-served certificate may
  // keep traffic usable while Cloudflare reports pending_validation. Only hostname ownership
  // and traffic-DNS readiness gate the route's usable state.
  if (observed.hostnameStatus !== 'active') return 'pending';
  if (pending || !observed.dnsReady) return 'waiting_dns';
  if (observed.tunnelStatus !== 'healthy') return 'degraded';
  return 'ready';
}
export function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
export function safeError(error) {
  if (error instanceof AppError) return { message: error.message, code: error.code, details: error.details };
  return { message: '内部操作未完成，请重试并查看任务记录。', code: 'INTERNAL_ERROR' };
}