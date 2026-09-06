import { icon } from './icons.mjs';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Markup { constructor(value) { this.value = value; } toString() { return this.value; } }
const encode = value => value instanceof Markup ? value.value : Array.isArray(value) ? value.map(encode).join('') : escapeHTML(value === false || value == null ? '' : value);
export const html = (parts, ...values) => new Markup(parts.reduce((result, text, i) => result + text + (i < values.length ? encode(values[i]) : ''), ''));
export const raw = value => new Markup(value); // only for internal static icons / trusted templates
export const ic = (name, extra = '') => raw(icon(name, extra));
export const yes = condition => condition ? raw('selected') : '';
export const disabled = condition => condition ? raw('disabled') : '';
export const checked = condition => condition ? raw('checked') : '';
export function button(label, action, glyph = '', className = 'btn', extra = '') {
  return html`<button class="${className}" data-action="${action}" ${raw(extra)}>${glyph ? ic(glyph) : ''}<span>${label}</span></button>`;
}
export function iconButton(label, action, glyph, itemId = '', extra = '') {
  return html`<button class="icon-btn" title="${label}" aria-label="${label}" data-action="${action}" data-id="${itemId}" ${raw(extra)}>${ic(glyph)}</button>`;
}
export function badge(label, tone = 'neutral', glyph = '') {
  return html`<span class="badge ${tone}">${glyph ? ic(glyph) : html`<span class="dot"></span>`}${label}</span>`;
}
export const statusMap = { ready: ['配置就绪', 'blue'], pending: ['等待主机名', 'pink'], drift: ['配置有变化', 'amber'], waiting_dns: ['等待切换', 'pink'], offline: ['Tunnel 离线', 'red'], degraded: ['Tunnel 降级', 'amber'], unknown: ['尚未检查', 'neutral'], error: ['检查失败', 'red'] };
export const jobMap = { queued: ['排队中', 'blue'], running: ['执行中', 'blue'], waiting: ['等待前置条件', 'pink'], retrying: ['等待重试', 'amber'], paused: ['已暂停', 'neutral'], failed: ['需要处理', 'red'], done: ['已完成', 'blue'], rolled_back: ['已撤销', 'neutral'] };
export function routeBadge(status) { return badge(...(statusMap[status] || statusMap.unknown)); }
export function jobBadge(status) { return badge(...(jobMap[status] || ['未知', 'neutral'])); }
export function notice(content, tone = 'blue', title = '') { return html`<div class="notice ${tone}">${ic(tone === 'red' || tone === 'amber' ? 'alert' : 'info')}<div>${title ? html`<strong>${title}</strong>` : ''}<p>${content}</p></div></div>`; }
export function empty(title, content, action = '', actionLabel = '', glyph = 'route') { return html`<div class="empty"><div class="empty-icon">${ic(glyph)}</div><h3>${title}</h3><p>${content}</p>${action ? button(actionLabel, action, 'plus', 'btn primary') : ''}</div>`; }
export function field(label, name, value = '', options = {}) {
  return html`<label class="field ${options.wide ? 'wide' : ''}"><span>${label}${options.required ? html`<b class="required">*</b>` : ''}</span><input name="${name}" id="field-${name}" type="${options.type || 'text'}" value="${value}" placeholder="${options.placeholder || ''}" ${options.required ? raw('required') : ''} ${options.readonly ? raw('readonly') : ''} ${options.pattern ? html`pattern="${options.pattern}"` : ''} ${options.max ? html`maxlength="${options.max}"` : ''} autocomplete="${options.autocomplete || 'off'}" spellcheck="false">${options.hint ? html`<small>${options.hint}</small>` : ''}</label>`;
}
export function selectField(label, name, value, options, config = {}) {
  return html`<label class="field ${config.wide ? 'wide' : ''}"><span>${label}${config.required ? html`<b class="required">*</b>` : ''}</span><span class="select-wrap"><select id="field-${name}" name="${name}" ${disabled(config.disabled)} ${config.required ? raw('required') : ''}><option value="">${config.placeholder || '请选择'}</option>${options.map(o => html`<option value="${o.value}" ${yes(o.value === value)} ${disabled(o.disabled)}>${o.label}</option>`)}</select>${ic('down')}</span>${config.hint ? html`<small>${config.hint}</small>` : ''}</label>`;
}
export function ago(timestamp) {
  if (!timestamp) return '尚未检查';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
export function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
export function pretty(value) { return JSON.stringify(value ?? null, null, 2); }