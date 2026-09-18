/**
 * Session-scoped cache for backend GET requests.
 *
 * A data entry does not change while IBEX is open, so a response is valid for
 * the whole session and identical requests can be served without another round
 * trip.
 *
 * ## Why the raw body text is cached rather than the parsed object
 *
 * `fetchDataPlot` post-processes the parsed response *in place* (it renames
 * `data.name`, rewrites every `coord.target`, tensorizes irregular data, runs
 * the non-idempotent `transformComplexData`, then `replaceNullsWithNaN`), and
 * five call sites then alias the result straight into the store with
 * `plot.yData = response.data.value`. Those arrays are afterwards mutated in
 * place by `transposeAxis` and `applyRange`.
 *
 * Handing out a shared parsed object would therefore (a) re-apply the
 * non-idempotent transforms on a hit and (b) alias one grid's data to another
 * grid's, corrupting both and the cache entry with them. Caching the text and
 * parsing per hit yields a fresh object graph every time, leaves the whole
 * post-processing pipeline untouched, and makes byte accounting exact.
 * Parsing costs a few ms per MB — always far less than the request it replaces.
 */

/** Total budget for retained bodies. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Bodies above this are never retained. They are still de-duplicated while in
 * flight, they just do not get to evict everything else: a single 2-D payload
 * can be larger than the sum of every 1-D payload in the session.
 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Insertion-ordered, which is what makes plain `Map` usable as an LRU. */
const bodies = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
let totalBytes = 0;

const stats = {
  hits: 0,
  dedup: 0,
  misses: 0,
  evictions: 0,
  skipped: 0,
};

/**
 * Canonical key for a request URL: path plus query, with parameter *keys*
 * sorted but the order of repeated values preserved.
 *
 * Repeated parameters are semantic here — `operations`, `signal_operations` and
 * `interpolate_over` are ordered lists — so only the key order may be
 * normalised. The origin is dropped so a backend port change cannot look like a
 * different request.
 */
export const requestCacheKey = (url: string): string => {
  try {
    const parsed = new URL(url);
    const grouped = new Map<string, string[]>();
    for (const [key, value] of parsed.searchParams) {
      const values = grouped.get(key);
      if (values) values.push(value);
      else grouped.set(key, [value]);
    }
    const query = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) =>
        values.map((value) => `${key}=${encodeURIComponent(value)}`).join('&'),
      )
      .join('&');
    return query ? `${parsed.pathname}?${query}` : parsed.pathname;
  } catch {
    // Not an absolute URL: the raw string is still a stable key.
    return url;
  }
};

/** Returns a retained body, refreshing its recency. */
const takeCached = (key: string): string | undefined => {
  const body = bodies.get(key);
  if (body === undefined) return undefined;
  bodies.delete(key);
  bodies.set(key, body);
  return body;
};

/** Retains a body, evicting least-recently-used entries to stay in budget. */
const retain = (key: string, body: string): void => {
  if (body.length > MAX_ENTRY_BYTES) {
    stats.skipped += 1;
    return;
  }
  const existing = bodies.get(key);
  if (existing !== undefined) {
    totalBytes -= existing.length;
    bodies.delete(key);
  }
  while (bodies.size > 0 && totalBytes + body.length > MAX_TOTAL_BYTES) {
    const oldest = bodies.keys().next().value as string;
    totalBytes -= bodies.get(oldest).length;
    bodies.delete(oldest);
    stats.evictions += 1;
  }
  bodies.set(key, body);
  totalBytes += body.length;
};

/**
 * Runs `request` unless an identical one is cached or already in flight.
 *
 * @param url Absolute request URL, used to derive the cache key.
 * @param request Performs the request and resolves to the response body text.
 * @param cacheable `false` for probes such as `/info/version`, which must stay
 *   live. Those are still de-duplicated while in flight.
 */
export const cachedRequest = async (
  url: string,
  request: () => Promise<string>,
  cacheable = true,
): Promise<string> => {
  const key = requestCacheKey(url);

  if (cacheable) {
    const cached = takeCached(key);
    if (cached !== undefined) {
      stats.hits += 1;
      return cached;
    }
  }

  const pending = inFlight.get(key);
  if (pending) {
    stats.dedup += 1;
    return pending;
  }

  stats.misses += 1;
  const promise = request()
    .then((body) => {
      if (cacheable) retain(key, body);
      return body;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
};

/**
 * Drops every retained body. Called when the selected data entries change, and
 * by the tests so one spec cannot warm the cache for the next.
 */
export const clearRequestCache = (): void => {
  bodies.clear();
  totalBytes = 0;
};

/** Counters for the reactivity benchmark. */
export const getRequestCacheStats = () => ({
  ...stats,
  entries: bodies.size,
  bytes: totalBytes,
});
