/**
 * View-model logic — pure functions over API payloads. No DOM, no fetch:
 * filtering, the timeline scale, chart series and map features all live here
 * so they can be unit-tested.
 */
import { SEVERITY, isoDay, parseTime } from './format.js';

const DAY = 86400000;

export const RANGE_PRESETS = [
    { id: '30d', label: '30 days', days: 30 },
    { id: '90d', label: '90 days', days: 90 },
    { id: '1y', label: '12 months', days: 365 },
    { id: 'all', label: 'All', days: null },
];

/** The time an event occupies: [start, end]. Open events run to `now`. */
export function eventSpan(event, now = new Date()) {
    const start = parseTime(event.detected_at) || now;
    const end = parseTime(event.ended_at) || (event.status === 'past' ? parseTime(event.updated_at) || start : now);
    return [start, end < start ? start : end];
}

/**
 * @param {object[]} events
 * @param {{rangeId?: string, minSeverity?: string|null, scope?: 'all'|'current'|'past'}} filters
 */
export function filterEvents(events, filters, now = new Date()) {
    const preset = RANGE_PRESETS.find((p) => p.id === filters.rangeId) || RANGE_PRESETS[3];
    const from = preset.days ? new Date(now.getTime() - preset.days * DAY) : null;
    const floor = filters.minSeverity ? SEVERITY[filters.minSeverity].rank : 0;
    return events.filter((e) => {
        if (SEVERITY[e.severity].rank < floor) return false;
        if (filters.scope === 'current' && e.status === 'past') return false;
        if (filters.scope === 'past' && e.status !== 'past') return false;
        if (filters.type && e.type !== filters.type) return false;
        if (from) {
            const [, end] = eventSpan(e, now);
            if (end < from) return false;
        }
        return true;
    });
}

/** Timeline window: 12 months back to one week ahead, snapped to month start. */
export function timelineWindow(now = new Date()) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const end = new Date(now.getTime() + 7 * DAY);
    const ticks = [];
    for (let i = 0; i < 13; i++) {
        const t = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
        if (t <= end) ticks.push(t);
    }
    return { start, end, ticks };
}

/** Position of a time inside a window as a 0..1 fraction (clamped). */
export function timeFraction(value, win) {
    const t = parseTime(value);
    if (!t) return null;
    const f = (t.getTime() - win.start.getTime()) / (win.end.getTime() - win.start.getTime());
    return Math.min(1, Math.max(0, f));
}

export function fractionToDate(fraction, win) {
    const f = Math.min(1, Math.max(0, fraction));
    return new Date(win.start.getTime() + f * (win.end.getTime() - win.start.getTime()));
}

/** Events started per month for the last 12 months, split by severity. */
export function eventsByMonth(events, now = new Date()) {
    const win = timelineWindow(now);
    const buckets = win.ticks.slice(0, 12).map((t) => ({
        month: t, total: 0, low: 0, medium: 0, high: 0, critical: 0,
    }));
    events.forEach((e) => {
        const d = parseTime(e.detected_at);
        if (!d) return;
        const idx = (d.getUTCFullYear() - win.start.getUTCFullYear()) * 12 + d.getUTCMonth() - win.start.getUTCMonth();
        if (idx >= 0 && idx < buckets.length) {
            buckets[idx].total += 1;
            buckets[idx][e.severity] += 1;
        }
    });
    return buckets;
}

/** Events → GeoJSON for the map: points for every event, polygons for forecast areas. */
export function eventFeatures(events, selectedId = null, highlightIds = []) {
    const highlight = new Set(highlightIds);
    const points = [];
    const areas = [];
    events.forEach((e) => {
        const props = {
            id: e.id, title: e.title, severity: e.severity, rank: SEVERITY[e.severity].rank,
            status: e.status, data_status: e.data_status,
            selected: e.id === selectedId, highlighted: highlight.has(e.id),
        };
        points.push({
            type: 'Feature', id: e.id, properties: props,
            geometry: { type: 'Point', coordinates: [e.center.lng, e.center.lat] },
        });
        if (e.bbox) {
            const { south: s, north: n, west: w, east: ea } = e.bbox;
            areas.push({
                type: 'Feature', id: e.id, properties: props,
                geometry: { type: 'Polygon', coordinates: [[[w, s], [ea, s], [ea, n], [w, n], [w, s]]] },
            });
        }
    });
    return {
        points: { type: 'FeatureCollection', features: points },
        areas: { type: 'FeatureCollection', features: areas },
    };
}

/** Bounds [[w,s],[e,n]] to frame an event (its area, or ~50 km around a point). */
export function eventBounds(event) {
    if (event.bbox) {
        return [[event.bbox.west, event.bbox.south], [event.bbox.east, event.bbox.north]];
    }
    const { lat, lng } = event.center;
    return [[lng - 0.5, lat - 0.4], [lng + 0.5, lat + 0.4]];
}

