import { getDriver } from '../setup';
import type { PerfSnapshot } from '../../renderer/utils/perf';

/**
 * Helpers for the reactivity spec. They drive `window.__ibexPerf`, which the
 * renderer installs only when E2E_TEST is set (see renderer/utils/perf.ts).
 */

/** Clears all counters. Call immediately before the interaction under test. */
export async function resetPerf(): Promise<void> {
  await getDriver().executeScript(() => {
    window.__ibexPerf?.reset();
  });
}

/** Reads the counters accumulated since the last {@link resetPerf}. */
export async function readPerf(): Promise<PerfSnapshot> {
  const snapshot = await getDriver().executeScript(() =>
    window.__ibexPerf?.snapshot(),
  );
  if (!snapshot) {
    throw new Error('window.__ibexPerf is not installed');
  }
  return snapshot as PerfSnapshot;
}

/**
 * Fails loudly if the instrumentation is missing, rather than letting every
 * scenario silently report zero.
 */
export async function assertPerfInstalled(): Promise<void> {
  const installed = await getDriver().executeScript(
    () => typeof window.__ibexPerf !== 'undefined',
  );
  if (!installed) {
    throw new Error(
      'window.__ibexPerf is not installed. The app must be started with ' +
        'E2E_TEST=true (npm run start:e2e) for the reactivity spec to run.',
    );
  }
}

/**
 * Waits until no new render, redraw or request has been recorded for
 * `quietMs`, so a measurement is not taken while React is still settling.
 */
export async function waitForQuiescence(
  quietMs = 600,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const snapshot = await readPerf();
    const fingerprint = JSON.stringify([
      snapshot.fetchCount,
      snapshot.renders,
      snapshot.redraws,
    ]);
    if (fingerprint !== previous) {
      previous = fingerprint;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Total renders across every instrumented component instance. */
export function totalRenders(snapshot: PerfSnapshot): number {
  return Object.values(snapshot.renders).reduce((sum, n) => sum + n, 0);
}

/** Total Plotly redraws across every panel. */
export function totalRedraws(snapshot: PerfSnapshot): number {
  return Object.values(snapshot.redraws).reduce((sum, n) => sum + n, 0);
}

/** Requests that actually hit the data endpoints (ignores /info polling). */
export function dataRequests(snapshot: PerfSnapshot): string[] {
  return snapshot.fetchUrls.filter(
    (url) => url.includes('/data/') || url.includes('/ids_info/'),
  );
}

const measurements: {
  scenario: string;
  dataRequests: number;
  redraws: number;
  renders: number;
  ms: number;
}[] = [];

/**
 * Runs `interaction` with the counters zeroed, waits for the UI to settle and
 * records the result for the end-of-run report.
 */
export async function measure(
  scenario: string,
  interaction: () => Promise<void>,
): Promise<PerfSnapshot> {
  await waitForQuiescence();
  await resetPerf();

  const startedAt = Date.now();
  await interaction();
  await waitForQuiescence();
  const ms = Date.now() - startedAt;

  const snapshot = await readPerf();
  measurements.push({
    scenario,
    dataRequests: dataRequests(snapshot).length,
    redraws: totalRedraws(snapshot),
    renders: totalRenders(snapshot),
    ms,
  });
  return snapshot;
}

/**
 * Prints the collected numbers. Timings are reported but never asserted: on a
 * shared CI runner they are noise, whereas the counts are deterministic.
 */
export function reportMeasurements(): void {
  if (measurements.length === 0) return;
  console.info('\nReactivity measurements');
  for (const row of measurements) {
    console.info(
      `  ${row.scenario.padEnd(36)} ` +
        `requests=${String(row.dataRequests).padStart(3)} ` +
        `redraws=${String(row.redraws).padStart(3)} ` +
        `renders=${String(row.renders).padStart(4)} ` +
        `${row.ms} ms`,
    );
  }
}
