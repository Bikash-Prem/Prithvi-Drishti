/**
 * API client for the event-centric backend routes.
 *
 * One place for timeouts, cancellation, GET retries, the optional API key,
 * and for turning transport/HTTP failures into a small set of error kinds the
 * UI knows how to explain — users never see "500 Internal Server Error".
 */

const BASE = (typeof window !== 'undefined' && window.PRITHVIDRISHTI_CONFIG?.apiUrl) || '/api/v1';

export class ApiError extends Error {
    /**
     * @param {'offline'|'timeout'|'not_found'|'invalid'|'rate_limited'|'unauthorized'|'server'|'cancelled'} kind
     */
    constructor(kind, message, status = 0) {
        super(message);
        this.name = 'ApiError';
        this.kind = kind;
        this.status = status;
    }
}

const KIND_BY_STATUS = { 401: 'unauthorized', 403: 'unauthorized', 404: 'not_found', 422: 'invalid', 429: 'rate_limited' };

/** Plain-language title + advice for each failure kind. */
export function describeError(error) {
    const kind = error instanceof ApiError ? error.kind : 'server';
    const detail = error instanceof ApiError ? error.message : '';
    switch (kind) {
        case 'offline': return { title: 'Backend not reachable', text: 'The Prithvi Drishti server did not respond. Check that it is running, then retry.', retry: true };
        case 'timeout': return { title: 'Request timed out', text: 'The server or an upstream data provider took too long. Retry in a moment.', retry: true };
        case 'not_found': return { title: 'Not found', text: detail || 'This item no longer exists.', retry: false };
        case 'invalid': return { title: 'Request not accepted', text: detail || 'The request was invalid.', retry: false };
        case 'rate_limited': return { title: 'Too many requests', text: detail || 'Wait a moment and try again.', retry: true };
        case 'unauthorized': return { title: 'Permission denied', text: 'This server requires an API key that this page does not have.', retry: false };
        case 'cancelled': return { title: 'Cancelled', text: '', retry: false };
        default: return { title: 'Something went wrong', text: 'The server could not complete the request. Retry, and check the System panel if it persists.', retry: true };
    }
}

function headers(hasBody) {
    const h = {};
    if (hasBody) h['Content-Type'] = 'application/json';
    const key = (typeof window !== 'undefined' && window.PRITHVIDRISHTI_CONFIG?.API_KEY) || '';
    if (key) h['X-API-Key'] = key;
    return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} path
 * @param {{method?: string, body?: unknown, signal?: AbortSignal, timeout?: number, retries?: number}} [opts]
 */
export async function request(path, opts = {}) {
    const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
    const timeout = opts.timeout ?? 15000;
    // Only idempotent requests are retried.
    const retries = opts.retries ?? (method === 'GET' ? 1 : 0);

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(400 * attempt);
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
        const onAbort = () => controller.abort();
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const resp = await fetch(`${BASE}${path}`, {
                method,
                headers: headers(opts.body !== undefined),
                body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
                signal: controller.signal,
            });
            if (resp.ok) return await resp.json();
            let detail = '';
            try { detail = (await resp.json()).detail; } catch { /* non-JSON error body */ }
            const kind = KIND_BY_STATUS[resp.status] || 'server';
            const err = new ApiError(kind, typeof detail === 'string' ? detail : '', resp.status);
            if (kind !== 'server') throw err;   // 4xx: retrying won't help
            lastError = err;
        } catch (e) {
            if (e instanceof ApiError) throw e;
            if (opts.signal?.aborted) throw new ApiError('cancelled', 'cancelled');
            lastError = new ApiError(timedOut ? 'timeout' : 'offline', e?.message || '');
        } finally {
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
        }
    }
    throw lastError;
}

function qs(params) {
    const p = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
    });
    const s = p.toString();
    return s ? `?${s}` : '';
}

export const api = {
    events: (params, signal) => request(`/events${qs(params)}`, { signal, timeout: 25000 }),
    event: (id, signal) => request(`/events/${encodeURIComponent(id)}`, { signal }),
    // Overpass can be slow on first fetch; cached for a day server-side.
    eventAssets: (id, signal) => request(`/events/${encodeURIComponent(id)}/assets`, { signal, timeout: 60000, retries: 0 }),
    eventGeometry: (id, signal) => request(`/events/${encodeURIComponent(id)}/geometry`, { signal, timeout: 30000 }),
    monitoring: (signal) => request('/monitoring/summary', { signal }),
    models: (signal) => request('/models', { signal }),
    reportUrl: (id) => `${BASE}/events/${encodeURIComponent(id)}/report`,
    search: (q, signal) => request(`/search${qs({ q })}`, { signal, timeout: 10000, retries: 0 }),
    startAnalysis: (body) => request('/analysis', { body }),
    analysis: (jobId, signal) => request(`/analysis/${encodeURIComponent(jobId)}`, { signal }),
    systemStatus: (signal) => request('/system/status', { signal, timeout: 20000 }),
    assistant: (body, signal) => request('/assistant', { body, signal, timeout: 30000 }),
};
