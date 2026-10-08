/**
 * Area analysis workflow: choose an area → choose an analysis (and dates for
 * satellite work) → run → watch each step report in. Steps that cannot get
 * their data come back "unavailable" or fail with the provider's reason;
 * nothing is filled in.
 */
import {
    cancelDrawing, runAnalysis, selectEvent, setAnalysisType, setAoi, setAoiFromPlace, startDrawing, useCurrentView,
} from '../actions.js';
import { esc, isoDay, timeAgo } from '../format.js';
import { ANALYSIS_TYPES, jobProgress, validateAnalysis, validateAoi } from '../model.js';
import { analysis, mapState } from '../state.js';
import { on, stateBlock } from './dom.js';

const STEP_ICON = { ok: '✓', unavailable: '⚠', partial: '◐', failed: '✕', skipped: '–', running: '', pending: '○' };
const STEP_WORD = {
    ok: 'Done', unavailable: 'Unavailable', partial: 'Partial', failed: 'Failed',
    skipped: 'Skipped', running: 'Running', pending: 'Waiting',
};

function jobBlock(job) {
    const p = jobProgress(job);
    const steps = job.steps.map((s) => `
        <li class="step step-${esc(s.status)}">
            <span class="step-icon" aria-hidden="true">${s.status === 'running' ? '<span class="spinner spinner-sm"></span>' : STEP_ICON[s.status] || '○'}</span>
            <div><p class="step-label">${esc(s.label)} <span class="step-word">${esc(STEP_WORD[s.status] || s.status)}</span></p>
                ${s.detail ? `<p class="step-detail">${esc(s.detail)}</p>` : ''}</div>
        </li>`).join('');
    const what = `${job.type_label || 'Analysis'} — ${job.name}`;
    const head = {
        queued: 'Queued…', running: `Running: ${what}`,
        completed: `Finished: ${what}`, failed: `Failed: ${what}`,
    }[job.state];
    const partial = job.steps.some((s) => s.status === 'unavailable' || s.status === 'partial');
    const slow = job.type !== 'flood_forecast' && (job.state === 'running' || job.state === 'queued');
    return `
        <section class="block job" aria-live="polite">
            <h3>${esc(head)}</h3>
            <p class="muted">${p.done} of ${p.total} steps · started ${esc(timeAgo(job.created_at))}${slow ? ' · satellite analyses take 1–3 minutes' : ''}</p>
            <ol class="steps">${steps}</ol>
            ${job.state === 'failed' ? stateBlock({ kind: 'error', title: 'Analysis could not be completed', text: job.error || '' }) : ''}
            ${job.state === 'completed' ? `
                ${partial ? '<p class="banner banner-warn" role="note">Some inputs were unavailable — see the steps above. The result says what it could not include.</p>' : ''}
                <button type="button" class="btn btn-primary" data-action="open-result">Open result</button>` : ''}
        </section>`;
}

function typeCards(current) {
    return ANALYSIS_TYPES.map((t) => `
        <label class="type-card${t.id === current ? ' is-on' : ''}">
            <input type="radio" name="analysis-type" value="${t.id}" ${t.id === current ? 'checked' : ''}>
            <span><strong>${esc(t.label)}</strong> <small>${esc(t.sensor)}</small><br><span class="type-blurb">${esc(t.blurb)}</span></span>
        </label>`).join('');
}

