/**
 * Events panel: the handful of KPIs the backend can actually support, a
 * 12-month event chart, filters, and the event feed. Selecting an event here
 * drives the map and the detail panel through the stores.
 */
import { loadEvents, openPanel, selectEvent } from '../actions.js';
import { describeError } from '../api.js';
import { esc, fmtDateTime, measureText, monthLabel, timeAgo } from '../format.js';
import { EVENT_TYPES, RANGE_PRESETS, eventsByMonth, filterEvents } from '../model.js';
import { data, filters } from '../state.js';
import { dataBadge, on, severityBadge, skeletonRows, stateBlock } from './dom.js';

function kpis(summary) {
    const cell = (label, value, hint = '', na = false) => `
        <div class="kpi${na ? ' kpi-na' : ''}">
            <span class="kpi-value">${esc(value)}</span>
            <span class="kpi-label">${esc(label)}</span>
            ${hint ? `<span class="kpi-hint">${esc(hint)}</span>` : ''}
        </div>`;
    // A measured KPI shows its value with the range underneath; an unmeasured one says why.
    const measured = (label, measure, digits, unit) => {
        const m = measureText(measure, digits);
        if (!m.available) return cell(label, m.text, m.reason, true);
        return cell(label, m.text.replace(` ${unit}`, ''),
            [unit, m.range ? `range ${m.range}` : '', (m.reason || '').replace('Largest single event: ', '')].filter(Boolean).join(' · '));
    };
    const types = Object.entries(summary.by_type || {}).map(([t, n]) => `${n} ${(EVENT_TYPES[t]?.label || t).toLowerCase()}`).join(' · ');
    return `
        <div class="kpi-row" aria-label="Summary of current events">
            ${cell('Current events', String(summary.active_events), `${summary.high_risk_events} high or critical`)}
            ${cell('Satellite detections', String(summary.detections ?? 0), types || 'none current')}
            ${measured('Largest water extent', summary.affected_area_km2, 1, 'km²')}
            ${measured('Most people exposed', summary.population_exposed, 0, 'people')}
        </div>`;
}

function chart(events) {
    const buckets = eventsByMonth(events);
    const max = Math.max(1, ...buckets.map((b) => b.total));
    const total = buckets.reduce((n, b) => n + b.total, 0);
    const bars = buckets.map((b, i) => {
        const x = 4 + i * 26;
        let y = 62;
        const segs = ['low', 'medium', 'high', 'critical'].map((sev) => {
            if (!b[sev]) return '';
            const h = (b[sev] / max) * 52;
            y -= h;
            return `<rect class="bar-${sev}" x="${x}" y="${y.toFixed(1)}" width="18" height="${h.toFixed(1)}"></rect>`;
        }).join('');
        return `${segs}<text x="${x + 9}" y="74" text-anchor="middle">${monthLabel(b.month)[0]}</text>`
            + (b.total ? `<text class="bar-n" x="${x + 9}" y="${(y - 3).toFixed(1)}" text-anchor="middle">${b.total}</text>` : '');
    }).join('');
    const described = buckets.filter((b) => b.total).map((b) => `${monthLabel(b.month)} ${b.total}`).join(', ');
    return `
        <figure class="chart">
            <figcaption>Events started per month <span class="muted">· last 12 months · ${total} total</span></figcaption>
            <svg viewBox="0 0 316 78" role="img" aria-label="Events per month: ${esc(described || 'none')}">
                <line x1="0" y1="62.5" x2="316" y2="62.5" class="axis"></line>${bars}
            </svg>
        </figure>`;
}

