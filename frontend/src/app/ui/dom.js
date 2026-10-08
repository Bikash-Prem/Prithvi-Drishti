/**
 * Shared UI building blocks (design-system components as HTML strings) and
 * a tiny event-delegation helper. All dynamic text is escaped here or by the
 * caller via `esc`.
 */
import { DATA_STATUS, SEVERITY, esc } from '../format.js';

/** Delegate `type` events from `root` to elements matching `selector`. */
export function on(root, type, selector, handler) {
    root.addEventListener(type, (e) => {
        const target = e.target instanceof Element ? e.target.closest(selector) : null;
        if (target && root.contains(target)) handler(e, target);
    });
}

/** Severity = icon shape + word + colour (never colour alone). */
export function severityBadge(severity, { large = false } = {}) {
    const s = SEVERITY[severity] || SEVERITY.low;
    return `<span class="sev sev-${esc(severity)}${large ? ' sev-lg' : ''}"><span class="sev-icon" aria-hidden="true">${s.icon}</span>${esc(s.label)}</span>`;
}

export function dataBadge(status, note = '') {
    const d = DATA_STATUS[status] || DATA_STATUS.unavailable;
    return `<span class="tag tag-${esc(status)}" title="${esc(note || d.label)}">${esc(d.short)}</span>`;
}

/**
 * One block for every non-data state, so loading / empty / error /
 * unavailable each look deliberate and distinct.
 * @param {{kind: 'loading'|'empty'|'error'|'unavailable', title: string, text?: string, action?: {label: string, name: string}}} s
 */
export function stateBlock(s) {
    const icon = { loading: '', empty: '○', error: '!', unavailable: '—' }[s.kind] ?? '';
    const live = s.kind === 'error' ? 'role="alert"' : 'role="status"';
    return `
        <div class="state state-${esc(s.kind)}" ${live}>
            ${s.kind === 'loading' ? '<span class="spinner" aria-hidden="true"></span>' : `<span class="state-icon" aria-hidden="true">${icon}</span>`}
            <div class="state-body">
                <p class="state-title">${esc(s.title)}</p>
                ${s.text ? `<p class="state-text">${esc(s.text)}</p>` : ''}
                ${s.action ? `<button type="button" class="btn btn-sm" data-action="${esc(s.action.name)}">${esc(s.action.label)}</button>` : ''}
            </div>
        </div>`;
}

export function skeletonRows(n = 4) {
    return `<div class="skeleton-list" aria-hidden="true">${'<div class="skeleton"></div>'.repeat(n)}</div>`;
}

/** A labelled fact; unknown values render as words with the reason attached. */
export function fact(label, text, { available = true, hint = '' } = {}) {
    return `
        <div class="fact${available ? '' : ' fact-na'}">
            <dt>${esc(label)}</dt>
            <dd>${esc(text)}</dd>
            ${hint ? `<p class="fact-hint">${esc(hint)}</p>` : ''}
        </div>`;
}
