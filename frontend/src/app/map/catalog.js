/**
 * Map catalogue — every basemap and layer the dashboard can show, with its
 * source and licence. Layers the platform cannot produce yet are listed as
 * unavailable with the reason, so the panel is honest about the gaps instead
 * of hiding them or showing placeholders.
 */

export const BASEMAPS = [
    {
        id: 'streets', label: 'Streets', source: 'OpenStreetMap',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
    {
        id: 'satellite', label: 'Satellite', source: 'Sentinel-2 cloudless 2020 (EOX)',
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'], maxzoom: 14,
        attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (contains modified Copernicus Sentinel data 2020), CC BY-NC-SA 4.0',
    },
    {
        id: 'terrain', label: 'Terrain', source: 'OpenTopoMap',
        tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'], maxzoom: 17,
        attribution: '© <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA), © OpenStreetMap contributors, SRTM',
    },
];

/**
 * Daily true-colour imagery (public domain). `{date}` is YYYY-MM-DD.
 *
 * VIIRS rather than MODIS: MODIS's 2,330 km swath leaves black wedges between
 * orbits near the equator; VIIRS's 3,040 km swath overlaps, so a day is
 * gap-free. The current UTC day is still being acquired (tiles are black or
 * missing), so the newest selectable date is yesterday — see `latestImageryDay`.
 */
export const IMAGERY = {
    label: 'VIIRS (Suomi NPP) true colour',
    provider: 'NASA GIBS',
    resolution: '375 m, daily',
    maxzoom: 9,
    attribution: 'Imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a> / VIIRS Suomi NPP',
    tiles: (date) => [
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
    ],
};

/** Newest day with complete imagery: yesterday (UTC), as YYYY-MM-DD. */
export function latestImageryDay(now = new Date()) {
    return new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
}

export const LAYER_GROUPS = ['Events', 'Observation', 'Exposure', 'Risk'];

export const LAYERS = [
    {
        id: 'events', group: 'Events', label: 'Event locations', available: true, defaultOn: true,
        source: 'Prithvi Drishti forecasts + GDACS', legend: 'severity', opacity: 1,
    },
    {
        id: 'areas', group: 'Events', label: 'Forecast areas', available: true, defaultOn: true,
        source: 'Prithvi Drishti forecast agent', legend: 'area', opacity: 0.9,
        note: 'The rectangle is the area the forecast covers — not a flood extent.',
    },
    {
        id: 'imagery', group: 'Observation', label: 'Daily satellite image', available: true, defaultOn: false,
        source: `${IMAGERY.provider} — ${IMAGERY.label}, ${IMAGERY.resolution}`, dated: true, opacity: 0.95,
        note: 'Context imagery for the timeline date. Clouds are common; this is not a flood detection.',
    },
    {
        id: 'extent', group: 'Observation', label: 'Detected extent', available: true, defaultOn: true,
        source: 'Sentinel-1 / Sentinel-2 analysis (baseline detectors)', legend: 'extent', opacity: 0.85,
        needsEvent: true,
        note: 'Flood, new-water or vegetation-loss polygons of the selected satellite detection.',
    },
    {
        id: 'assets', group: 'Exposure', label: 'Critical facilities', available: true, defaultOn: true,
        source: 'OpenStreetMap (Overpass)', legend: 'assets', opacity: 1, needsEvent: true,
        note: 'Hospitals, schools and emergency services in the selected event’s area.',
    },
    {
        id: 'population', group: 'Exposure', label: 'Population density map', available: false,
        reason: 'Population is counted per detection (HRSL); a map layer of it is not built.',
    },
    {
        id: 'risk', group: 'Risk', label: 'Risk surface', available: false,
        reason: 'Risk is assessed per event; a continuous risk surface needs vulnerability data.',
    },
];

export const SEVERITY_COLORS = {
    low: '#5fb37c', medium: '#e0b341', high: '#ef8a3c', critical: '#e5484d',
};

export const EXTENT_COLORS = {
    flood: '#3b9eff', water_change: '#22c7d6', vegetation_change: '#e8703a', forest_loss: '#e0409a',
    secondary: '#9ad36a',
};

export const OVERLAY_OPTIONS = [
    { id: 'none', label: 'Off' }, { id: 'before', label: 'Before' },
    { id: 'after', label: 'After' }, { id: 'change', label: 'Change' },
];

export const ASSET_COLORS = {
    hospital: '#ff6b81', clinic: '#ffa3b1', school: '#7cc4ff', fire_station: '#ff9f43',
    police: '#a29bfe', shelter: '#55d6a0', assembly_point: '#55d6a0',
    power_substation: '#f6d860', airport: '#c8d1dc',
};

export function initialLayerState() {
    const state = {};
    LAYERS.forEach((l) => {
        if (l.available) state[l.id] = { on: Boolean(l.defaultOn), opacity: l.opacity ?? 1 };
    });
    return state;
}
