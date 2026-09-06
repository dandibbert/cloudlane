import { AppError, requireThat } from './core.mjs';

export class Cloudflare {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async request(path, method = 'GET', body) {
    requireThat(/^\/zones(?:[/?]|$)/.test(path) || /^\/accounts\//.test(path), '不允许的 API 路径。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    let response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: controller.signal
      });
    } catch (error) {
      // Never blindly retry a mutation: the server may already have committed it.
      // Keep timeout errors distinct from Workers/runtime routing failures so the UI
      // does not misdiagnose every failed fetch as a timeout.
      const timedOut = controller.signal.aborted || error?.name === 'AbortError';
      const reason = String(error?.message || error?.name || 'unknown fetch error')
        .replaceAll(this.token, '[redacted]')
        .replace(/\s+/g, ' ')
        .slice(0, 300);
      const message = timedOut
        ? (method === 'GET'
            ? 'Cloudflare API 请求超时（18 秒）。'
            : 'Cloudflare API 请求超时；操作结果暂不确定，任务会先核对远端再继续。')
        : (method === 'GET'
            ? `Cloudflare API 请求失败：${reason}`
            : `Cloudflare API 请求失败：${reason}；操作可能已生效，任务会先核对远端再继续。`);
      throw new AppError(message, 502, 'CF_NETWORK', { reason: timedOut ? 'timeout' : reason });
    } finally { clearTimeout(timeout); }
    let data;
    try { data = await response.json(); } catch { throw new AppError(`Cloudflare API 返回非 JSON 响应（HTTP ${response.status}）。`, 502, 'CF_RESPONSE'); }
    if (!response.ok || data.success === false) {
      const errors = (data.errors || []).map(e => ({ code: e.code, message: String(e.message || '').replaceAll(this.token, '[redacted]').slice(0, 500) }));
      const status = response.status === 429 ? 429 : response.status === 403 || response.status === 401 ? 403 : response.status === 404 ? 404 : 502;
      throw new AppError(`Cloudflare ${response.status}: ${errors.map(e => e.message).join('；') || response.statusText}`, status, response.status === 429 ? 'CF_RATE_LIMIT' : 'CF_API', { errors, retryAfter: Math.min(900, Math.max(1, Number(response.headers.get('Retry-After')) || 60)), path });
    }
    return data;
  }
  async get(path) { return (await this.request(path)).result; }
  async write(path, method, body) { return (await this.request(path, method, body)).result; }
  async list(path, query = {}, maxPages = 100) {
    const result = [];
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({ ...query, per_page: '50', page: String(page) });
      const data = await this.request(`${path}?${params}`);
      requireThat(Array.isArray(data.result), 'Cloudflare 列表响应格式异常。', 502, 'CF_RESPONSE');
      result.push(...data.result);
      const pages = data.result_info?.total_pages;
      if ((typeof pages === 'number' && page >= pages) || data.result.length < 50) return result;
    }
    throw new AppError('资源数量超出本次安全扫描上限，请缩小 Token 的 Zone 范围；不会把部分结果当作完整列表。', 409, 'SCAN_LIMIT');
  }
  async dns(zoneId, name) { return this.list(`/zones/${zoneId}/dns_records`, { name }); }
  async custom(zoneId, name) {
    const results = await this.list(`/zones/${zoneId}/custom_hostnames`, { hostname: name });
    const exact = results.filter(x => x.hostname?.toLowerCase() === name);
    requireThat(exact.length <= 1, `${name} 存在多条自定义主机名，无法安全选择。`, 409, 'CUSTOM_CONFLICT');
    return exact[0] || null;
  }
}
export function dnsBody(record) {
  if (!record) return null;
  const keys = ['type', 'name', 'content', 'ttl', 'proxied', 'comment', 'tags', 'settings', 'priority', 'data'];
  return Object.fromEntries(keys.filter(k => record[k] !== undefined).map(k => [k, record[k]]));
}
export function customBody(record) {
  if (!record) return null;
  // Never persist or expose certificate private keys from an upstream response.
  const result = { hostname: record.hostname, custom_origin_server: record.custom_origin_server || null };
  for (const k of ['custom_origin_sni', 'custom_metadata']) if (record[k] !== undefined) result[k] = record[k];
  if (record.ssl) {
    const keys = ['method', 'type', 'settings', 'certificate_authority', 'wildcard', 'cloudflare_branding'];
    result.ssl = Object.fromEntries(keys.filter(k => record.ssl[k] !== undefined).map(k => [k, record.ssl[k]]));
    // Detect conversion to a manually uploaded certificate without persisting its key or PEM.
    if (record.ssl.custom_certificate || record.ssl.custom_key) result.has_custom_certificate = true;
  }
  return result;
}
export function dnsMatches(record, desired) {
  if (!record) return false;
  return record.type === desired.type && record.name?.toLowerCase().replace(/\.$/, '') === desired.name.toLowerCase().replace(/\.$/, '')
    && (record.type === 'TXT' ? unquote(record.content) === unquote(desired.content) : record.content?.toLowerCase().replace(/\.$/, '') === desired.content.toLowerCase().replace(/\.$/, ''))
    && (desired.type === 'TXT' || Boolean(record.proxied) === Boolean(desired.proxied));
}
const unquote = value => String(value || '').replace(/^"|"$/g, '');