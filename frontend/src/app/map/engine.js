/**
 * MapLibre GL entry point for the app.
 *
 * MapLibre 6 ships as ES modules and loads its worker from a sibling file.
 * Under a bundler that sibling path does not survive, so the worker is built
 * as a Vite worker asset and its URL handed to MapLibre once, here.
 */
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.setWorkerUrl(workerUrl);

export { maplibregl };
