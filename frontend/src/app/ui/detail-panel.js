/**
 * Event detail — answers, in order: what happened, how serious, what is
 * affected, how sure are we, and where the conclusion came from. Everything
 * shown is from the backend's event detail; gaps are listed, not papered over.
 *
 * Satellite detections additionally get: measured extent / population with
 * ranges, statements tagged OBSERVED / INFERRED / UNCERTAIN / RECOMMENDED,
 * their own before / after / change imagery, and a printable report.
 */
import { askAssistant, clearSelection, goTo, loadAssets, selectEvent, setLayer, setOverlay } from '../actions.js';
import { api, describeError } from '../api.js';
import { assetLabel, esc, fmtDate, fmtDateTime, fmtPercent, measureText, rangeText, timeAgo } from '../format.js';
import { OVERLAY_OPTIONS } from '../map/catalog.js';
import { EVENT_TYPES } from '../model.js';
import { data, mapState, ui } from '../state.js';
import { dataBadge, fact, on, severityBadge, skeletonRows, stateBlock } from './dom.js';

const KIND_LABEL = { forecast: 'forecast', reported: 'reported event', detected: 'satellite detection' };
const TAG_HELP = {
    OBSERVED: 'Measured from data', INFERRED: 'Interpretation of the measurements',
    UNCERTAIN: 'Known limits of this result', RECOMMENDED: 'Suggested next step',
};

function statementsBlock(statements) {
    if (!statements.length) return '';
    const rows = statements.map((s) => `
        <li class="stmt stmt-${esc(s.tag.toLowerCase())}">
            <span class="stmt-tag" title="${esc(TAG_HELP[s.tag] || '')}">${esc(s.tag)}</span>
            <p>${esc(s.text)}</p>
        </li>`).join('');
    return `<section class="block" aria-labelledby="d-assess"><h3 id="d-assess">Assessment</h3><ul class="stmts">${rows}</ul></section>`;
}

function metricsBlock(metrics) {
    if (!metrics.length) return '';
    const rows = metrics.map((m) => `
        <li><span>${esc(m.label)}</span><span>${esc(String(m.value))}${m.unit ? ` ${esc(m.unit)}` : ''}</span>
            ${m.note ? `<p class="kv-note">${esc(m.note)}</p>` : ''}</li>`).join('');
    return `<section class="block" aria-labelledby="d-met"><h3 id="d-met">Measurements</h3><ul class="kv kv-notes">${rows}</ul></section>`;
}

const EVIDENCE_WORD = {
    detected: 'Detected', not_detected: 'Nothing detected', supporting: 'Supports the detection',
    nearby_only: 'Loss nearby, not overlapping', no_matching_annual_loss: 'No matching loss',
    not_covered: 'Years not covered', unavailable: 'Unavailable', not_configured: 'Not configured',
    error: 'Request failed', context: 'Context',
    overlapping: 'Overlaps the detection', none_overlapping: 'None overlapping',
};
const EVIDENCE_TONE = {
    detected: 'ok', supporting: 'ok', context: 'info', not_detected: 'info',
    nearby_only: 'warn', no_matching_annual_loss: 'warn', not_covered: 'warn',
    unavailable: 'off', not_configured: 'off', error: 'off',
    overlapping: 'warn', none_overlapping: 'info',
};
const CORROBORATION = {
    stronger: 'Stronger — two independent forest datasets agree',
    supporting: 'Supporting — one independent forest dataset agrees',
    limited: 'Limited — no independent forest dataset agrees',
};
const RELATION_WORD = {
    LOCATED_AT: 'Located at', HAS_RISK: 'Has risk', HAS_EVIDENCE_SOURCE: 'Evidence from',
    SUPPORTED_BY: 'Supported by', POSSIBLY_ASSOCIATED_WITH: 'Possibly associated with',
    HAS_SPATIAL_CONTEXT: 'Inside the extent', NEAR_OR_WITHIN: 'Overlaps protected area',
};

