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

import { clearRequestCache, getRequestCacheStats } from './requestCache';

/** Request-cache counters, mirrored from requestCache.ts. */
export interface PerfCacheStats {
  hits: number;
  dedup: number;
  misses: number;
  evictions: number;
  skipped: number;
  entries: number;
  bytes: number;
}

export interface PerfSnapshot {
  /** Number of HTTP requests issued to the backend since the last reset. */
  fetchCount: number;
  /** URLs of those requests, in order, so a spec can assert which endpoint. */
  fetchUrls: string[];
  /** Component render counts, keyed by `"<component>:<instance>"`. */
  renders: Record<string, number>;
  /** Plotly redraw counts, keyed by grid id. */
  redraws: Record<string, number>;
  /** Cumulative request-cache counters (not reset between measurements). */
  cache: PerfCacheStats;
}

interface PerfApi {
  reset: () => void;
  snapshot: () => PerfSnapshot;
  clearRequestCache: () => void;
}

declare global {
  interface Window {
    __ibexPerf?: PerfApi;
  }
}

const counters = {
  fetchCount: 0,
  fetchUrls: [] as string[],
  renders: {} as Record<string, number>,
  redraws: {} as Record<string, number>,
};

const isEnabled = (): boolean =>
  typeof window !== 'undefined' && window.env?.E2E_TEST === 'true';

/**
 * Installs the counters and wraps `window.fetch`. Called once from the renderer
 * entrypoint; repeated calls are ignored so hot reload cannot double-wrap.
 */
export const installPerfCounters = (): void => {
  if (!isEnabled() || window.__ibexPerf) return;

  const api: PerfApi = {
    reset() {
      counters.fetchCount = 0;
      counters.fetchUrls = [];
      counters.renders = {};
      counters.redraws = {};
    },
    snapshot() {
      return {
        fetchCount: counters.fetchCount,
        fetchUrls: [...counters.fetchUrls],
        renders: { ...counters.renders },
        redraws: { ...counters.redraws },
        cache: getRequestCacheStats(),
      };
    },
    clearRequestCache,
  };

  window.__ibexPerf = api;

  // Every renderer -> backend call goes through fetchFromApi, which uses the
  // global fetch, so this is the single accounting point for backend traffic.
  // Note this counts requests that actually reach the network: a cache hit
  // never gets here, which is exactly what the benchmark asserts on.
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    counters.fetchCount += 1;
    counters.fetchUrls.push(url);
    return originalFetch(input, init);
  };
};

/** Records one render of `key`. No-op outside E2E runs. */
export const countRender = (key: string): void => {
  if (!window.__ibexPerf) return;
  counters.renders[key] = (counters.renders[key] ?? 0) + 1;
};

/** Records one Plotly redraw for `gridId`. No-op outside E2E runs. */
export const countRedraw = (gridId: string): void => {
  if (!window.__ibexPerf) return;
  counters.redraws[gridId] = (counters.redraws[gridId] ?? 0) + 1;
};
