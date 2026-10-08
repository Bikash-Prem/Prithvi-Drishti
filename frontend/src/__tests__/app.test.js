import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, describeError, request } from '../app/api.js';
import {
    esc, fmtDate, fmtDateTime, fmtPercent, isoDay, measureText, parseTime, rangeText, timeAgo,
} from '../app/format.js';
import { LAYERS, initialLayerState } from '../app/map/catalog.js';
import {
    compareDates, defaultAnalysisDates, eventBounds, eventFeatures, eventSpan, eventsByMonth, filterEvents,
    ANALYSIS_TYPES, EVENT_TYPES, fractionToDate, jobProgress, radiusBbox, timeFraction, timelineWindow, validateAnalysis, validateAoi,
} from '../app/model.js';
import { createStore, failed, loading, ready } from '../app/store.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const ev = (over = {}) => ({
    id: 'e1', title: 'Flood forecast — Test', severity: 'high', status: 'forecast', kind: 'forecast',
    data_status: 'live', center: { lat: 27.7, lng: 85.3 },
    bbox: { south: 27.5, north: 28, west: 85, east: 85.7 },
    detected_at: '2026-10-07T06:00:00', updated_at: '2026-10-08T06:00:00', ended_at: null, ...over,
});

describe('format', () => {
    it('treats zone-less backend timestamps as UTC', () => {
        expect(parseTime('2026-10-08T06:00:00').toISOString()).toBe('2026-10-08T06:00:00.000Z');
        expect(parseTime('2026-10-08').toISOString()).toBe('2026-10-08T00:00:00.000Z');
        expect(parseTime('not a date')).toBeNull();
        expect(parseTime(null)).toBeNull();
    });

    it('formats dates and relative times without ever printing NaN', () => {
        expect(fmtDate('2026-10-08T06:00:00')).toBe('08 Oct 2026');
        expect(fmtDateTime('2026-10-08T06:05:00')).toBe('08 Oct 2026, 06:05 UTC');
        expect(fmtDate('garbage')).toBe('Date unknown');
        expect(timeAgo('2026-10-08T11:48:00', NOW)).toBe('12 min ago');
        expect(timeAgo('2026-09-02T12:00:00', NOW)).toBe('36 d ago');
        expect(timeAgo(undefined, NOW)).toBe('time unknown');
        expect(isoDay('2026-10-08T23:59:00')).toBe('2026-10-08');
        expect(fmtPercent(0.874)).toBe('87%');
        expect(fmtPercent(null)).toBeNull();
    });

    it('renders unknown measures as words with the reason, never as 0', () => {
        const na = measureText({ status: 'unavailable', value: null, reason: 'No population dataset.' });
        expect(na).toEqual({ available: false, text: 'Not available', reason: 'No population dataset.' });
        expect(measureText({ status: 'not_assessed', reason: 'x' }).text).toBe('Not assessed');
        expect(measureText(undefined).available).toBe(false);
        expect(measureText({ status: 'available', value: 782, unit: 'facilities' }).text).toBe('782 facilities');
        expect(measureText({ status: 'available', value: 1500, unit: 'facilities', lower_bound: true }).text).toBe('1,500+ facilities');
        const ranged = measureText({ status: 'available', value: 45, low: 42, high: 48, unit: 'km²' });
        expect(ranged.text).toBe('45 km²');
        expect(ranged.range).toBe('42–48');
        expect(measureText({ status: 'available', value: 0, low: 0, high: 0, unit: 'people' }).range).toBe('');
    });

    it('describes uncertainty ranges, including the no-spread case', () => {
        expect(rangeText({ unit: 'm', low: 0.2, value: 0.9, high: 2 })).toBe('0.20–2.00 m');
        expect(rangeText({ unit: 'm', low: 0.05, value: 0.05, high: 0.05 })).toBe('0.05 m (no spread)');
        expect(rangeText({ unit: 'fraction', value: 0.6 })).toBe('60%');
        expect(rangeText({ unit: 'm', value: null, low: null, high: null })).toBe('Not available');
        expect(rangeText({ unit: 'people', low: 313, value: 313, high: 418, decimals: 0 })).toBe('313–418 people');
        expect(rangeText({ unit: 'text', value: 'low to medium' })).toBe('low to medium');
    });

    it('escapes HTML from external feeds', () => {
        expect(esc('<img src=x onerror=1> & "q"')).toBe('&lt;img src=x onerror=1&gt; &amp; &quot;q&quot;');
    });
});