/** ForestGuard: what each independent dataset says about the detection. */
function supportingBlock(rows, fusion) {
    if (!rows.length) return '';
    const items = rows.map((r) => `
        <li>
            <div class="ev-head"><span>${esc(r.source)}</span>
                <span class="ev-status ev-${EVIDENCE_TONE[r.status] || 'info'}">${esc(EVIDENCE_WORD[r.status] || r.status)}</span></div>
            ${r.value ? `<p class="ev-value">${esc(r.value)}</p>` : ''}
            ${r.note ? `<p class="kv-note">${esc(r.note)}</p>` : ''}
        </li>`).join('');
    return `<section class="block" aria-labelledby="d-sup"><h3 id="d-sup">Independent evidence</h3>
        ${fusion ? `<p class="fusion"><strong>Corroboration:</strong> ${esc(CORROBORATION[fusion.corroboration] || fusion.corroboration)}. <span class="muted">A count of agreeing datasets, not a probability.</span></p>` : ''}
        <ul class="ev-list">${items}</ul>
        <p class="kv-note">An NDVI drop is potential forest loss, not confirmed deforestation. These datasets support or fail to support it; none of them proves a cause.</p></section>`;
}

/** Knowledge-graph relationships of a detection, in words. */
function relationshipsBlock(rows) {
    if (!rows.length) return '';
    const items = rows.map((r) => `<li><span>${esc(RELATION_WORD[r.type] || r.type)}</span><span>${esc(r.target)}</span></li>`).join('');
    return `<section class="block" aria-labelledby="d-rel"><h3 id="d-rel">Relationships</h3>
        <details class="method"><summary>${rows.length} links between this detection, its evidence and its surroundings</summary>
        <ul class="kv rel-list">${items}</ul></details></section>`;
}

function hotspotsBlock(hotspots) {
    if (!hotspots.length) return '';
    const items = hotspots.map((h, i) => `
        <li><button type="button" class="hotspot" data-action="goto-hotspot" data-lat="${h.latitude}" data-lng="${h.longitude}">
            <span class="hotspot-no">${String(i + 1).padStart(2, '0')}</span>
            <span>${h.latitude.toFixed(4)}, ${h.longitude.toFixed(4)}</span>
            <span class="hotspot-area">${h.area_km2.toFixed(2)} km²</span></button></li>`).join('');
    return `<section class="block" aria-labelledby="d-hot"><h3 id="d-hot">Largest patches</h3>
        <p class="muted">Patches of 0.05 km² (5 ha) or more, largest first. Select one to zoom to it.</p>
        <ol class="hotspots">${items}</ol></section>`;
}

function imageryBlock(geometry, overlay) {
    if (geometry.status === 'loading') return stateBlock({ kind: 'loading', title: 'Loading extent and imagery…' });
    if (geometry.status === 'error') {
        const d = describeError(geometry.error);
        return stateBlock({ kind: 'error', title: d.title, text: d.text });
    }
    if (geometry.status !== 'ready' || !geometry.data.available) return '';
    const g = geometry.data;
    const buttons = OVERLAY_OPTIONS.map((o) => `
        <button type="button" data-overlay="${o.id}" class="${overlay === o.id ? 'is-on' : ''}"
            aria-pressed="${overlay === o.id}">${esc(o.label)}</button>`).join('');
    const current = g.overlays.find((o) => o.id === overlay);
    return `
        <section class="block" aria-labelledby="d-img">
            <h3 id="d-img">Satellite imagery on the map</h3>
            <div class="seg" role="group" aria-label="Image shown on the map">${buttons}</div>
            <p class="kv-note">${current
                ? `${esc(current.label)}${current.date ? ` · ${esc(fmtDate(current.date))}` : ''}`
                : `${g.extent.patch_count} detected patch${g.extent.patch_count === 1 ? '' : 'es'} drawn on the map${g.extent.truncated ? ' (smallest omitted)' : ''}. Choose an image to see what the detector saw.`}</p>
        </section>`;
}

