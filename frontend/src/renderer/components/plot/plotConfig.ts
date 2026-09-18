import { Config } from 'plotly.js';

/**
 * Plotly `config` objects, shared and frozen.
 *
 * `react-plotly.js` decides whether to redraw by comparing `data`, `layout` and
 * `config` by *reference* (see its `factory.js`: `prevProps.config ===
 * this.props.config`). Passing an object literal inline therefore forces a full
 * `Plotly.react` on every single render, however little changed. There is no
 * way around that comparison — `revision` can only force an extra update, never
 * suppress one — so the objects must be stable module constants.
 *
 * The only thing that varies is `staticPlot`, which has two values, so two
 * constants cover every case.
 */
const BASE_CONFIG = {
  autosizable: false,
  scrollZoom: true,
  displayModeBar: true,
  showTips: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
} as const;

const INTERACTIVE_CONFIG: Partial<Config> = {
  ...BASE_CONFIG,
  modeBarButtonsToRemove: [...BASE_CONFIG.modeBarButtonsToRemove],
  staticPlot: false,
};

const STATIC_CONFIG: Partial<Config> = {
  ...BASE_CONFIG,
  modeBarButtonsToRemove: [...BASE_CONFIG.modeBarButtonsToRemove],
  staticPlot: true,
};

/**
 * @param isGridStatic `itemDataGrid.static` — note the plots invert it, a
 *   "static" grid is the interactive one.
 */
export const getPlotConfig = (isGridStatic: boolean): Partial<Config> =>
  isGridStatic ? INTERACTIVE_CONFIG : STATIC_CONFIG;
