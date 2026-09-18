/**
 * Reactivity instrumentation used by the performance e2e spec.
 *
 * Everything here is inert unless `window.env.E2E_TEST === 'true'`, following
 * the same convention the components use to disable Mantine transitions. In a
 * normal run the counters are never installed and `countRender`/`countRedraw`
 * are single boolean checks.
 *
 * The spec drives this through `window.__ibexPerf`: `reset()` before an
 * interaction, `snapshot()` after it. Counts (not wall-clock) are the primary
 * metric because they are deterministic and therefore safe to assert in CI.
 */

export interface PerfSnapshot {
  /** Number of HTTP requests issued to the backend since the last reset. */
  fetchCount: number;
  /** URLs of those requests, in order, so a spec can assert which endpoint. */
  fetchUrls: string[];
  /** Component render counts, keyed by `"<component>:<instance>"`. */
  renders: Record<string, number>;
  /** Plotly redraw counts, keyed by grid id. */
  redraws: Record<string, number>;
}

interface PerfApi extends PerfSnapshot {
  reset: () => void;
  snapshot: () => PerfSnapshot;
}

declare global {
  interface Window {
    __ibexPerf?: PerfApi;
  }
}

const isEnabled = (): boolean =>
  typeof window !== 'undefined' && window.env?.E2E_TEST === 'true';

/**
 * Installs the counters and wraps `window.fetch`. Called once from the renderer
 * entrypoint; repeated calls are ignored so hot reload cannot double-wrap.
 */
export const installPerfCounters = (): void => {
  if (!isEnabled() || window.__ibexPerf) return;

  const api: PerfApi = {
    fetchCount: 0,
    fetchUrls: [],
    renders: {},
    redraws: {},
    reset() {
      api.fetchCount = 0;
      api.fetchUrls = [];
      api.renders = {};
      api.redraws = {};
    },
    snapshot() {
      return {
        fetchCount: api.fetchCount,
        fetchUrls: [...api.fetchUrls],
        renders: { ...api.renders },
        redraws: { ...api.redraws },
      };
    },
  };

  window.__ibexPerf = api;

  // Every renderer -> backend call goes through fetchFromApi, which uses the
  // global fetch, so this is the single accounting point for backend traffic.
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    api.fetchCount += 1;
    api.fetchUrls.push(url);
    return originalFetch(input, init);
  };
};

/** Records one render of `key`. No-op outside E2E runs. */
export const countRender = (key: string): void => {
  const perf = window.__ibexPerf;
  if (!perf) return;
  perf.renders[key] = (perf.renders[key] ?? 0) + 1;
};

/** Records one Plotly redraw for `gridId`. No-op outside E2E runs. */
export const countRedraw = (gridId: string): void => {
  const perf = window.__ibexPerf;
  if (!perf) return;
  perf.redraws[gridId] = (perf.redraws[gridId] ?? 0) + 1;
};
