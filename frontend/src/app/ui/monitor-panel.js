/**
 * Environmental monitoring: every satellite analysis that has been run, with
 * its headline measurements, plus the detection models behind them (version,
 * method, limits, evaluation status). Selecting a card opens the event.
 */
import { loadMonitoring, openPanel, selectEvent } from '../actions.js';
import { describeError } from '../api.js';
import { esc, fmtDate, timeAgo } from '../format.js';
import { EVENT_TYPES } from '../model.js';
import { data } from '../state.js';
import { on, severityBadge, skeletonRows, stateBlock } from './dom.js';

function card(item, selectedId) {
    const e = item.event;
    const type = EVENT_TYPES[e.type] || { label: e.type, icon: '•' };
    const rows = item.metrics.slice(0, 4).map((m) => `
        <li><span>${esc(m.label)}</span><span>${esc(String(m.value))}${m.unit ? ` ${esc(m.unit)}` : ''}</span></li>`).join('');
    return `
        <li>
            <button type="button" class="event-card mon-card${e.id === selectedId ? ' is-selected' : ''}" data-event="${esc(e.id)}"
                aria-pressed="${e.id === selectedId}">
                <span class="event-top"><span class="type-chip"><span aria-hidden="true">${type.icon}</span> ${esc(type.label)}</span>
                    ${item.detected ? severityBadge(e.severity) : '<span class="tag tag-unavailable">NOTHING DETECTED</span>'}</span>
                <span class="event-title">${esc(e.location_name)}</span>
                <span class="event-meta">${esc(fmtDate(item.before))} → ${esc(fmtDate(item.after))} · ${esc(e.confidence.label || '')}</span>
                <ul class="kv mon-kv">${rows}</ul>
                ${item.quality_flags.length ? `<span class="event-meta mon-flag">⚠ ${esc(item.quality_flags[0])}</span>` : ''}
            </button>
        </li>`;
}

function modelsBlock(models) {
    if (!models.data) return '';
    return `
        <section class="block">
            <h3>Detection models</h3>
            ${models.data.items.map((m) => `
                <details class="method">
                    <summary>${esc(m.name)} <span class="muted">${esc(m.id)} ${esc(m.version)}</span></summary>
                    <p>${esc(m.method)}</p>
                    <h4>Known limits</h4>
                    <ul class="bullets">${m.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
                    <p class="kv-note"><strong>Evaluation:</strong> ${esc(m.evaluation.note || m.evaluation.status)}</p>
                </details>`).join('')}
        </section>`;
}

function render(root) {
    const { monitoring, models, selectedId } = data.get();
    if (!monitoring.data) {
        if (monitoring.status === 'error') {
            const d = describeError(monitoring.error);
            root.innerHTML = stateBlock({ kind: 'error', title: d.title, text: d.text, action: { label: 'Retry', name: 'reload' } });
        } else {
            root.innerHTML = `${stateBlock({ kind: 'loading', title: 'Loading analyses…' })}${skeletonRows(3)}`;
        }
        return;
    }
    const items = monitoring.data.items;
    const detected = items.filter((i) => i.detected).length;
    // Keep disclosures open across refreshes.
    const open = [...root.querySelectorAll('details.method')].map((d) => d.open);
    root.innerHTML = `
        ${monitoring.status === 'error' ? '<div class="banner banner-warn" role="alert">Could not refresh — showing the last result.</div>' : ''}
        <div class="list-head"><h3>${items.length} satellite analys${items.length === 1 ? 'is' : 'es'} · ${detected} with a detection</h3>
            <span class="muted">${monitoring.status === 'loading' ? 'Refreshing…' : `Updated ${esc(timeAgo(monitoring.data.generated_at))}`}</span></div>
        ${items.length ? `<ul class="event-list">${items.map((i) => card(i, selectedId)).join('')}</ul>` : stateBlock({
            kind: 'empty', title: 'No satellite analysis yet',
            text: 'Run a flood, surface-water or vegetation analysis for an area to see measured change here.',
            action: { label: 'Analyse an area', name: 'go-analyse' },
        })}
        ${modelsBlock(models)}`;
    root.querySelectorAll('details.method').forEach((d, i) => { if (open[i]) d.open = true; });
}

export function mountMonitorPanel(root) {
    on(root, 'click', '[data-event]', (_e, el) => selectEvent(el.dataset.event));
    on(root, 'click', '[data-action]', (_e, el) => {
        if (el.dataset.action === 'reload') loadMonitoring();
        if (el.dataset.action === 'go-analyse') openPanel('analyse');
    });
    const draw = () => render(root);
    data.subscribe(draw, (s) => s.monitoring);
    data.subscribe(draw, (s) => s.models);
    data.subscribe(draw, (s) => s.selectedId);
    draw();
}
