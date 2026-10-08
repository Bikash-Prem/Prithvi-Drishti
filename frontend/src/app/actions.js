/**
 * Actions — the only code that talks to the API and mutates the stores.
 * Views call these; the map and panels react to the resulting store changes,
 * which is what keeps list, map, detail panel and assistant in step.
 */
import { api, ApiError, describeError } from './api.js';
import { defaultAnalysisDates, eventBounds, radiusBbox, roundBbox, validateAnalysis } from './model.js';
import { latestImageryDay } from './map/catalog.js';
import { analysis, assistant, data, mapState, ui } from './state.js';
import { failed, idle, loading, ready } from './store.js';

const JOB_KEY = 'prithvidrishti.analysis.job';
let mapCtl = null;
let detailAbort = null;
let assetsAbort = null;
let geometryAbort = null;
let pollTimer = null;

export function bindMap(controller) { mapCtl = controller; }

const findEvent = (id) => (data.get().events.data?.items || []).find((e) => e.id === id) || null;

// ── events ───────────────────────────────────────────────────────────

export async function loadEvents() {
    const current = data.get().events;
    data.set({ events: loading(current.data) });   // keep stale list visible while refreshing
    try {
        const payload = await api.events();
        data.set({ events: ready(payload) });
        const selected = data.get().selectedId;
        if (selected && !payload.items.some((e) => e.id === selected)) clearSelection();
    } catch (e) {
        data.set({ events: failed(e, current.data) });
    }
}

export async function selectEvent(id, { fit = true } = {}) {
    if (!id) return;
    detailAbort?.abort();
    assetsAbort?.abort();
    geometryAbort?.abort();
    detailAbort = new AbortController();
    data.set({ selectedId: id, detail: loading(), assets: idle(), geometry: idle() });
    if (mapState.get().overlay !== 'none') mapState.set({ overlay: 'none' });
    const summary = findEvent(id);
    if (fit && summary && mapCtl) mapCtl.fit(eventBounds(summary));
    try {
        const detail = await api.event(id, detailAbort.signal);
        if (data.get().selectedId !== id) return;
        data.set({ detail: ready(detail) });
        if (fit && !summary && mapCtl) mapCtl.fit(eventBounds(detail.event));
        // Facilities already cached server-side → show them without a click.
        if (detail.event.assets_exposed.status === 'available') loadAssets(id);
        if (detail.has_geometry) loadGeometry(id);
    } catch (e) {
        if (e instanceof ApiError && e.kind === 'cancelled') return;
        if (data.get().selectedId === id) data.set({ detail: failed(e) });
    }
}

export function clearSelection() {
    detailAbort?.abort();
    assetsAbort?.abort();
    geometryAbort?.abort();
    data.set({ selectedId: null, detail: idle(), assets: idle(), geometry: idle() });
    if (mapState.get().overlay !== 'none') mapState.set({ overlay: 'none' });
    if (ui.get().compare) ui.set({ compare: false });
}

/** Critical facilities for the selected event (OpenStreetMap). */
export async function loadAssets(id) {
    assetsAbort?.abort();
    assetsAbort = new AbortController();
    data.set({ assets: loading() });
    try {
        const assets = await api.eventAssets(id, assetsAbort.signal);
        if (data.get().selectedId !== id) return;
        data.set({ assets: ready(assets) });
        // Forecast/report details embed the facility counts — refresh them.
        // (Detections already carry their in-extent facilities.)
        if (assets.status === 'available' && assets.scope !== 'extent') {
            const detail = await api.event(id);
            if (data.get().selectedId === id) data.set({ detail: ready(detail) });
            loadEvents();
        }
    } catch (e) {
        if (e instanceof ApiError && e.kind === 'cancelled') return;
        if (data.get().selectedId === id) data.set({ assets: failed(e) });
    }
}

/** Detected extent polygons + image overlays for a satellite detection. */
export async function loadGeometry(id) {
    geometryAbort?.abort();
    geometryAbort = new AbortController();
    data.set({ geometry: loading() });
    try {
        const geometry = await api.eventGeometry(id, geometryAbort.signal);
        if (data.get().selectedId === id) data.set({ geometry: ready(geometry) });
    } catch (e) {
        if (e instanceof ApiError && e.kind === 'cancelled') return;
        if (data.get().selectedId === id) data.set({ geometry: failed(e) });
    }
}