function riskBlock(risk, method) {
    const rows = risk.components.map((c) => {
        const scored = c.score !== null && c.score !== undefined;
        const pct = scored ? Math.round(c.score * 100) : 0;
        // Facility counts have their own section with provenance — don't repeat them here.
        const details = (c.name === 'exposure' ? [] : c.details || []).map((d) => `
            <li><span>${esc(d.label)}</span><span>${esc(String(d.value))}${d.unit ? ` ${esc(d.unit)}` : ''}</span></li>`).join('');
        return `
            <div class="risk-row risk-${esc(c.status)}">
                <div class="risk-head">
                    <span class="risk-name">${esc(c.name)}</span>
                    <span class="risk-label">${esc(c.label)}</span>
                </div>
                ${scored
                    ? `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(c.name)}: ${esc(c.label)}"><span style="width:${pct}%"></span></div>`
                    : '<div class="meter meter-na" aria-hidden="true"></div>'}
                <p class="risk-basis">${esc(c.basis)}</p>
                ${details ? `<ul class="kv">${details}</ul>` : ''}
            </div>`;
    }).join('');
    const how = method ? `
        <details class="method">
            <summary>How this risk level is worked out</summary>
            <p>${esc(method.summary)}</p>
            <ul class="kv">
                <li><span>Hazard bands (km²)</span><span>${esc(Object.entries(method.hazard_bands_km2).map(([k, v]) => `${k} ${v}`).join(' · '))}</span></li>
                <li><span>Exposure bands (people)</span><span>${esc(Object.entries(method.exposure_bands_people).map(([k, v]) => `${k} ${v}`).join(' · '))}</span></li>
            </ul>
            <p class="kv-note">${esc(method.exposure_rule)} ${esc(method.matrix)} Vulnerability: ${esc(method.vulnerability)}</p>
        </details>` : '';
    return `
        <section class="block" aria-labelledby="d-risk">
            <h3 id="d-risk">Risk</h3>
            ${rows}
            <div class="risk-overall">
                <span>Overall</span>${severityBadge(risk.level)}
                ${risk.complete ? '' : `<span class="tag tag-unavailable" title="Not all components could be scored">INCOMPLETE · ${esc(risk.basis)}</span>`}
            </div>
            <p class="why"><strong>Why:</strong> ${esc(risk.explanation)}</p>
            ${how}
        </section>`;
}

function uncertaintyBlock(items) {
    if (!items.length) return '';
    const rows = items.map((u) => `
        <li><span>${esc(u.label)}</span><span>${esc(rangeText(u))}</span>
            <p class="kv-note">${esc(u.explanation || '')}</p></li>`).join('');
    return `<section class="block" aria-labelledby="d-unc"><h3 id="d-unc">How certain is this?</h3><ul class="kv kv-notes">${rows}</ul></section>`;
}

function evidenceBlock(detail) {
    const items = detail.evidence.map((e) => `
        <li class="evidence">
            <div class="evidence-head"><span class="evidence-role">${esc(e.role)}</span>${dataBadge(e.data_status)}</div>
            <p class="evidence-source">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.source)}</a>` : esc(e.source)}</p>
            <p class="evidence-detail">${esc(e.detail)}</p>
            <p class="evidence-meta">${e.timestamp ? `<time datetime="${esc(e.timestamp)}">${esc(fmtDateTime(e.timestamp))}</time>` : 'Time not recorded'}${e.version ? ` · ${esc(e.version)}` : ''}</p>
        </li>`).join('');
    const missing = detail.not_available.map((n) => `
        <li><span>${esc(n.item)}</span><p class="kv-note">${esc(n.reason)}</p></li>`).join('');
    return `
        <section class="block" aria-labelledby="d-ev">
            <h3 id="d-ev">Evidence</h3>
            <ul class="evidence-list">${items}</ul>
            <h4>Not available and known limits</h4>
            <ul class="kv kv-notes kv-missing">${missing}</ul>
        </section>`;
}

