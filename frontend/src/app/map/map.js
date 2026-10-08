/**
 * Main map (MapLibre GL — WebGL, keyless).
 *
 * The map is a view: it draws what the stores say and reports user intent
 * (event clicked, area drawn, view moved) through callbacks. It holds no
 * application state of its own.
 */

import { assetLabel, esc } from '../format.js';
import { ASSET_COLORS, BASEMAPS, EXTENT_COLORS, IMAGERY, SEVERITY_COLORS } from './catalog.js';
import { maplibregl } from './engine.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

const severityColor = ['match', ['get', 'severity'],
    'low', SEVERITY_COLORS.low, 'medium', SEVERITY_COLORS.medium,
    'high', SEVERITY_COLORS.high, 'critical', SEVERITY_COLORS.critical, '#9aa4b1'];

const assetColor = ['match', ['get', 'asset_type'],
    ...Object.entries(ASSET_COLORS).flat(), '#c8d1dc'];

function buildStyle(basemapId, imageryDate) {
    const sources = {
        imagery: {
            type: 'raster', tiles: IMAGERY.tiles(imageryDate), tileSize: 256,
            maxzoom: IMAGERY.maxzoom, attribution: IMAGERY.attribution,
        },
        areas: { type: 'geojson', data: EMPTY },
        extent: { type: 'geojson', data: EMPTY },
        extent2: { type: 'geojson', data: EMPTY },
        aoi: { type: 'geojson', data: EMPTY },
        assets: { type: 'geojson', data: EMPTY },
        events: { type: 'geojson', data: EMPTY },
    };
    const layers = [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0f14' } }];
    BASEMAPS.forEach((b) => {
        sources[`base-${b.id}`] = {
            type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution,
        };
        layers.push({
            id: `base-${b.id}`, type: 'raster', source: `base-${b.id}`,
            layout: { visibility: b.id === basemapId ? 'visible' : 'none' },
        });
    });
    layers.push(
        { id: 'imagery', type: 'raster', source: 'imagery', layout: { visibility: 'none' } },
        {
            id: 'areas-fill', type: 'fill', source: 'areas',
            paint: { 'fill-color': severityColor, 'fill-opacity': ['case', ['get', 'selected'], 0.16, 0.07] },
        },
        {
            id: 'areas-line', type: 'line', source: 'areas',
            paint: {
                'line-color': severityColor, 'line-dasharray': [3, 2],
                'line-width': ['case', ['get', 'selected'], 2.5, 1.5],
            },
        },
        // Detected extent of the selected satellite detection (+ secondary: gain / water lost).
        { id: 'extent2-fill', type: 'fill', source: 'extent2', paint: { 'fill-color': EXTENT_COLORS.secondary, 'fill-opacity': 0.35 } },
        { id: 'extent-fill', type: 'fill', source: 'extent', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.5 } },
        { id: 'extent-line', type: 'line', source: 'extent', paint: { 'line-color': ['get', 'color'], 'line-width': 1.2 } },
        { id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#4da3ff', 'fill-opacity': 0.12 } },
        { id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#4da3ff', 'line-width': 2 } },
        {
            id: 'assets', type: 'circle', source: 'assets',
            paint: {
                'circle-color': assetColor,
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 11, 4.5, 14, 7],
                'circle-stroke-color': '#0b0f14', 'circle-stroke-width': 0.6,
            },
        },
        {
            // Ring behind selected / assistant-highlighted events.
            id: 'events-halo', type: 'circle', source: 'events',
            filter: ['any', ['get', 'selected'], ['get', 'highlighted']],
            paint: {
                'circle-radius': ['+', 9, ['*', 2, ['get', 'rank']]],
                'circle-color': 'rgba(0,0,0,0)',
                'circle-stroke-color': ['case', ['get', 'selected'], '#ffffff', '#4da3ff'],
                'circle-stroke-width': 2.5,
            },
        },
        {
            id: 'events', type: 'circle', source: 'events',
            paint: {
                // Size encodes severity as well as colour.
                'circle-radius': ['+', 5, ['*', 1.6, ['get', 'rank']]],
                'circle-color': severityColor,
                'circle-opacity': ['case', ['==', ['get', 'status'], 'past'], 0.55, 1],
                'circle-stroke-color': '#0b0f14', 'circle-stroke-width': 1.5,
            },
        },
    );
    return { version: 8, sources, layers };
}

/** GeoJSON polygon FeatureCollection for a {south,north,west,east} box. */
function bboxFeature(b) {
    if (!b) return EMPTY;
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature', properties: {},
            geometry: { type: 'Polygon', coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]] },
        }],
    };
}

