/**
 * Prithvi Drishti operations dashboard — bootstrap.
 *
 * Wires the stores to the map and the panels. Data only moves one way:
 * action → store → every view that reads it. That is what keeps the event
 * list, map, detail panel, timeline and assistant showing the same thing.
 */
import {
    applyJob, bindMap, cancelDrawing, finishDrawing, loadEvents, loadSystem, openPanel,
    resumeAnalysis, selectEvent,
} from './actions.js';
import { fmtDateTime } from './format.js';
import { createMap } from './map/map.js';
import { eventBounds, eventFeatures, filterEvents } from './model.js';
import { data, filters, mapState, ui } from './state.js';
import { mountAnalysisPanel } from './ui/analysis-panel.js';
import { mountAssistantPanel } from './ui/assistant-panel.js';
import { mountCompare } from './ui/compare-view.js';
import { mountDetailPanel } from './ui/detail-panel.js';
import { mountEventsPanel } from './ui/events-panel.js';
import { mountLayersPanel } from './ui/layers-panel.js';
import { mountMonitorPanel } from './ui/monitor-panel.js';
import { mountSearch } from './ui/search.js';
import { mountSystem } from './ui/system-panel.js';
import { mountTimeline } from './ui/timeline.js';
import { connect, onConnectionChange, onMessage } from '../websocket.js';

const PANEL_TITLES = {
    events: 'Events', monitor: 'Environmental monitoring', layers: 'Map layers', analyse: 'Analyse an area',
    assistant: 'Assistant', system: 'System status',
};
const $ = (sel) => document.querySelector(sel);
const body = (name) => $(`[data-panel-body="${name}"]`);

function initMap() {
    const mapEl = $('#map');
    try {
        const map = createMap(mapEl, {
            basemap: mapState.get().basemap,
            imageryDate: mapState.get().imageryDate,
            onEventClick: (id) => selectEvent(id, { fit: false }),
            onAoiDrawn: (bbox) => { finishDrawing(bbox); if (bbox) ui.set({ panel: 'analyse', panelOpen: true }); },
        });
        bindMap(map);
        return map;
    } catch (e) {
        // No WebGL: the panels still work as a full, accessible list view.
        console.error('Map failed to start', e);
        const box = $('#map-error');
        box.hidden = false;
        box.innerHTML = '<p><strong>The map could not start.</strong> This browser has no WebGL. Events, analysis and the assistant still work from the panels.</p>';
        return null;
    }
}

function syncMap(map) {
    if (!map) return;
    const pushEvents = () => {
        const { events, selectedId, highlightIds } = data.get();
        const items = filterEvents(events.data?.items || [], filters.get());
        // A selected event stays on the map even if a filter hides it from the list.
        const selected = (events.data?.items || []).find((e) => e.id === selectedId);
        if (selected && !items.includes(selected)) items.push(selected);
        map.setEvents(eventFeatures(items, selectedId, highlightIds));
    };
    data.subscribe(pushEvents, (s) => s.events);
    data.subscribe(pushEvents, (s) => s.selectedId);
    data.subscribe(pushEvents, (s) => s.highlightIds);
    filters.subscribe(pushEvents);
    pushEvents();

    const pushAssets = () => {
        const { assets } = data.get();
        map.setAssets(assets.status === 'ready' && assets.data.status === 'available' ? assets.data.geojson : null);
    };
    data.subscribe(pushAssets, (s) => s.assets);

    // Detected extent + the detection's own imagery.
    const pushExtent = () => {
        const { geometry, detail } = data.get();
        const g = geometry.status === 'ready' && geometry.data.available ? geometry.data : null;
        const secondary = g ? Object.values(g.secondary)[0] || null : null;
        map.setExtent(g ? g.extent : null, secondary, detail.data?.event.type);
    };
    const pushOverlay = () => {
        const { geometry } = data.get();
        const { overlay, overlayOpacity } = mapState.get();
        const g = geometry.status === 'ready' && geometry.data.available ? geometry.data : null;
        const image = g && g.overlays.find((o) => o.id === overlay);
        map.setOverlay(image ? { url: image.url, coordinates: g.overlay_coordinates, opacity: overlayOpacity } : null);
    };
    data.subscribe(() => { pushExtent(); pushOverlay(); }, (s) => s.geometry);
    mapState.subscribe(pushOverlay, (s) => s.overlay);

    const pushLayers = () => {
        const { layers } = mapState.get();
        Object.entries(layers).forEach(([id, s]) => map.setLayer(id, s));
    };
    mapState.subscribe(pushLayers, (s) => s.layers);
    mapState.subscribe((s) => map.setBasemap(s.basemap), (s) => s.basemap);
    mapState.subscribe((s) => map.setImageryDate(s.imageryDate), (s) => s.imageryDate);
    pushLayers();

    // Frame the current events once, on first load.
    let framed = false;
    data.subscribe((s) => {
        if (framed || s.events.status !== 'ready') return;
        framed = true;
        const current = s.events.data.items.filter((e) => e.status !== 'past');
        const target = current.length ? current : s.events.data.items.slice(0, 8);
        if (!target.length || data.get().selectedId) return;
        const boxes = target.map(eventBounds);
        map.fit([
            [Math.min(...boxes.map((b) => b[0][0])), Math.min(...boxes.map((b) => b[0][1]))],
            [Math.max(...boxes.map((b) => b[1][0])), Math.max(...boxes.map((b) => b[1][1]))],
        ], 8);
    }, (s) => s.events);

    // Layout changes resize the canvas.
    const resize = () => requestAnimationFrame(() => map.resize());
    ui.subscribe(resize);
    window.addEventListener('resize', resize);
}

