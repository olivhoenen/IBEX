import { Paper, ScrollArea, Stack, Text } from '@mantine/core';
import { useIbexStore } from '../../stores';
import { useCallback, useState, useRef, useEffect } from 'react';
import { Configuration, DataGridPlot } from 'src/renderer/types';
import GridLayout, { Layout } from 'react-grid-layout';
import { GridLayoutPlot } from '../../components';

interface VisualizationPlotProps {
  extended?: boolean;
  height?: string;
}

/** Minimum grid size, kept identical to what the `data-grid` prop below asks for. */
const minHeightOf = (plotData: DataGridPlot) =>
  plotData.coordinates.length > 0 ? 12 : 8;
const minWidthOf = (plotData: DataGridPlot) =>
  plotData.coordinates.length > 0 ? 6 : 4;

export const VisualizationPlot = ({
  extended,
  height,
}: VisualizationPlotProps) => {
  // Subscribe to the configuration, not to `active.dataPlot`: `handleNewPlot`
  // (utils/plot.ts) pushes a new grid into that array in place, so its identity
  // does not change when a panel is added and a narrower selector would never
  // fire. Every writer does replace `active` itself.
  const active = useIbexStore((state) => state.active);
  const dataPlot = active?.dataPlot ?? [];
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const [dragEnabled, setDragEnabled] = useState(true);
  const [dragTimeout, setDragTimeout] = useState<NodeJS.Timeout | null>(null);
  const gridWith = extended ? 1800 : 1500;
  const colsNumber = 12;
  const colWidth = gridWith / colsNumber;
  const rowHeight = 30;

  /**
   * Handle the mouse down event
   */
  const handleMouseDown = () => {
    if (dragTimeout) clearTimeout(dragTimeout);
    setDragEnabled(false);

    const timeoutId = setTimeout(() => {
      setDragEnabled(true);
    }, 3000);

    setDragTimeout(timeoutId);
  };

  /**
   * Handle the mouse up event
   */
  const handleMouseUp = () => {
    if (dragTimeout) clearTimeout(dragTimeout);
    setDragEnabled(true);
  };

  /**
   * Handle update grid layout
   *
   * react-grid-layout reports the whole layout whenever any of it changes -
   * including when a panel only toggles `static` on entering edit mode. Grids
   * that did not move keep their identity so the memoized panels are not
   * re-rendered, and a report that changes nothing writes nothing at all
   * (which also stops it flagging the configuration as unsaved).
   */
  const handleUpdateLayout = useCallback((updatedLayouts: Layout[]) => {
    const { active, updatedConfiguration } = useIbexStore.getState();
    let changed = false;

    const updatedDataPlot: DataGridPlot[] = active.dataPlot.map(
      (item: DataGridPlot) => {
        const findUpdatedLayout = updatedLayouts.find(
          (layout) => layout.i === item.i,
        );
        if (!findUpdatedLayout) return item;

        const minH = minHeightOf(item);
        const minW = minWidthOf(item);
        if (
          item.x === findUpdatedLayout.x &&
          item.y === findUpdatedLayout.y &&
          item.w === findUpdatedLayout.w &&
          item.h === findUpdatedLayout.h &&
          item.static === findUpdatedLayout.static &&
          item.minH === minH &&
          item.minW === minW
        ) {
          return item;
        }

        changed = true;
        return {
          ...item,
          ...findUpdatedLayout,
          minH,
          minW,
        };
      },
    );

    if (!changed) return;

    const newActive: Configuration = {
      ...active,
      saved: false,
      dataPlot: updatedDataPlot,
    };

    updatedConfiguration(newActive);
  }, []);

  /*
   * Scroll to the bottom of the scroll area when new data is added or removed
   */
  useEffect(() => {
    // Scroll to new plot
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTo({
        top: scrollAreaRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [dataPlot.length]);

  return dataPlot.length > 0 ? (
    <>
      <ScrollArea h={height} viewportRef={scrollAreaRef}>
        <GridLayout
          cols={colsNumber}
          rowHeight={rowHeight}
          width={gridWith}
          autoSize={true}
          onDragStart={handleMouseDown}
          onDragStop={handleMouseUp}
          isDraggable={dragEnabled}
          onLayoutChange={(layout) => handleUpdateLayout(layout)}
        >
          {dataPlot.map((plotData: DataGridPlot) => (
            <Paper
              shadow="sm"
              radius="xs"
              withBorder
              key={plotData.i}
              data-grid={{
                x: plotData.x,
                y: plotData.y,
                w: plotData.w,
                h: plotData.h,
                static: plotData.static,
                minH: minHeightOf(plotData),
                minW: minWidthOf(plotData),
              }}
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
              }}
            >
              <GridLayoutPlot
                data={plotData}
                colWidth={colWidth}
                rowHeight={rowHeight}
              />
            </Paper>
          ))}
        </GridLayout>
      </ScrollArea>
    </>
  ) : (
    <Stack h="100%" align="center" w="100%" justify="center">
      <Text>No chart generates</Text>
    </Stack>
  );
};