/**
 * @param {HTMLElement} container
 * @param {{basemap: string, imageryDate: string, onEventClick: Function, onAoiDrawn: Function, onError?: Function}} opts
 */
export function createMap(container, opts) {
    const map = new maplibregl.Map({
        container,
        style: buildStyle(opts.basemap, opts.imageryDate),
        center: [84, 24],
        zoom: 3.4,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.touchZoomRotate.disableRotation();

    let ready = false;
    const pending = [];
    const whenReady = (fn) => { if (ready) fn(); else pending.push(fn); };
    map.on('load', () => { ready = true; pending.splice(0).forEach((fn) => fn()); });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'map-popup' });

    map.on('mouseenter', 'events', (e) => {
        if (draw) return;
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features[0];
        popup.setLngLat(f.geometry.coordinates.slice())
            .setHTML(`<strong>${esc(f.properties.title)}</strong><br>${esc(f.properties.severity.toUpperCase())}${f.properties.data_status === 'demo' ? ' · DEMO' : ''}`)
            .addTo(map);
    });
    map.on('mouseleave', 'events', () => { if (!draw) map.getCanvas().style.cursor = ''; popup.remove(); });
    map.on('click', 'events', (e) => { if (!draw) opts.onEventClick(e.features[0].properties.id); });
    map.on('click', 'areas-fill', (e) => {
        if (draw) return;
        // Points win when both are under the cursor.
        if (map.queryRenderedFeatures(e.point, { layers: ['events'] }).length) return;
        opts.onEventClick(e.features[0].properties.id);
    });
    map.on('click', 'assets', (e) => {
        if (draw) return;
        const f = e.features[0];
        new maplibregl.Popup({ offset: 8, className: 'map-popup' })
            .setLngLat(f.geometry.coordinates.slice())
            .setHTML(`<strong>${esc(f.properties.name || 'Unnamed')}</strong><br>${esc(assetLabel(f.properties.asset_type))} · OpenStreetMap`)
            .addTo(map);
    });
    map.on('mouseenter', 'assets', () => { if (!draw) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'assets', () => { if (!draw) map.getCanvas().style.cursor = ''; });

    // ── Rectangle AOI drawing ────────────────────────────────────────
    let draw = null;   // { start: LngLat|null }
    const boxFrom = (a, b) => ({
        south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
        west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
    });
    const onDown = (e) => {
        if (!draw) return;
        e.preventDefault();
        draw.start = e.lngLat;
    };
    const onMove = (e) => {
        if (!draw || !draw.start) return;
        map.getSource('aoi').setData(bboxFeature(boxFrom(draw.start, e.lngLat)));
    };
    const onUp = (e) => {
        if (!draw || !draw.start) return;
        const box = boxFrom(draw.start, e.lngLat);
        stopDraw();
        if (box.north - box.south > 1e-4 && box.east - box.west > 1e-4) opts.onAoiDrawn(box);
        else opts.onAoiDrawn(null);
    };
    function stopDraw() {
        draw = null;
        map.dragPan.enable();
        map.getCanvas().style.cursor = '';
    }
    ['mousedown', 'touchstart'].forEach((t) => map.on(t, onDown));
    ['mousemove', 'touchmove'].forEach((t) => map.on(t, onMove));
    ['mouseup', 'touchend'].forEach((t) => map.on(t, onUp));

    const LAYER_IDS = {
        events: ['events', 'events-halo'], areas: ['areas-fill', 'areas-line'],
        imagery: ['imagery'], assets: ['assets'], extent: ['extent-fill', 'extent-line', 'extent2-fill'],
    };
    const OPACITY_PROPS = {
        events: [['events', 'circle-opacity']], imagery: [['imagery', 'raster-opacity']],
        assets: [['assets', 'circle-opacity']], areas: [['areas-line', 'line-opacity']],
        extent: [['extent-fill', 'fill-opacity', 0.55], ['extent-line', 'line-opacity'], ['extent2-fill', 'fill-opacity', 0.4]],
    };

    return {
        raw: map,
        whenReady,
        setBasemap(id) {
            whenReady(() => BASEMAPS.forEach((b) => map.setLayoutProperty(
                `base-${b.id}`, 'visibility', b.id === id ? 'visible' : 'none')));
        },
        setLayer(id, { on, opacity }) {
            whenReady(() => {
                (LAYER_IDS[id] || []).forEach((layerId) => map.setLayoutProperty(
                    layerId, 'visibility', on ? 'visible' : 'none'));
                (OPACITY_PROPS[id] || []).forEach(([layerId, prop, scale = 1]) => {
                    // Past events stay dimmer than current ones at any opacity.
                    const value = id === 'events'
                        ? ['case', ['==', ['get', 'status'], 'past'], 0.55 * opacity, opacity] : opacity * scale;
                    map.setPaintProperty(layerId, prop, value);
                });
            });
        },
        setImageryDate(date) {
            whenReady(() => map.getSource('imagery').setTiles(IMAGERY.tiles(date)));
        },
        setEvents(features) {
            whenReady(() => {
                map.getSource('events').setData(features.points);
                map.getSource('areas').setData(features.areas);
            });
        },
        setAssets(geojson) { whenReady(() => map.getSource('assets').setData(geojson || EMPTY)); },
        /** Detected extent polygons; `type` picks the colour. */
        setExtent(collection, secondary, type) {
            whenReady(() => {
                const color = EXTENT_COLORS[type] || EXTENT_COLORS.flood;
                const tint = (fc) => (fc ? {
                    type: 'FeatureCollection',
                    features: fc.features.map((f) => ({ ...f, properties: { ...f.properties, color } })),
                } : EMPTY);
                map.getSource('extent').setData(tint(collection));
                map.getSource('extent2').setData(secondary || EMPTY);
            });
        },
        /** Drape one of the detection's own images (or remove it with null). */
        setOverlay(overlay) {
            whenReady(() => {
                if (map.getLayer('overlay')) map.removeLayer('overlay');
                if (map.getSource('overlay')) map.removeSource('overlay');
                if (!overlay) return;
                map.addSource('overlay', { type: 'image', url: overlay.url, coordinates: overlay.coordinates });
                map.addLayer({ id: 'overlay', type: 'raster', source: 'overlay',
                    paint: { 'raster-opacity': overlay.opacity ?? 1, 'raster-fade-duration': 0 } }, 'areas-fill');
            });
        },
        setAoi(bbox) { whenReady(() => map.getSource('aoi').setData(bboxFeature(bbox))); },
        fit(bounds, maxZoom = 11) {
            whenReady(() => map.fitBounds(bounds, {
                padding: fitPadding(container), maxZoom, duration: reducedMotion() ? 0 : 900,
            }));
        },
        startDraw() {
            draw = { start: null };
            map.dragPan.disable();
            map.getCanvas().style.cursor = 'crosshair';
            popup.remove();
        },
        cancelDraw: stopDraw,
        viewBounds() {
            const b = map.getBounds();
            return { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
        },
        view() { return { center: map.getCenter().toArray(), zoom: map.getZoom() }; },
        resize() { map.resize(); },
    };
}

function reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Keep fitted features clear of the panels that overlay the map. */
function fitPadding(container) {
    const wide = container.clientWidth > 900;
    if (!wide) return { top: 40, bottom: 120, left: 30, right: 30 };
    // The detail panel floats over the right side of the map when open.
    const detail = document.body.classList.contains('has-detail') ? 420 : 0;
    return { top: 60, bottom: 120, left: 60, right: 60 + detail };
}