export async function loadMonitoring() {
    const current = data.get().monitoring;
    data.set({ monitoring: loading(current.data) });
    try {
        const [summary, models] = await Promise.all([api.monitoring(), api.models()]);
        data.set({ monitoring: ready(summary), models: ready(models) });
    } catch (e) {
        data.set({ monitoring: failed(e, current.data) });
    }
}

export function setOverlay(id) {
    mapState.set({ overlay: id });
}

export async function loadSystem() {
    const current = data.get().system;
    data.set({ system: loading(current.data) });
    try {
        data.set({ system: ready(await api.systemStatus()) });
    } catch (e) {
        data.set({ system: failed(e, current.data) });
    }
}

// ── map ──────────────────────────────────────────────────────────────

export function setLayer(id, patch) {
    const layers = mapState.get().layers;
    if (!layers[id]) return;
    mapState.set({ layers: { ...layers, [id]: { ...layers[id], ...patch } } });
}

export function setImageryDate(date, { show = false } = {}) {
    if (!date) return;
    const latest = latestImageryDay();
    mapState.set({ imageryDate: date > latest ? latest : date });
    if (show) setLayer('imagery', { on: true });
}

export function openPanel(panel) {
    const s = ui.get();
    // Tapping the active tab toggles the sheet (matters on small screens).
    if (s.panel === panel) ui.set({ panelOpen: !s.panelOpen });
    else ui.set({ panel, panelOpen: true });
    if (panel === 'system') loadSystem();
    if (panel === 'monitor') loadMonitoring();
}

export function goTo(lat, lng, zoomSpan = 0.25) {
    mapCtl?.fit([[lng - zoomSpan, lat - zoomSpan * 0.8], [lng + zoomSpan, lat + zoomSpan * 0.8]], 12);
}

// ── area analysis ────────────────────────────────────────────────────

export function setAoi(bbox, name) {
    const patch = { bbox: bbox ? roundBbox(bbox) : null, error: null };
    if (name !== undefined) patch.name = name;
    analysis.set(patch);
    mapCtl?.setAoi(patch.bbox);
}

/** Resolve a place name (or "lat, lng") and select the square of `radiusKm` around it. */
export async function setAoiFromPlace() {
    const { place, radiusKm } = analysis.get();
    const query = (place || '').trim();
    if (query.length < 2) {
        analysis.set({ placeNote: { ok: false, text: 'Type a place name or coordinates first.' } });
        return;
    }
    analysis.set({ placeBusy: true, placeNote: null });
    try {
        const found = await api.search(query);
        const hit = (found.results || []).find((r) => r.kind === 'coordinates' || r.kind === 'place');
        if (!hit) {
            analysis.set({ placeBusy: false, placeNote: { ok: false, text: found.place_error || `No place found for “${query}”.` } });
            return;
        }
        const label = [hit.title, hit.kind === 'place' ? hit.subtitle : ''].filter(Boolean).join(', ');
        const bbox = radiusBbox(hit.lat, hit.lng, radiusKm);
        setAoi(bbox, label.slice(0, 80));
        mapCtl?.fit([[bbox.west, bbox.south], [bbox.east, bbox.north]], 12);
        analysis.set({ placeBusy: false, placeNote: { ok: true, text: `${label} — ${radiusKm} km around ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)}.` } });
    } catch (e) {
        analysis.set({ placeBusy: false, placeNote: { ok: false, text: describeError(e).text } });
    }
}

export function startDrawing() {
    mapState.set({ drawing: true });
    mapCtl?.startDraw();
}

export function finishDrawing(bbox) {
    mapState.set({ drawing: false });
    if (bbox) setAoi(bbox);
    else mapCtl?.setAoi(analysis.get().bbox);
}

export function cancelDrawing() {
    mapCtl?.cancelDraw();
    finishDrawing(null);
}

export function useCurrentView() {
    if (mapCtl) setAoi(mapCtl.viewBounds());
}

export function setAnalysisType(type) {
    analysis.set({ type, error: null, ...defaultAnalysisDates(type) });
}