describe('store', () => {
    it('notifies only on real changes, and selectors narrow further', () => {
        const store = createStore({ a: 1, b: 1 });
        const all = vi.fn();
        const onlyA = vi.fn();
        store.subscribe(all);
        store.subscribe(onlyA, (s) => s.a);
        store.set({ a: 1 });
        expect(all).not.toHaveBeenCalled();
        store.set({ b: 2 });
        expect(all).toHaveBeenCalledTimes(1);
        expect(onlyA).not.toHaveBeenCalled();
        store.set((s) => ({ a: s.a + 1 }));
        expect(onlyA).toHaveBeenCalledTimes(1);
        expect(store.get()).toEqual({ a: 2, b: 2 });
    });

    it('keeps stale data alongside loading and error states', () => {
        expect(loading('old').data).toBe('old');
        expect(failed(new Error('x'), 'old')).toMatchObject({ status: 'error', data: 'old' });
        expect(ready('new')).toMatchObject({ status: 'ready', data: 'new', error: null });
    });
});

describe('api client', () => {
    afterEach(() => vi.unstubAllGlobals());
    const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });

    it('maps HTTP failures to explainable kinds with the server detail', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => respond(422, { detail: 'The area is too large.' })));
        await expect(request('/analysis', { body: {} })).rejects.toMatchObject({ kind: 'invalid', message: 'The area is too large.' });
        vi.stubGlobal('fetch', vi.fn(async () => respond(404, { detail: 'Event not found.' })));
        await expect(request('/events/x')).rejects.toMatchObject({ kind: 'not_found' });
        vi.stubGlobal('fetch', vi.fn(async () => respond(401, {})));
        await expect(request('/events')).rejects.toMatchObject({ kind: 'unauthorized' });
    });

    it('retries idempotent requests once, never POSTs', async () => {
        const flaky = vi.fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(respond(200, { ok: true }));
        vi.stubGlobal('fetch', flaky);
        await expect(request('/events')).resolves.toEqual({ ok: true });
        expect(flaky).toHaveBeenCalledTimes(2);

        const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        vi.stubGlobal('fetch', down);
        await expect(request('/analysis', { body: {} })).rejects.toMatchObject({ kind: 'offline' });
        expect(down).toHaveBeenCalledTimes(1);
    });

    it('reports caller cancellation distinctly', async () => {
        const controller = new AbortController();
        vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_res, rej) => {
            init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        })));
        const pending = request('/events', { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    });

    it('never surfaces raw status codes to users', () => {
        const d = describeError(new ApiError('server', '', 500));
        expect(d.title).toBe('Something went wrong');
        expect(`${d.title} ${d.text}`).not.toMatch(/500|Internal Server Error/);
        expect(describeError(new ApiError('offline', '')).retry).toBe(true);
        expect(describeError(new ApiError('unauthorized', '')).title).toBe('Permission denied');
        expect(describeError(new TypeError('boom')).title).toBe('Something went wrong');
    });
});