function assetsBlock(assets, event) {
    const where = event.kind === 'detected' ? 'inside the detected extent'
        : event.kind === 'forecast' ? 'inside the forecast area — not inside a mapped flood extent'
            : 'around the reported location — not inside a mapped flood extent';
    if (assets.status === 'loading') {
        return stateBlock({ kind: 'loading', title: 'Querying OpenStreetMap…', text: 'First request for an area can take up to a minute.' });
    }
    if (assets.status === 'error') {
        const d = describeError(assets.error);
        return stateBlock({ kind: 'error', title: d.title, text: d.text, action: { label: 'Retry', name: 'load-assets' } });
    }
    if (assets.status === 'ready' && assets.data.status !== 'available') {
        return stateBlock({
            kind: 'unavailable', title: 'Facilities unavailable', text: assets.data.reason,
            action: event.kind === 'detected' ? undefined : { label: 'Retry', name: 'load-assets' },
        });
    }
    if (assets.status === 'ready') {
        const a = assets.data;
        const counts = Object.entries(a.counts).sort((x, y) => y[1] - x[1]).map(([type, n]) => `
            <li><span>${esc(assetLabel(type))}</span><span>${n}</span></li>`).join('');
        const of = a.area_total !== undefined && a.area_total !== null ? ` of ${a.area_total} in the analysis area` : '';
        return `
            <ul class="kv">${counts || `<li><span>No mapped facility ${esc(where.split(' — ')[0])}</span><span>0</span></li>`}</ul>
            <p class="kv-note">${a.total}${esc(of)} ${esc(where)}. ${esc(a.source || 'OpenStreetMap')}${a.fetched_at ? ` · fetched ${esc(timeAgo(a.fetched_at))}` : ''}${a.truncated ? ' · source list truncated' : ''}${a.bbox_clamped ? ' · area reduced to about 65 km' : ''}.</p>`;
    }
    if (event.kind === 'detected') {
        const m = measureText(event.assets_exposed);
        return `<p class="kv-note">${esc(m.available ? '' : m.reason)}</p>`;
    }
    return `
        <p class="kv-note">Hospitals, schools and emergency services from OpenStreetMap for this event’s area.</p>
        <button type="button" class="btn btn-sm" data-action="load-assets">Query facilities</button>`;
}

function measureFact(label, measure, digits, availableHint) {
    const m = measureText(measure, digits);
    const text = m.available ? m.text.replace(' facilities', '').replace(' people', '') : m.text;
    const hint = m.available
        ? [m.range ? `range ${m.range}` : '', availableHint].filter(Boolean).join(' · ')
        : m.reason;
    return fact(label, text, { available: m.available, hint });
}

function body(detail, assets, geometry, overlay) {
    const e = detail.event;
    const detected = e.kind === 'detected';
    const period = e.kind === 'forecast' ? `Issued ${fmtDateTime(e.updated_at)}`
        : detected ? `Observed ${fmtDate(e.detected_at)}`
            : `${fmtDate(e.detected_at)} – ${e.ended_at ? fmtDate(e.ended_at) : 'ongoing'}`;
    const type = EVENT_TYPES[e.type]?.label || e.type;
    let confidence;
    if (e.confidence.label) {
        confidence = fact('Detection confidence', e.confidence.label, { hint: e.confidence.explanation });
    } else if (e.confidence.value !== null && e.confidence.value !== undefined) {
        confidence = fact('Ensemble agreement', fmtPercent(e.confidence.value), { hint: e.confidence.explanation });
    } else {
        confidence = fact('Confidence', 'Not provided', { available: false, hint: e.confidence.explanation });
    }
    return `
        <header class="detail-head">
            <div class="detail-tags">
                <span class="event-kind">${esc(type)} · ${esc(KIND_LABEL[e.kind])}</span>
                ${dataBadge(e.data_status, e.data_status_note || '')}
            </div>
            <h2 id="detail-title">${esc(e.title)}</h2>
            <p class="muted">${esc(e.location_name)} · ${esc(period)}</p>
            ${severityBadge(e.severity, { large: true })}
        </header>
        ${e.data_status === 'demo' ? `<div class="banner banner-demo" role="note"><strong>Demo data.</strong> ${esc(e.data_status_note || '')}</div>` : ''}
        ${(detail.quality_flags || []).length ? `<div class="banner banner-warn" role="note"><strong>Read with care.</strong> ${detail.quality_flags.map(esc).join(' ')}</div>` : ''}

        <dl class="facts">
            ${confidence}
            ${measureFact('Affected area', e.affected_area_km2, 2, detected ? 'km², from the detector' : '')}
            ${measureFact('Population exposed', e.population_exposed, 0, 'people inside the extent')}
            ${measureFact('Critical facilities', e.assets_exposed, 0, detected ? 'inside the extent' : `in the analysed area${e.assets_exposed.lower_bound ? ' (list truncated)' : ''}`)}
        </dl>

        <div class="detail-actions">
            <button type="button" class="btn btn-sm" data-action="compare">Before / after</button>
            <button type="button" class="btn btn-sm" data-action="ask-why">Ask why</button>
            <a class="btn btn-sm" href="${esc(api.reportUrl(e.id))}" target="_blank" rel="noopener">Report ↗</a>
            ${e.source.url ? `<a class="btn btn-sm" href="${esc(e.source.url)}" target="_blank" rel="noopener">Source ↗</a>` : ''}
        </div>

        ${detected ? imageryBlock(geometry, overlay) : ''}
        ${detail.statements && detail.statements.length && detected ? statementsBlock(detail.statements) : `
            <section class="block" aria-labelledby="d-what"><h3 id="d-what">What happened</h3><p>${esc(detail.what_happened)}</p></section>
            <section class="block" aria-labelledby="d-why"><h3 id="d-why">Why it matters</h3><p>${esc(detail.why_it_matters)}</p></section>`}
        ${supportingBlock(detail.supporting_evidence || [], detail.fusion)}
        ${hotspotsBlock(detail.hotspots || [])}
        ${metricsBlock(detail.metrics || [])}
        ${riskBlock(detail.risk, detail.risk_method)}
        <section class="block" aria-labelledby="d-fac"><h3 id="d-fac">Critical facilities</h3>${assetsBlock(assets, e)}</section>
        ${uncertaintyBlock(detail.uncertainty)}
        ${evidenceBlock(detail)}
        ${relationshipsBlock(detail.relationships || [])}`;
}

