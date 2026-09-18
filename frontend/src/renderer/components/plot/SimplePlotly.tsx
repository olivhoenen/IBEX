import { Center, Grid, Group, Select, Text } from '@mantine/core';
import { Layout } from 'plotly.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Plot from 'react-plotly.js';
import {
  Configuration,
  Coordinates,
  DataGridPlot,
  DataPlotly,
} from 'src/renderer/types';
import { VerticalSlider } from '../verticalSlider';
import { useIbexStore } from '../../stores';
import {
  compareByAxeIndex,
  getArrayValueFromDependance,
  getErrorsAreaToPlot,
  initPlotColors,
  isMatrixPlottable,
  removeSuffix,
  swapAxis,
} from '../../utils';
import classes from './SimplePlotly.module.css';
import { countRedraw, countRender } from '../../utils/perf';
import { getPlotConfig } from './plotConfig';
import { NoDataForURI } from '../plot';
import { usePlotLayout } from './hooks/usePlotLayout';
import { IconLink } from '@tabler/icons-react';
interface SimplePlotlyProps {
  itemDataGrid: DataGridPlot;
  width: number;
  height: number;
  showSliders: boolean;
  is3DView?: boolean;
  handleUpdateCoordinate?: (
    coordinate: Coordinates,
    valueIndex: number,
  ) => Promise<void>;
}