/**
 * Default before/after imagery dates for an event: ~3 weeks before it began
 * and the day it began (or yesterday, if that is still in the future — daily
 * imagery for "today" is usually not published yet).
 */
export function compareDates(event, now = new Date()) {
    const start = parseTime(event.detected_at) || now;
    const yesterday = new Date(now.getTime() - DAY);
    const after = start > yesterday ? yesterday : start;
    const before = new Date(after.getTime() - 21 * DAY);
    return { before: isoDay(before), after: isoDay(after) };
}

/** Validate an AOI before sending it; mirrors the backend rule (≤ 2° a side). */
export function validateAoi(bbox) {
    if (!bbox) return 'Select an area first.';
    const { south, north, west, east } = bbox;
    if (![south, north, west, east].every((v) => Number.isFinite(v))) return 'Coordinates must be numbers.';
    if (south >= north || west >= east) return 'South must be below north, and west left of east.';
    if (south < -90 || north > 90 || west < -180 || east > 180) return 'Coordinates are out of range.';
    if (north - south > 2 || east - west > 2) return 'Area is too large — keep it under 2° on each side.';
    return null;
}

export const EVENT_TYPES = {
    flood: { label: 'Flood', icon: '≈' },
    water_change: { label: 'Surface-water change', icon: '◍' },
    vegetation_change: { label: 'Vegetation change', icon: '❋' },
    forest_loss: { label: 'Forest loss', icon: '♣' },
};

export const ANALYSIS_TYPES = [
    { id: 'flood_forecast', label: 'Flood forecast', sensor: 'Rainfall model',
      blurb: 'Rainfall-driven forecast for the next days. Fast; no satellite image.', dates: false, maxSpan: 2 },
    { id: 'sar_flood', label: 'Flood detection (radar)', sensor: 'Sentinel-1',
      blurb: 'Compares two radar passes. Works through cloud; blind in built-up areas.', dates: true, maxSpan: 0.6, gapDays: 24 },
    { id: 'water_change', label: 'Surface-water change', sensor: 'Sentinel-2',
      blurb: 'New or lost open water between two optical images. Needs clear sky.', dates: true, maxSpan: 0.6, gapDays: 30 },
    { id: 'vegetation_change', label: 'Vegetation change', sensor: 'Sentinel-2',
      blurb: 'Potential vegetation loss between two dates. Compare the same season.', dates: true, maxSpan: 0.6, gapDays: 365 },
    { id: 'forest_loss', label: 'Forest loss (ForestGuard)', sensor: 'Sentinel-2 + Hansen + FIRMS',
      blurb: 'Vegetation loss on mapped tree cover, checked against the Hansen forest-loss record and fire detections.', dates: true, maxSpan: 0.6, gapDays: 365 },
];

/** Square of half-side `radiusKm` around a point, in degrees (same maths as the backend). */
export function radiusBbox(lat, lng, radiusKm) {
    const dLat = radiusKm / 111.32;
    const dLng = radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };
}

/** Default before/after dates (YYYY-MM-DD) for a satellite analysis type. */
export function defaultAnalysisDates(typeId, now = new Date()) {
    const spec = ANALYSIS_TYPES.find((t) => t.id === typeId);
    if (!spec || !spec.dates) return { before: '', after: '' };
    const after = new Date(now.getTime() - 5 * DAY);
    return { before: isoDay(new Date(after.getTime() - spec.gapDays * DAY)), after: isoDay(after) };
}

/** Validate an analysis request the way the backend will. */
export function validateAnalysis(typeId, bbox, before, after, now = new Date()) {
    const spec = ANALYSIS_TYPES.find((t) => t.id === typeId);
    if (!spec) return 'Choose an analysis.';
    const aoi = validateAoi(bbox);
    if (aoi) return aoi;
    if (bbox.north - bbox.south > spec.maxSpan || bbox.east - bbox.west > spec.maxSpan) {
        return `This analysis is limited to ${spec.maxSpan}° per side (about ${Math.round(spec.maxSpan * 110)} km). Choose a smaller area.`;
    }
    if (!spec.dates) return null;
    if (!before || !after) return 'Choose both dates.';
    if (after > isoDay(now)) return 'The “after” date is in the future.';
    if (before >= after) return 'The “before” date must be earlier than the “after” date.';
    return null;
}

export function roundBbox(bbox) {
    const r = (v) => Math.round(v * 10000) / 10000;
    return { south: r(bbox.south), north: r(bbox.north), west: r(bbox.west), east: r(bbox.east) };
}

/** Counts for the analysis step list header: "3 of 6 steps done". */
export function jobProgress(job) {
    if (!job) return { done: 0, total: 0, running: null };
    const finished = new Set(['ok', 'unavailable', 'partial', 'failed', 'skipped']);
    return {
        done: job.steps.filter((s) => finished.has(s.status)).length,
        total: job.steps.length,
        running: job.steps.find((s) => s.status === 'running') || null,
    };
}