function render(root, panel) {
    const { selectedId, detail, assets, geometry } = data.get();
    panel.hidden = !selectedId;
    document.body.classList.toggle('has-detail', Boolean(selectedId));
    if (!selectedId) { root.innerHTML = ''; return; }
    if (detail.status === 'error') {
        const d = describeError(detail.error);
        root.innerHTML = stateBlock({ kind: 'error', title: d.title, text: d.text, action: d.retry ? { label: 'Retry', name: 'reload-detail' } : undefined });
    } else if (!detail.data) {
        root.innerHTML = `${stateBlock({ kind: 'loading', title: 'Loading event…' })}${skeletonRows(4)}`;
    } else {
        // Preserve scroll (and open disclosures) across re-renders of the same event.
        const same = root.dataset.eventId === selectedId;
        const scroll = same ? root.scrollTop : 0;
        const open = same && root.querySelector('details.method')?.open;
        root.innerHTML = body(detail.data, assets, geometry, mapState.get().overlay);
        root.dataset.eventId = selectedId;
        if (open) root.querySelector('details.method').open = true;
        root.scrollTop = scroll;
    }
}

export function mountDetailPanel(panel) {
    const root = panel.querySelector('.detail-body');
    panel.querySelector('[data-action="close-detail"]').addEventListener('click', clearSelection);
    on(root, 'click', '[data-action]', (_e, el) => {
        const id = data.get().selectedId;
        const action = el.dataset.action;
        if (action === 'load-assets') { loadAssets(id); setLayer('assets', { on: true }); }
        if (action === 'reload-detail') selectEvent(id, { fit: false });
        if (action === 'compare') ui.set({ compare: true });
        if (action === 'goto-hotspot') goTo(Number(el.dataset.lat), Number(el.dataset.lng), 0.02);
        if (action === 'ask-why') { ui.set({ panel: 'assistant', panelOpen: true }); askAssistant('Why is this event rated the way it is?'); }
    });
    on(root, 'click', '[data-overlay]', (_e, el) => setOverlay(el.dataset.overlay));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && data.get().selectedId && !ui.get().compare && !mapState.get().drawing) clearSelection();
    });
    const draw = () => render(root, panel);
    data.subscribe(draw, (s) => s.selectedId);
    data.subscribe(draw, (s) => s.detail);
    data.subscribe(draw, (s) => s.assets);
    data.subscribe(draw, (s) => s.geometry);
    mapState.subscribe(draw, (s) => s.overlay);
    draw();
}