export const SimplePlotly = ({
  itemDataGrid,
  height,
  width,
  showSliders,
  is3DView,
  handleUpdateCoordinate,
}: SimplePlotlyProps) => {
  countRender(`SimplePlotly:${itemDataGrid.i}`);
  const handleAfterPlot = useCallback(
    () => countRedraw(itemDataGrid.i),
    [itemDataGrid.i],
  );

  const dataToPlotWithErrorBands = useMemo(() => {
    // getErrorsAreaToPlot writes connectgaps, customdata and hovertemplate onto
    // each plot, and Plotly is handed the same objects, so they must not be the
    // store's. Only the objects need copying though, plus the two vectors that
    // are actually plotted: structuredClone used to deep-copy `yData` and every
    // coordinate as well - megabytes, on every slider tick - when both are only
    // read from here.
    return getErrorsAreaToPlot(
      itemDataGrid.plot.map((plot) => {
        const plotCopy = { ...plot };
        if (Array.isArray(plot.x)) plotCopy.x = [...plot.x] as DataPlotly['x'];
        if (Array.isArray(plot.y)) plotCopy.y = [...plot.y] as DataPlotly['y'];
        return plotCopy;
      }),
      itemDataGrid.coordinates,
    );
  }, [itemDataGrid.plot, itemDataGrid.coordinates]);
  const coordsUsedInAxes: 1 | 2 = 1;
  const SELECT_AXIS_HEIGHT = 40; // Height of the select axis component
  // Plotly compares `layout` by reference, so the layout is derived in one
  // memo instead of being assembled by a dozen effects that each produced a new
  // identity - and so a new redraw - on mount and on every change.
  const axisLayout = usePlotLayout({ itemDataGrid });
  const [title, setTitle] = useState(itemDataGrid.title);
  // What the user did with the mode bar (zoom, pan, autorange). It cannot be
  // derived, and it is merged last so rebuilding the layout never undoes it.
  const [userRelayout, setUserRelayout] = useState<Partial<Layout>>({});
  const plotDivRef = useRef<HTMLDivElement>(null);
  const layoutPlotWidth = showSliders
    ? width * (itemDataGrid.coordinates?.length > 1 ? 0.8 : 1)
    : width;
  const customContainerRef = useRef<HTMLDivElement>(null);

  const handleRelayout = useCallback((relayout: Partial<Layout>) => {
    setUserRelayout((previous) => ({
      ...previous,
      ...relayout, // update the layout with new values
    }));
  }, []);

  const isPlotInY2 = useCallback(
    (plotName: string) => {
      const y2Unit = itemDataGrid?.y2AxisData?.unit;
      if (!y2Unit) return false;

      const selectedPlot = itemDataGrid.plot.find(
        (plot) => plot.name === plotName,
      );
      return selectedPlot?.unit === y2Unit;
    },
    [itemDataGrid?.y2AxisData?.unit, itemDataGrid?.plot],
  );

  useEffect(() => {
    const plotDiv = plotDivRef.current;
    if (!plotDiv) return;

    const applyLegendStyles = () => {
      const legendTexts =
        plotDiv.querySelectorAll<SVGTextElement>('.legendtext');

      legendTexts.forEach((el) => {
        const name = el.textContent || '';

        const isInY2 = isPlotInY2(name);
        const newColor = isInY2 ? 'rgb(148, 103, 189)' : 'rgb(68, 68, 68)';

        if (el.style.fill !== newColor) {
          el.style.fill = newColor;
        }
      });
    };

    // Apply styles to the first render
    applyLegendStyles();

    // Observe changes in the DOM to keep style (Plotly rewrites everything)
    const observer = new MutationObserver(() => {
      applyLegendStyles();
    });

    observer.observe(plotDiv, {
      childList: true,
      subtree: true,
    });

    // cleanup
    return () => observer.disconnect();
  }, [isPlotInY2]);

  /**
   * Persist an edited title on the grid. The layout picks the title up from the
   * `title` state below, so nothing here touches the layout.
   */
  useEffect(() => {
    if (!itemDataGrid.isEditing || title === itemDataGrid.title) {
      return;
    }

    // Update title only if is editing. The store is read here rather than
    // subscribed to: this component only ever writes to it, and subscribing
    // would re-render - and so redraw Plotly - on every unrelated change.
    const { active, updatedConfiguration } = useIbexStore.getState();

    const updatedDataPlot: DataGridPlot[] = active.dataPlot.map((dataPlot) =>
      dataPlot.i === itemDataGrid.i ? { ...dataPlot, title } : dataPlot,
    );

    const newActive: Configuration = {
      ...active,
      saved: false,
      dataPlot: updatedDataPlot,
    };

    updatedConfiguration(newActive);
  }, [title]);

  /**
   * The whole Plotly layout, derived in one go.
   *
   * Axis titles are built from the plot names and the axis descriptors; the
   * axis types and the grid come from `usePlotLayout`; what the user changed
   * with the mode bar is merged last so a rebuild never discards their zoom.
   */
  const layoutPlot = useMemo<Partial<Layout>>(() => {
    const coordsYNames = [
      ...new Set(
        itemDataGrid.plot
          .filter((plot) => plot.yaxis !== 'y2')
          ?.map((coord) => removeSuffix(coord.name, '_' + coord.labelUri)),
      ),
    ];
    const YTitle = itemDataGrid.yAxisData?.name
      ? `${coordsYNames.length > 1 ? coordsYNames[0] + ', ...' : coordsYNames[0]} ${(itemDataGrid.yAxisData?.unit && '[' + itemDataGrid.yAxisData.unit + ']') || ''}`
      : '';

    const XTitle = itemDataGrid.xAxisData?.name
      ? `${itemDataGrid.xAxisData?.name} ${(itemDataGrid.xAxisData?.unit && '[' + itemDataGrid.xAxisData.unit + ']') || ''}`
      : '';

    const coordsY2Names = [
      ...new Set(
        itemDataGrid.plot
          .filter((plot) => plot.yaxis === 'y2')
          ?.map((coord) => removeSuffix(coord.name, '_' + coord.labelUri)),
      ),
    ];
    const Y2Title = itemDataGrid.y2AxisData?.name
      ? `${coordsY2Names.length > 1 ? coordsY2Names[0] + ', ...' : coordsY2Names[0]} ${(itemDataGrid.y2AxisData?.unit && '[' + itemDataGrid.y2AxisData.unit + ']') || ''}`
      : '';

    return {
      title: { text: title },
      height: height,
      width: layoutPlotWidth - 75,
      xaxis: {
        scaleanchor: null,
        scaleratio: null,
        title: {
          font: {
            family: 'Courier New, monospace',
            size: 16,
            color: '#7f7f7f',
          },
          text: XTitle,
        },
        rangemode: 'normal',
        showline: true,
        zeroline: false,
        exponentformat: 'power',
        showexponent: 'all',
        separatethousands: true,
        ...axisLayout.xaxis,
      },
      yaxis: {
        title: {
          font: {
            family: 'Courier New, monospace',
            size: 16,
            color: '#7f7f7f',
          },
          text: YTitle,
        },
        rangemode: 'normal',
        showline: true,
        zeroline: false,
        exponentformat: 'power',
        showexponent: 'all',
        separatethousands: true,
        ...axisLayout.yaxis,
      },
      yaxis2: itemDataGrid.y2AxisData
        ? {
            exponentformat: 'power',
            showexponent: 'all',
            separatethousands: true,
            ...axisLayout.yaxis2,
            title: {
              text: Y2Title,
              font: {
                family: 'Courier New, monospace',
                size: 16,
                color: 'rgb(148, 103, 189)',
              },
            },
            tickfont: { color: 'rgb(148, 103, 189)' },
            overlaying: 'y',
            side: 'right',
            rangemode: 'normal',
            showline: false,
            zeroline: false,
            showgrid: false,
          }
        : {},
      modebar: {
        orientation: 'v',
      },
      legend: {
        x: 1.1,
        y: 1,
        orientation: 'v',
        traceorder: 'normal',
      },
      plot_bgcolor: '#c7c7c7',
      dragmode: 'zoom',
      ...userRelayout,
    };
  }, [
    title,
    height,
    layoutPlotWidth,
    axisLayout,
    itemDataGrid.plot,
    itemDataGrid.xAxisData,
    itemDataGrid.yAxisData,
    itemDataGrid.y2AxisData,
    userRelayout,
  ]);

  useEffect(() => {
    // Update title when itemDataGrid.title change (when selecting a plot with original plot title)
    setTitle(itemDataGrid.title);
  }, [itemDataGrid.title]);

  const handleInitPlotColor = async (
    customContainerRef: React.MutableRefObject<HTMLDivElement>,
    itemDataGrid: DataGridPlot,
  ) => {
    await initPlotColors(itemDataGrid, customContainerRef);
  };

  useEffect(() => {
    handleInitPlotColor(customContainerRef, itemDataGrid);
  }, [customContainerRef.current, itemDataGrid.plot.length]);

  return (
    <Grid
      ref={customContainerRef}
      styles={{
        inner: {
          margin: 0,
          width: 'inherit',
          flexWrap: 'nowrap',
          whiteSpace: 'nowrap',
        },
      }}
    >
      {/* Coordinates sliders */}
      {itemDataGrid.coordinates.filter((coord) => coord.name !== '')?.length >
        1 &&
        showSliders && (
          <Grid.Col
            className={classes.handlePlotExplorationContainer}
            span="content"
            mt={10}
          >
            <Group gap={5}>
              <Text>x</Text>
              <Select
                label=""
                value={
                  itemDataGrid.coordinates.find(
                    (coord: Coordinates) => coord.axeIndex === 0,
                  ).name
                }
                data={itemDataGrid.coordinates.map(
                  (coord: Coordinates) => coord.name,
                )}
                w={`${width * 0.2}px`}
                onChange={(value) =>
                  value &&
                  swapAxis(
                    itemDataGrid,
                    itemDataGrid.coordinates.find(
                      (coord: Coordinates) => coord.name === value,
                    ).axeIndex,
                    0, // axeIndex of x is always 0
                    false,
                    useIbexStore.getState().active,
                    useIbexStore.getState().updatedConfiguration,
                  )
                }
                size="xs"
                disabled={!itemDataGrid.isEditing}
              />
            </Group>

            <Group
              justify="space-between"
              gap="0"
              w={`${width * 0.2}px`}
              miw={`${(itemDataGrid.coordinates.length - coordsUsedInAxes) * 50}px`}
              align="flex-end"
              pos="relative"
            >
              {structuredClone(itemDataGrid.coordinates)
                .sort(compareByAxeIndex)
                .map(
                  (item: Coordinates, valueIndex: number) =>
                    item.axeIndex !== 0 && ( // Don't send coordinate having axeIndex 0 in verticalSlider because it's the x axis
                      <VerticalSlider
                        key={`line_slider_${valueIndex}`}
                        name={item.name}
                        valueIndex={item.valueIndex || 0}
                        data={getArrayValueFromDependance(
                          itemDataGrid.coordinates,
                          item.axeIndex,
                        )}
                        getValue={(valueIndex) =>
                          handleUpdateCoordinate(item, valueIndex)
                        }
                        maxWidth={
                          itemDataGrid.coordinates.length &&
                          itemDataGrid.coordinates.length > coordsUsedInAxes
                            ? 100 /
                              (itemDataGrid.coordinates.length -
                                coordsUsedInAxes)
                            : 100
                        }
                        height={
                          is3DView
                            ? height - 80
                            : height - 80 - SELECT_AXIS_HEIGHT
                        }
                        disabled={!itemDataGrid.isEditing}
                      />
                    ),
                )}
              {itemDataGrid.synchronizedGrids?.list.length && (
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    right: -20,
                  }}
                >
                  <IconLink
                    size={20}
                    color={itemDataGrid.synchronizedGrids.color}
                  />
                </div>
              )}
            </Group>
          </Grid.Col>
        )}

      {itemDataGrid.plot.some((plot) =>
        [plot.x, plot.y].every(isMatrixPlottable),
      ) ? (
        <Grid.Col
          span="auto"
          pos="relative"
          w={`${layoutPlotWidth - 32}px`}
          maw={`${layoutPlotWidth - 32}px`}
          h={`${height}px`}
          style={{
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div ref={plotDivRef}>
            <Plot
              className={classes.simplePlot}
              data={dataToPlotWithErrorBands}
              config={getPlotConfig(itemDataGrid.static)}
              layout={layoutPlot}
              onRelayout={handleRelayout}
              onAfterPlot={handleAfterPlot}
              useResizeHandler={false}
            />
          </div>
        </Grid.Col>
      ) : itemDataGrid.plot.some(
          (plot) => ![plot.x, plot.y, plot.yData].some(isMatrixPlottable),
        ) ? (
        <Grid.Col
          span="auto"
          pos="relative"
          w={'100%'}
          h={`${height}px`}
          style={{
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Center h={height} w={`100%`}>
            <NoDataForURI itemDataGrid={itemDataGrid} />
          </Center>
        </Grid.Col>
      ) : (
        <Grid.Col
          span="auto"
          pos="relative"
          w={`${width}px`}
          maw={`${width}px`}
          h={`${height}px`}
          style={{
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Center h={height} w={`100%`}>
            <Text>Current index has no data</Text>
          </Center>
        </Grid.Col>
      )}
    </Grid>
  );
};
