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

| Scenario                   | requests  | redraws | renders | ms   |
| -------------------------- | --------- | ------- | ------- | ---- |
| toggle edit mode (UI flag) | 0         | 11      | 42      | 1251 |
| coordinate slider, 2 steps | 0         | 12      | 40      | 1637 |
| metadata panel, first open | 4 → **2** | 3       | 6       | 1031 |
| metadata panel, revisit    | 6 → **1** | 19 → 14 | 72 → 58 | 1802 |
| idle (no interaction)      | 0         | 0       | 0       | 2127 |

Guard 3 now passes: reopening a metadata tab issues **no** `plot_data` request.
The single remaining request on revisit is `/ids_info/array_summary`, which is
a different endpoint and a genuine first-time call for that tab.

The two cross-panel redraw guards still fail, as expected: they are caused by
the store replacing the whole configuration on every write, which stages 3 and
4 address. Nothing in the fetch layer can fix them.

## After the render-path fixes (stage 2)

| Scenario                   | requests | redraws | renders | ms   |
| -------------------------- | -------- | ------- | ------- | ---- |
| toggle edit mode (UI flag) | 0        | **2**   | 42      | 1145 |
| coordinate slider, 2 steps | 0        | **6**   | 40      | 1546 |
| metadata panel, first open | 2        | 3       | 6       | 1106 |
| metadata panel, revisit    | **0**    | **9**   | 52      | 1679 |
| idle (no interaction)      | 0        | 0       | 0       | 2130 |

Three of the four guards now pass. Redraws against the original baseline:
toggling a UI flag 11 → 2, two slider steps 12 → 6, reopening the metadata
panel 19 → 9, and its backend requests 6 → 0.

The slider guard passes: stepping the heatmap's time slider no longer redraws
the 1-D panel at all.

One guard still fails, and it is the honest remainder: toggling one panel's
edit flag still causes **1** redraw of the untouched heatmap panel (it was 6).
That last one cannot be fixed from the render path — the store replaces the
whole configuration on every write, so the sibling panel genuinely receives new
props. Stages 3 and 4 (the data/config split and selector subscriptions) are
what close it.

## After narrowing subscriptions and memoizing the panel (stage 3, partial)

| Scenario                   | requests | redraws | renders | ms   |
| -------------------------- | -------- | ------- | ------- | ---- |
| toggle edit mode (UI flag) | 0        | 2       | **14**  | 1105 |
| coordinate slider, 2 steps | 0        | 6       | **28**  | 1547 |
| metadata panel, first open | 2        | 3       | 6       | 993  |
| metadata panel, revisit    | 0        | 9       | 52      | 1650 |
| idle (no interaction)      | 0        | 0       | 0       | 2126 |

Component renders against the original baseline: toggling a UI flag 42 → 14,
two slider steps 40 → 28.

## Where the last guard stands

`toggle edit mode` still redraws the untouched heatmap panel **once** (it was 6
at the baseline). Closing it needs the full data/config store split: the plot
components no longer subscribe to the store and the panel is memoized, but the
configuration object is still replaced wholesale on every write, so
`VisualizationPlot` — which does subscribe — re-renders and rebuilds the grid,
and react-grid-layout clones its children on the way through.

## After fixing the layout write cycle (stage 4)

| Scenario                   | requests | redraws | renders | ms   |
| -------------------------- | -------- | ------- | ------- | ---- |
| toggle edit mode (UI flag) | 0        | **1**   | **4**   | 1015 |
| coordinate slider, 2 steps | 0        | 6       | 28      | 1583 |
| metadata panel, first open | 2        | 3       | 6       | 1024 |
| metadata panel, revisit    | 0        | 9       | 44      | 1687 |
| idle (no interaction)      | 0        | 0       | 0       | 2126 |

**All four guards pass.** Toggling one panel's edit flag now redraws only the
panel that was toggled; the untouched heatmap redraws 0 times, down from 6 at
the original baseline. Component renders for that scenario: 42 → 4.

