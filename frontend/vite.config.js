import { defineConfig } from 'vite';

// Backend target is env-driven so the same config works for local dev
// (localhost) and Docker compose (http://backend:8000).
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8000';
const WS_BACKEND = BACKEND.replace(/^http/, 'ws');

export default defineConfig({
    root: '.',
    publicDir: 'public',
    server: {
        host: true,
        port: 5173,
        open: false,
        proxy: {
            '/api': { target: BACKEND, changeOrigin: true },
            '/auth': { target: BACKEND, changeOrigin: true },
            '/ws': { target: WS_BACKEND, ws: true },
        },
    },
    // MapLibre's worker is an ES module (see src/app/map/engine.js).
    worker: { format: 'es' },
    build: {
        outDir: 'dist',
        sourcemap: true,
        // Two pages: the landing page (/) and the operations dashboard.
        rollupOptions: {
            input: { main: 'index.html', dashboard: 'dashboard.html' },
        },
    },
});
