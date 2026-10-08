/**
 * Minimal observable stores. The app keeps several small stores (UI, map,
 * data, analysis, assistant) instead of one global object, so a view only
 * re-renders for the state it actually reads.
 */

/**
 * @template T
 * @param {T} initial
 */
export function createStore(initial) {
    let state = initial;
    const listeners = new Set();

    return {
        get: () => state,
        /** Shallow-merge a patch (or the result of an updater). No-op patches don't notify. */
        set(patch) {
            const next = typeof patch === 'function' ? patch(state) : patch;
            if (!next) return;
            let changed = false;
            for (const key of Object.keys(next)) {
                if (!Object.is(state[key], next[key])) { changed = true; break; }
            }
            if (!changed) return;
            const prev = state;
            state = { ...state, ...next };
            listeners.forEach((fn) => fn(state, prev));
        },
        /**
         * Subscribe; with `select`, the listener fires only when the selected
         * value changes (compared with Object.is).
         */
        subscribe(listener, select) {
            const wrapped = select
                ? (s, prev) => { if (!Object.is(select(s), select(prev))) listener(s, prev); }
                : listener;
            listeners.add(wrapped);
            return () => listeners.delete(wrapped);
        },
    };
}

/** Async resource states every data slice uses — one vocabulary for the UI. */
export const idle = () => ({ status: 'idle', data: null, error: null });
export const loading = (data = null) => ({ status: 'loading', data, error: null });
export const ready = (data) => ({ status: 'ready', data, error: null, loadedAt: Date.now() });
export const failed = (error, data = null) => ({ status: 'error', data, error });