function render(root) {
    const a = analysis.get();
    const { drawing } = mapState.get();
    const b = a.bbox;
    const spec = ANALYSIS_TYPES.find((t) => t.id === a.type);
    const aoiProblem = b ? validateAoi(b) : null;
    const problem = b ? validateAnalysis(a.type, b, a.before, a.after) : null;
    const busy = a.submitting || (a.job && (a.job.state === 'queued' || a.job.state === 'running'));
    const val = (k) => (b ? b[k] : '');
    const today = isoDay(new Date());
    root.innerHTML = `
        <section class="block">
            <h3><span class="step-no">1</span> Choose an area</h3>
            <div class="btn-row">
                ${drawing
                    ? '<button type="button" class="btn btn-sm is-active" data-action="cancel-draw">Cancel drawing</button>'
                    : '<button type="button" class="btn btn-sm" data-action="draw">Draw rectangle on map</button>'}
                <button type="button" class="btn btn-sm" data-action="use-view">Use current map view</button>
            </div>
            ${drawing ? '<p class="banner banner-info" role="status">Drag on the map to draw the area.</p>' : ''}
            <form class="place-row" data-place-form>
                <label class="sr-only" for="aoi-place">Place name or coordinates</label>
                <input id="aoi-place" type="text" maxlength="120" placeholder="Or a place, e.g. Dandeli" value="${esc(a.place)}" data-place>
                <label class="sr-only" for="aoi-radius">Radius</label>
                <select id="aoi-radius" data-radius>
                    ${[5, 10, 20, 30].map((km) => `<option value="${km}" ${km === a.radiusKm ? 'selected' : ''}>${km} km</option>`).join('')}
                </select>
                <button type="submit" class="btn btn-sm" ${a.placeBusy ? 'disabled' : ''}>${a.placeBusy ? 'Finding…' : 'Find'}</button>
            </form>
            ${a.placeNote ? `<p class="${a.placeNote.ok ? 'muted' : 'field-error'}" ${a.placeNote.ok ? '' : 'role="alert"'}>${esc(a.placeNote.text)}</p>` : ''}
            <div class="coords" role="group" aria-label="Area coordinates in decimal degrees">
                <label>North<input type="number" step="0.0001" data-coord="north" value="${val('north')}" inputmode="decimal"></label>
                <label>West<input type="number" step="0.0001" data-coord="west" value="${val('west')}" inputmode="decimal"></label>
                <label>East<input type="number" step="0.0001" data-coord="east" value="${val('east')}" inputmode="decimal"></label>
                <label>South<input type="number" step="0.0001" data-coord="south" value="${val('south')}" inputmode="decimal"></label>
            </div>
            ${b && aoiProblem ? `<p class="field-error" role="alert">${esc(aoiProblem)}</p>` : ''}
            ${b && !aoiProblem ? `<p class="muted">Area ${(b.north - b.south).toFixed(2)}° × ${(b.east - b.west).toFixed(2)}° selected.</p>` : ''}
            ${!b ? '<p class="muted">No area selected yet.</p>' : ''}
            <label class="sr-only" for="aoi-name">Area name</label>
            <input id="aoi-name" type="text" maxlength="80" placeholder="Name this area, e.g. Koshi barrage" value="${esc(a.name)}" data-name>
        </section>
        <section class="block">
            <h3><span class="step-no">2</span> Choose an analysis</h3>
            <div class="type-cards" role="radiogroup" aria-label="Analysis type">${typeCards(a.type)}</div>
            ${spec.dates ? `
                <div class="date-pair">
                    <label>Before (reference)<input type="date" data-date="before" value="${esc(a.before)}" max="${today}"></label>
                    <label>After (event)<input type="date" data-date="after" value="${esc(a.after)}" max="${today}"></label>
                </div>
                <p class="muted">The nearest usable image to each date is used (within about three weeks). Area limit: ${spec.maxSpan}° per side.</p>` : ''}
            ${b && !aoiProblem && problem ? `<p class="field-error" role="alert">${esc(problem)}</p>` : ''}
        </section>
        <section class="block">
            <h3><span class="step-no">3</span> Run</h3>
            <button type="button" class="btn btn-primary" data-action="run" ${busy || !b || problem ? 'disabled' : ''}>
                ${busy ? 'Running…' : `Run ${esc(spec.label.toLowerCase())}`}</button>
            ${a.error ? stateBlock({ kind: 'error', title: a.error.title, text: a.error.text }) : ''}
        </section>
        ${a.job ? jobBlock(a.job) : ''}`;
}

export function mountAnalysisPanel(root) {
    on(root, 'click', '[data-action]', (_e, el) => {
        const action = el.dataset.action;
        if (action === 'draw') startDrawing();
        if (action === 'cancel-draw') cancelDrawing();
        if (action === 'use-view') useCurrentView();
        if (action === 'run') runAnalysis();
        if (action === 'open-result') { const id = analysis.get().job?.event_id; if (id) selectEvent(id); }
    });
    on(root, 'change', '[data-coord]', () => {
        const read = (k) => Number.parseFloat(root.querySelector(`[data-coord="${k}"]`).value);
        const bbox = { south: read('south'), north: read('north'), west: read('west'), east: read('east') };
        if (Object.values(bbox).every(Number.isFinite)) setAoi(bbox);
    });
    on(root, 'change', 'input[name="analysis-type"]', (_e, el) => setAnalysisType(el.value));
    on(root, 'submit', '[data-place-form]', (e) => { e.preventDefault(); setAoiFromPlace(); });
    on(root, 'change', '[data-radius]', (_e, el) => analysis.set({ radiusKm: Number(el.value) }));
    on(root, 'change', '[data-date]', (_e, el) => analysis.set({ [el.dataset.date]: el.value, error: null }));
    // Name edits must not re-render (would steal focus mid-typing).
    let typing = false;
    on(root, 'input', '[data-name]', (_e, el) => { typing = true; analysis.set({ name: el.value }); typing = false; });
    on(root, 'input', '[data-place]', (_e, el) => { typing = true; analysis.set({ place: el.value }); typing = false; });
    const draw = () => {
        if (typing) return;
        // Job updates arrive while the user may be typing — keep focus and caret.
        const active = document.activeElement;
        let key = null;
        if (root.contains(active)) {
            if (active.dataset.coord) key = `[data-coord="${active.dataset.coord}"]`;
            else if (active.dataset.date) key = `[data-date="${active.dataset.date}"]`;
            else if (active.matches('[data-name]')) key = '[data-name]';
            else if (active.matches('[data-place]')) key = '[data-place]';
            else if (active.name === 'analysis-type') key = 'input[name="analysis-type"]:checked';
        }
        const caret = key === '[data-name]' || key === '[data-place]' ? active.selectionStart : null;
        render(root);
        if (key) {
            const el = root.querySelector(key);
            el?.focus();
            if (caret !== null) el?.setSelectionRange(caret, caret);
        }
    };
    analysis.subscribe(draw);
    mapState.subscribe(draw, (s) => s.drawing);
    draw();
}
