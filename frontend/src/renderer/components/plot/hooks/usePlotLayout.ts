import { useEffect, useMemo } from 'react';
import { AxisType, Layout } from 'plotly.js';
import { Configuration, DataGridPlot } from 'src/renderer/types';
import { useIbexStore } from '../../../stores';

interface UsePlotLayoutParams {
  itemDataGrid: DataGridPlot;
}

/** Type of the values actually plotted on x, which decides a category axis. */
const typeOfXData = (itemDataGrid: DataGridPlot): string | undefined =>
  itemDataGrid.plot[0]?.x ? typeof itemDataGrid.plot[0].x[0] : undefined;

/**
 * Axis type for x: string data forces a category axis, and an axis left on
 * `category` goes back to `linear` as soon as the data is numeric again.
 * Otherwise the configured type wins.
 */
const xAxisTypeOf = (itemDataGrid: DataGridPlot): AxisType => {
  const configured = itemDataGrid.xAxisData?.type as AxisType | undefined;
  const fromData = typeOfXData(itemDataGrid);

  if (fromData === 'string') return 'category';
  if (configured === 'category' && fromData === 'number') return 'linear';
  return configured || 'linear';
};

/**
 * The parts of a Plotly layout both plot components derive the same way.
 *
 * This used to be five `useEffect`s calling `setLayoutPlot`. Since
 * react-plotly.js compares `layout` by reference, each of them was a separate
 * redraw of the panel; they are all pure functions of `itemDataGrid`, so they
 * are derived in one memo instead and the caller merges the result into its own
 * layout.
 */
export function usePlotLayout({
  itemDataGrid,
}: UsePlotLayoutParams): Partial<Layout> {
  const displayGrid = itemDataGrid.displayGrid;
  const xType = xAxisTypeOf(itemDataGrid);
  const yType = (itemDataGrid.yAxisData?.type as AxisType) || 'linear';
  const y2Type = (itemDataGrid.y2AxisData?.type as AxisType) || 'linear';

  // Keep the configured x axis type in step with the data. It is persisted with
  // the configuration and read back by the customization panel, so it cannot
  // just live in the layout. This used to assign to `itemDataGrid.xAxisData`
  // directly, i.e. mutate store state from an effect.
  useEffect(() => {
    // Only the two transitions the old effect handled: nothing is written when
    // the configured type is simply absent.
    const fromData = typeOfXData(itemDataGrid);
    const configured = itemDataGrid.xAxisData?.type;
    const forcedType =
      fromData === 'string'
        ? 'category'
        : configured === 'category' && fromData === 'number'
          ? 'linear'
          : null;
    if (!forcedType) return;

    const { active, updatedConfiguration } = useIbexStore.getState();
    const current = active?.dataPlot.find((item) => item.i === itemDataGrid.i);
    if (!current?.xAxisData || current.xAxisData.type === forcedType) return;

    const newActive: Configuration = {
      ...active,
      dataPlot: active.dataPlot.map((item) =>
        item.i === itemDataGrid.i
          ? { ...item, xAxisData: { ...item.xAxisData, type: forcedType } }
          : item,
      ),
    };
    updatedConfiguration(newActive);
  }, [itemDataGrid.i, xType]);

  return useMemo(
    () => ({
      xaxis: { showgrid: displayGrid, type: xType },
      yaxis: { showgrid: displayGrid, type: yType },
      yaxis2: { showgrid: displayGrid, type: y2Type },
    }),
    [displayGrid, xType, yType, y2Type],
  );
}