function filterBar(f) {
    const chips = RANGE_PRESETS.map((p) => `
        <button type="button" class="chip${f.rangeId === p.id ? ' is-on' : ''}" data-range="${p.id}"
            aria-pressed="${f.rangeId === p.id}">${esc(p.label)}</button>`).join('');
    const opt = (v, label, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`;
    return `
        <div class="filters">
            <div class="chips" role="group" aria-label="Time range">${chips}</div>
            <div class="filter-selects">
                <label class="select"><span class="sr-only">Show</span>
                    <select data-filter="scope">
                        ${opt('all', 'Current and past', f.scope)}${opt('current', 'Current only', f.scope)}${opt('past', 'Past only', f.scope)}
                    </select></label>
                <label class="select"><span class="sr-only">Event type</span>
                    <select data-filter="type">
                        ${opt('', 'All types', f.type || '')}${Object.entries(EVENT_TYPES).map(([id, t]) => opt(id, t.label, f.type || '')).join('')}
                    </select></label>
                <label class="select"><span class="sr-only">Minimum severity</span>
                    <select data-filter="minSeverity">
                        ${opt('', 'Any severity', f.minSeverity || '')}${opt('medium', 'Medium and above', f.minSeverity || '')}
                        ${opt('high', 'High and above', f.minSeverity || '')}${opt('critical', 'Critical only', f.minSeverity || '')}
                    </select></label>
            </div>
        </div>`;
}

function card(e, selectedId) {
    const when = e.status === 'past' ? `ended ${timeAgo(e.ended_at || e.updated_at)}` : `updated ${timeAgo(e.updated_at)}`;
    const kind = e.kind === 'forecast' ? 'Forecast'
        : e.kind === 'detected' ? `Satellite · ${e.confidence.label || 'detected'}`
            : (e.status === 'past' ? 'Reported · past' : 'Reported · ongoing');
    return `
        <li>
            <button type="button" class="event-card${e.id === selectedId ? ' is-selected' : ''}${e.status === 'past' ? ' is-past' : ''}"
                data-event="${esc(e.id)}" aria-pressed="${e.id === selectedId}">
                <span class="event-top">${severityBadge(e.severity)}<span class="event-kind">${esc(kind)}</span>${dataBadge(e.data_status, e.data_status_note || '')}</span>
                <span class="event-title">${esc(e.title)}</span>
                <span class="event-meta">${esc(e.headline)}</span>
                <span class="event-meta muted">${esc(e.source.provider)} · <time datetime="${esc(e.updated_at)}" title="${esc(fmtDateTime(e.updated_at))}">${esc(when)}</time></span>
            </button>
        </li>`;
}

function render(root) {
    const { events, selectedId } = data.get();
    const f = filters.get();
    const payload = events.data;

    if (!payload) {
        if (events.status === 'error') {
            const d = describeError(events.error);
            root.innerHTML = stateBlock({ kind: 'error', title: d.title, text: d.text, action: d.retry ? { label: 'Retry', name: 'reload' } : undefined });
        } else {
            root.innerHTML = `${stateBlock({ kind: 'loading', title: 'Loading events…' })}${skeletonRows(5)}`;
        }
        return;
    }

    const items = filterEvents(payload.items, f);
    const downSources = payload.sources.filter((s) => s.status !== 'ok');
    const stale = events.status === 'error'
        ? `<div class="banner banner-warn" role="alert">Could not refresh — showing events loaded ${esc(timeAgo(payload.generated_at))}.
               <button type="button" class="link" data-action="reload">Retry</button></div>` : '';
    const sourceNote = downSources.map((s) => `
        <div class="banner banner-warn" role="status"><strong>${esc(s.name)} unavailable.</strong> ${esc(s.reason || '')} Its events are missing from this list.</div>`).join('');

    let list;
    if (!payload.items.length) {
        list = stateBlock({
            kind: 'empty', title: 'No events yet',
            text: 'No forecast has been issued and no external events were returned. Analyse an area to produce a forecast for it.',
            action: { label: 'Analyse an area', name: 'go-analyse' },
        });
    } else if (!items.length) {
        list = stateBlock({ kind: 'empty', title: 'No events match these filters', action: { label: 'Clear filters', name: 'clear-filters' } });
    } else {
        list = `<ul class="event-list">${items.map((e) => card(e, selectedId)).join('')}</ul>`;
    }

    root.innerHTML = `
        ${stale}${kpis(payload.summary)}${chart(payload.items)}${sourceNote}${filterBar(f)}
        <div class="list-head">
            <h3>${items.length} event${items.length === 1 ? '' : 's'}</h3>
            <span class="muted">${events.status === 'loading' ? 'Refreshing…' : `Updated ${esc(timeAgo(payload.generated_at))}`}</span>
        </div>
        ${list}`;
}

export function mountEventsPanel(root) {
    on(root, 'click', '[data-event]', (_e, el) => selectEvent(el.dataset.event));
    on(root, 'click', '[data-range]', (_e, el) => filters.set({ rangeId: el.dataset.range }));
    on(root, 'change', '[data-filter]', (_e, el) => filters.set({ [el.dataset.filter]: el.value || null }));
    on(root, 'click', '[data-action]', (_e, el) => {
        if (el.dataset.action === 'reload') loadEvents();
        if (el.dataset.action === 'go-analyse') openPanel('analyse');
        if (el.dataset.action === 'clear-filters') filters.set({ rangeId: 'all', minSeverity: null, scope: 'all', type: null });
    });
    const draw = () => render(root);
    data.subscribe(draw, (s) => s.events);
    data.subscribe(draw, (s) => s.selectedId);
    filters.subscribe(draw);
    // Relative times ("12 min ago") drift — refresh them once a minute.
    setInterval(() => { if (!document.hidden && !root.contains(document.activeElement)) draw(); }, 60000);
    draw();
}
