# Reactivity baseline

Measured with `npm run test:perf` on the benchmark canvas (a 2-D
`equilibrium/time_slice/profiles_2d/psi` heatmap plus a 1-D grid with two
traces, both from `iter_disruption_113112_1.nc`).

`requests` counts calls to `/data/*` and `/ids_info/*`; `redraws` counts Plotly
redraws across all panels; `renders` counts renders of the instrumented
components. Timings are informational only — they are not asserted.

## Before any reactivity work (commit 697db19)

| Scenario                   | requests | redraws | renders | ms   |
| -------------------------- | -------- | ------- | ------- | ---- |
| toggle edit mode (UI flag) | 0        | 11      | 42      | 1209 |
| coordinate slider, 2 steps | 0        | 12      | 40      | 1618 |
| metadata panel, first open | 4        | 3       | 6       | 989  |
| metadata panel, revisit    | 6        | 19      | 72      | 1881 |
| idle (no interaction)      | 0        | 0       | 0       | 2125 |

Three guards fail at this baseline, which is the point of committing them:

1. **Toggling one panel's edit flag redraws the other panel 6 times.** The flag
   is a boolean; no data changes. Cause: `updatedConfiguration` replaces the
   whole configuration and every component subscribes without a selector.
2. **Two slider steps cost 12 redraws, 3 of them on the unrelated 1-D panel.**
   Sliders correctly issue no backend request, but every tick writes the whole
   configuration.
3. **Reopening the same metadata tab re-downloads 2 `plot_data` payloads.**
   `VisualizationMetaData` refetches the entire payload to read
   `response.data.coordinates`.

The idle scenario passes and must keep passing: it guards against runaway
effect loops.

## After the session request cache (stage 1)

| Scenario | requests | redraws | renders | ms |
|---|---|---|---|---|
| toggle edit mode (UI flag) | 0 | 11 | 42 | 1251 |
| coordinate slider, 2 steps | 0 | 12 | 40 | 1637 |
| metadata panel, first open | 4 → **2** | 3 | 6 | 1031 |
| metadata panel, revisit | 6 → **1** | 19 → 14 | 72 → 58 | 1802 |
| idle (no interaction) | 0 | 0 | 0 | 2127 |

Guard 3 now passes: reopening a metadata tab issues **no** `plot_data` request.
The single remaining request on revisit is `/ids_info/array_summary`, which is
a different endpoint and a genuine first-time call for that tab.

The two cross-panel redraw guards still fail, as expected: they are caused by
the store replacing the whole configuration on every write, which stages 3 and
4 address. Nothing in the fetch layer can fix them.