describe('view model', () => {
    const past = ev({ id: 'p', status: 'past', kind: 'reported', severity: 'critical', bbox: null,
        detected_at: '2026-06-01T00:00:00', ended_at: '2026-06-10T00:00:00', updated_at: '2026-06-11T00:00:00' });
    const low = ev({ id: 'l', severity: 'low' });

    it('filters by range, scope and severity', () => {
        const all = [ev(), past, low];
        expect(filterEvents(all, { rangeId: 'all', scope: 'all' }, NOW)).toHaveLength(3);
        expect(filterEvents(all, { rangeId: '30d', scope: 'all' }, NOW).map((e) => e.id)).toEqual(['e1', 'l']);
        expect(filterEvents(all, { rangeId: 'all', scope: 'past' }, NOW).map((e) => e.id)).toEqual(['p']);
        expect(filterEvents(all, { rangeId: 'all', scope: 'current', minSeverity: 'high' }, NOW).map((e) => e.id)).toEqual(['e1']);
    });

    it('spans open events to now and closed events to their end', () => {
        expect(eventSpan(ev(), NOW)[1]).toEqual(NOW);
        expect(eventSpan(past, NOW)[1].toISOString()).toBe('2026-06-10T00:00:00.000Z');
    });

    it('maps time to the timeline and back', () => {
        const win = timelineWindow(NOW);
        expect(win.start.toISOString()).toBe('2025-11-01T00:00:00.000Z');
        expect(win.ticks).toHaveLength(12);
        expect(timeFraction(win.start, win)).toBe(0);
        expect(timeFraction('1999-01-01', win)).toBe(0);
        expect(timeFraction('2999-01-01', win)).toBe(1);
        expect(timeFraction('nope', win)).toBeNull();
        const f = timeFraction('2026-06-01', win);
        expect(isoDay(fractionToDate(f, win))).toBe('2026-06-01');
    });

    it('buckets events by start month and severity', () => {
        const buckets = eventsByMonth([ev(), past, low], NOW);
        expect(buckets).toHaveLength(12);
        expect(buckets[7]).toMatchObject({ total: 1, critical: 1 });   // June
        expect(buckets[11]).toMatchObject({ total: 2, high: 1, low: 1 }); // October
        expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(3);
    });

    it('builds map features: a point for every event, a polygon only where an area exists', () => {
        const { points, areas } = eventFeatures([ev(), past], 'e1', ['p']);
        expect(points.features).toHaveLength(2);
        expect(areas.features).toHaveLength(1);
        expect(points.features[0].properties).toMatchObject({ selected: true, highlighted: false, rank: 2 });
        expect(points.features[1].properties).toMatchObject({ selected: false, highlighted: true, rank: 3 });
        expect(points.features[0].geometry.coordinates).toEqual([85.3, 27.7]);
        expect(eventBounds(ev())).toEqual([[85, 27.5], [85.7, 28]]);
        expect(eventBounds(past)[0][0]).toBeCloseTo(84.8);
    });

    it('never asks for imagery from the future', () => {
        expect(compareDates(past, NOW)).toEqual({ before: '2026-05-11', after: '2026-06-01' });
        const future = ev({ detected_at: '2026-10-08T11:00:00' });
        expect(compareDates(future, NOW).after).toBe('2026-10-07');
    });

    it('validates analysis areas like the backend does', () => {
        expect(validateAoi(null)).toMatch(/Select an area/);
        expect(validateAoi({ south: 27.6, north: 27.8, west: 85.2, east: 85.45 })).toBeNull();
        expect(validateAoi({ south: 28, north: 27, west: 85, east: 86 })).toMatch(/below north/);
        expect(validateAoi({ south: 20, north: 25, west: 85, east: 86 })).toMatch(/too large/);
        expect(validateAoi({ south: NaN, north: 1, west: 0, east: 1 })).toMatch(/numbers/);
    });

    it('validates satellite analyses and offers season-aware default dates', () => {
        const aoi = { south: 27.6, north: 27.8, west: 85.2, east: 85.45 };
        expect(validateAnalysis('flood_forecast', aoi, '', '', NOW)).toBeNull();
        expect(validateAnalysis('sar_flood', aoi, '2026-08-01', '2026-08-29', NOW)).toBeNull();
        expect(validateAnalysis('sar_flood', aoi, '', '2026-08-29', NOW)).toMatch(/both dates/);
        expect(validateAnalysis('sar_flood', aoi, '2026-09-01', '2026-08-29', NOW)).toMatch(/earlier/);
        expect(validateAnalysis('sar_flood', aoi, '2026-09-01', '2026-12-01', NOW)).toMatch(/future/);
        const wide = { south: 27, north: 28, west: 85, east: 85.5 };
        expect(validateAnalysis('flood_forecast', wide, '', '', NOW)).toBeNull();
        expect(validateAnalysis('vegetation_change', wide, '2025-10-01', '2026-10-01', NOW)).toMatch(/limited to 0.6°/);
        expect(defaultAnalysisDates('vegetation_change', NOW)).toEqual({ before: '2025-10-03', after: '2026-10-03' });
        expect(defaultAnalysisDates('flood_forecast', NOW)).toEqual({ before: '', after: '' });
        const veg = { ...ev({ id: 'v', type: 'vegetation_change' }) };
        expect(filterEvents([ev({ type: 'flood' }), veg], { rangeId: 'all', scope: 'all', type: 'vegetation_change' }, NOW).map((e) => e.id)).toEqual(['v']);
    });

    it('offers the ForestGuard analysis and turns a place + radius into an area', () => {
        const forest = ANALYSIS_TYPES.find((t) => t.id === 'forest_loss');
        expect(forest.dates && forest.maxSpan).toBe(0.6);
        expect(EVENT_TYPES.forest_loss.label).toBe('Forest loss');
        expect(defaultAnalysisDates('forest_loss', NOW)).toEqual({ before: '2025-10-03', after: '2026-10-03' });
        const box = radiusBbox(15.2475, 74.6186, 10);
        expect(box.north - box.south).toBeCloseTo(0.1797, 3);
        expect(box.east - box.west).toBeCloseTo(0.1862, 3);            // wider in degrees away from the equator
        expect(validateAnalysis('forest_loss', box, '2025-02-15', '2026-02-15', NOW)).toBeNull();
        expect(validateAnalysis('forest_loss', radiusBbox(15, 74, 40), '2025-02-15', '2026-02-15', NOW)).toMatch(/limited to 0.6°/);
    });

    it('summarises job progress', () => {
        const job = { steps: [{ status: 'ok' }, { status: 'unavailable' }, { status: 'running', key: 'x' }, { status: 'pending' }] };
        expect(jobProgress(job)).toMatchObject({ done: 2, total: 4, running: { key: 'x' } });
        expect(jobProgress(null)).toEqual({ done: 0, total: 0, running: null });
    });
});

describe('layer catalogue', () => {
    it('gives every unavailable layer a reason and every available one a source', () => {
        LAYERS.forEach((l) => {
            if (l.available) expect(l.source, l.id).toBeTruthy();
            else expect(l.reason, l.id).toBeTruthy();
        });
        const state = initialLayerState();
        expect(Object.keys(state)).toEqual(LAYERS.filter((l) => l.available).map((l) => l.id));
        expect(state.population).toBeUndefined();
        expect(state.extent).toEqual({ on: true, opacity: 0.85 });
    });
});