The cause was not the store after all. Entering edit mode sets `static` on the
grid, which changes the layout react-grid-layout derives from its children, so
RGL reports `onLayoutChange` — and `VisualizationPlot.handleUpdateLayout`
rebuilt _every_ grid object from that report, which defeated the `memo` added in
the previous stage. It now keeps the identity of grids that did not move and
writes nothing at all when the report changes nothing (which also stops the
configuration being flagged unsaved by a no-op).

Note for the store split: `VisualizationPlot` subscribes to `active`, not to
`active.dataPlot`, because `handleNewPlot` (`utils/plot.ts:235`) pushes a new
grid into that array **in place**. A narrower selector never fires when a panel
is added, and memoizing the RGL children on it renders an empty canvas.

## After deriving the Plotly layout (stage 5)

| Scenario                   | requests | redraws | renders | ms   |
| -------------------------- | -------- | ------- | ------- | ---- |
| toggle edit mode (UI flag) | 0        | 1       | 4       | 1023 |
| coordinate slider, 2 steps | 0        | 6       | 28      | 1570 |
| metadata panel, first open | 2        | **2**   | **4**   | 1012 |
| metadata panel, revisit    | 0        | **6**   | 40      | 1548 |
| idle (no interaction)      | 0        | 0       | 0       | 2126 |

The layout used to be assembled by fifteen effects (seven in `SimplePlotly`,
five in `usePlotLayout`, six in `Heatmap2D`), each calling `setLayoutPlot` and
so handing `react-plotly.js` a new `layout` identity — one redraw apiece as a
panel appeared. It is now a single `useMemo` per component, with the user's mode
bar changes kept in state and merged last so a rebuild never discards a zoom.

Redraws when a panel appears: 9 → 6 on revisit, 3 → 2 on first open. Against the
original baseline, reopening the metadata panel costs 19 → 6 redraws and 72 → 40
renders.

The remaining 6 on the slider scenario are data-driven, not layout-driven: each
tick rebuilds the plot arrays.

## Against real ITER data

The fixtures are small, so the same scenarios were also run by hand against a
production entry — `imas:hdf5?path=/work/imas/shared/imasdb/ITER/3/134173/106`,
an equilibrium with 720 time slices, plotting
`equilibrium/time_slice/profiles_2d/psi` as a heatmap. This is the case
issue #121 reports. Measured with the same counters, on one panel, comparing
commit 5614230 (the benchmark, before any fix) with the end of this work.

| Scenario                     | before                                | after                                 |
| ---------------------------- | ------------------------------------- | ------------------------------------- |
| open the tree to profiles_2d | 3 req, 0 redraws, 2559 ms             | 3 req, 0 redraws, 1652 ms             |
| plot the 2D psi heatmap      | 3 req, 8 redraws, 36 renders, 6357 ms | 3 req, 4 redraws, 26 renders, 4663 ms |
| toggle edit mode (UI flag)   | 0 req, 3 redraws, 10 renders, 1655 ms | 0 req, 1 redraw, 8 renders, 1561 ms   |
| coordinate slider, 1 step    | 0 req, 6 redraws, 20 renders, 1698 ms | 0 req, 4 redraws, 20 renders, 1459 ms |
| coordinate slider, 2 steps   | 0 req, 6 redraws, 20 renders, 2004 ms | 0 req, 4 redraws, 20 renders, 1496 ms |
| idle                         | 0 req, 0 redraws                      | 0 req, 0 redraws                      |

Timings include the ~1.4 s the harness spends waiting for the UI to go quiet,
so the interaction itself improved by more than the totals suggest.

Two notes for whoever runs this again:

- Drive it from the DOM. `getTestState` serializes the whole store over IPC, and
  on this entry that means serializing the psi matrix on every poll — it times
  the WebDriver script out rather than the app.
- The remaining cost of plotting is the payload itself: the backend never
  downsamples a 2-D node (`imas_python_source.py:488` and `:1369` gate on
  `ndim == 1`), so the whole matrix crosses the wire at full resolution. That is
  a separate, API-shaped change.