function initShell() {
    document.querySelectorAll('.rail [data-panel]').forEach((btn) => {
        btn.addEventListener('click', () => openPanel(btn.dataset.panel));
    });
    $('#panel-close').addEventListener('click', () => ui.set({ panelOpen: false }));

    const apply = () => {
        const { panel, panelOpen } = ui.get();
        document.body.classList.toggle('panel-open', panelOpen);
        $('#panel').hidden = !panelOpen;
        $('#panel-title').textContent = PANEL_TITLES[panel];
        Object.keys(PANEL_TITLES).forEach((name) => { body(name).hidden = name !== panel; });
        document.querySelectorAll('.rail [data-panel]').forEach((btn) => {
            btn.setAttribute('aria-pressed', String(panelOpen && btn.dataset.panel === panel));
        });
    };
    ui.subscribe(apply);
    apply();

    const hint = $('#draw-hint');
    mapState.subscribe((s) => { hint.hidden = !s.drawing; }, (s) => s.drawing);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mapState.get().drawing) cancelDrawing(); });

    const clock = $('#clock');
    const tick = () => { clock.textContent = fmtDateTime(new Date()); clock.dateTime = new Date().toISOString(); };
    tick();
    setInterval(tick, 20000);
}

function initRealtime() {
    onConnectionChange((state) => data.set({ connection: state }));
    let refreshTimer = null;
    const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(loadEvents, 800); };
    // A new forecast (or the snapshot after a reconnect) means the event list changed.
    onMessage('flood_forecasts', refreshSoon);
    onMessage('initial_state', refreshSoon);
    onMessage('analysis_progress', (job) => applyJob(job));
    connect(window.PRITHVIDRISHTI_CONFIG.wsUrl);

    // REST stays the source of truth: poll as a backstop when the socket is down or quiet.
    setInterval(() => { if (!document.hidden) loadEvents(); }, 90000);
    setInterval(() => { if (!document.hidden) loadSystem(); }, 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadEvents(); });
}

function bootstrap() {
    // Small screens start with the map visible, not a sheet.
    if (window.matchMedia('(max-width: 860px)').matches) ui.set({ panelOpen: false });

    initShell();
    const map = initMap();
    mountEventsPanel(body('events'));
    mountMonitorPanel(body('monitor'));
    mountLayersPanel(body('layers'));
    mountAnalysisPanel(body('analyse'));
    mountAssistantPanel(body('assistant'));
    mountSystem(body('system'), $('#status-pill'));
    mountDetailPanel($('#detail'));
    mountTimeline($('#timeline'));
    mountSearch($('.search'));
    mountCompare($('#compare'), () => (map ? map.view() : { center: [84, 24], zoom: 4 }));
    syncMap(map);
    initRealtime();

    loadEvents();
    loadSystem();
    resumeAnalysis();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
else bootstrap();
