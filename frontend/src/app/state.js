/**
 * Application stores, split by concern (never one global object):
 *   ui        — which panel is open, compare mode
 *   mapState  — basemap, layer visibility/opacity, imagery date, AOI
 *   data      — events, selection, event detail, assets, system health
 *   filters   — event-list filters (also shade the timeline)
 *   analysis  — AOI draft + the running/finished analysis job
 *   assistant — conversation
 */
import { isoDay } from './format.js';
import { initialLayerState } from './map/catalog.js';
import { createStore, idle } from './store.js';

const DAY = 86400000;

export const ui = createStore({ panel: 'events', panelOpen: true, compare: false });

export const mapState = createStore({
    basemap: 'streets',
    layers: initialLayerState(),
    // Yesterday: daily imagery for "today" is usually not published yet.
    imageryDate: isoDay(new Date(Date.now() - DAY)),
    drawing: false,
    // Which of the selected detection's own images is draped on the map.
    overlay: 'none',          // 'none' | 'before' | 'after' | 'change'
    overlayOpacity: 1,
});

export const data = createStore({
    events: idle(),
    selectedId: null,
    detail: idle(),
    assets: idle(),
    geometry: idle(),       // detected extent + image overlays of the selected event
    monitoring: idle(),
    models: idle(),
    system: idle(),
    highlightIds: [],
    connection: 'connecting',
});

export const filters = createStore({ rangeId: 'all', minSeverity: null, scope: 'all', type: null });

export const analysis = createStore({
    name: '', bbox: null, job: null, submitting: false, error: null,
    type: 'flood_forecast', before: '', after: '',
    place: '', radiusKm: 10, placeBusy: false, placeNote: null,
});

export const assistant = createStore({ messages: [], busy: false });