export async function runAnalysis() {
    const { bbox, name, type, before, after } = analysis.get();
    const problem = validateAnalysis(type, bbox, before, after);
    if (problem) { analysis.set({ error: { title: 'Check the request', text: problem, retry: false } }); return; }
    analysis.set({ submitting: true, error: null, job: null });
    try {
        const body = { name: (name || '').trim() || 'Selected area', bbox, type };
        if (before && after) Object.assign(body, { before, after });
        const job = await api.startAnalysis(body);
        analysis.set({ submitting: false });
        applyJob(job);
    } catch (e) {
        analysis.set({ submitting: false, error: describeError(e) });
    }
}

/** Accept a job update from the WebSocket or from polling. */
export function applyJob(job) {
    const current = analysis.get().job;
    if (current && current.job_id !== job.job_id) return;       // another client's job
    if (current && current.updated_at > job.updated_at) return;  // out-of-order update
    analysis.set({ job });
    try { localStorage.setItem(JOB_KEY, job.job_id); } catch { /* storage unavailable */ }

    const done = job.state === 'completed' || job.state === 'failed';
    clearTimeout(pollTimer);
    if (!done) {
        // Polling backs up the WebSocket so progress survives a dropped socket.
        pollTimer = setTimeout(() => pollJob(job.job_id), 2000);
        return;
    }
    try { localStorage.removeItem(JOB_KEY); } catch { /* storage unavailable */ }
    if (job.state === 'completed' && job.event_id && current?.state !== 'completed') {
        loadEvents().then(() => selectEvent(job.event_id));
        if (job.type !== 'flood_forecast') loadMonitoring();
    }
}

async function pollJob(jobId) {
    try {
        applyJob(await api.analysis(jobId));
    } catch (e) {
        if (e instanceof ApiError && e.kind === 'not_found') {
            analysis.set({
                job: null,
                error: { title: 'Analysis lost', text: 'The server restarted and the job was not kept. Run it again.', retry: false },
            });
            try { localStorage.removeItem(JOB_KEY); } catch { /* storage unavailable */ }
            return;
        }
        pollTimer = setTimeout(() => pollJob(jobId), 4000);
    }
}

/** After a reload, pick a still-running job back up. */
export function resumeAnalysis() {
    let jobId = null;
    try { jobId = localStorage.getItem(JOB_KEY); } catch { /* storage unavailable */ }
    if (jobId) pollJob(jobId);
}

// ── assistant ────────────────────────────────────────────────────────

export async function askAssistant(text) {
    const message = (text || '').trim();
    if (!message || assistant.get().busy) return;
    const push = (m) => assistant.set({ messages: [...assistant.get().messages, m] });
    push({ role: 'user', text: message });
    assistant.set({ busy: true });
    try {
        const reply = await api.assistant({ message, selected_event_id: data.get().selectedId });
        push({ role: 'assistant', answer: reply.answer, actions: reply.actions, intent: reply.intent });
        runActions(reply.actions);
    } catch (e) {
        push({ role: 'assistant', error: describeError(e) });
    } finally {
        assistant.set({ busy: false });
    }
}

/** Execute the assistant's structured map actions (a closed set). */
export function runActions(actions) {
    (actions || []).forEach((action) => {
        if (action.type === 'select_event') {
            data.set({ highlightIds: [] });
            selectEvent(action.event_id);
        } else if (action.type === 'highlight_events') {
            const ids = action.event_ids || [];
            data.set({ highlightIds: ids });
            const events = ids.map(findEvent).filter(Boolean);
            if (events.length && mapCtl) {
                const boxes = events.map(eventBounds);
                mapCtl.fit([
                    [Math.min(...boxes.map((b) => b[0][0])), Math.min(...boxes.map((b) => b[0][1]))],
                    [Math.max(...boxes.map((b) => b[1][0])), Math.max(...boxes.map((b) => b[1][1]))],
                ], 9);
            }
        } else if (action.type === 'fit_bounds' && action.bbox && mapCtl) {
            const b = action.bbox;
            mapCtl.fit([[b.west, b.south], [b.east, b.north]], 12);
        }
    });
}
