import Plot from 'react-plotly.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Data, Layout } from 'plotly.js';
import {
  Axis,
  AxisData,
  Complex,
  Configuration,
  Coordinates,
  DataGridPlot,
} from '../../types';
import classe from './SimplePlotly.module.css';
import { Center, Grid, Group, Select, Stack, Text } from '@mantine/core';
import { VerticalSlider } from '../verticalSlider';
import {
  compareByAxeIndex,
  getArrayValueFromDependance,
  getFirstArrayValueFromShape,
  isMatrixPlottable,
  swapAxis,
} from '../../utils';
import classes from './Heatmap2D.module.css';
import { useIbexStore } from '../../stores';
import { countRedraw, countRender } from '../../utils/perf';
import { getPlotConfig } from './plotConfig';
import { NoDataForURI } from '.';
import { usePlotLayout } from './hooks/usePlotLayout';
import { IconLink } from '@tabler/icons-react';

interface Heatmap2DProps {
  itemDataGrid: DataGridPlot;
  width: number;
  height: number;
  plotIndex: string;
  showSliders: boolean;
  forcedPlotType?: 'heatmap' | 'contour';
  handleUpdateCoordinate?: (
    coordinate: Coordinates,
    valueIndex: number,
  ) => Promise<void>;
}

export const Heatmap2D = ({
  itemDataGrid,
  width,
  height,
  plotIndex,
  showSliders,
  forcedPlotType,
  handleUpdateCoordinate,
}: Heatmap2DProps) => {
  countRender(`Heatmap2D:${itemDataGrid.i}`);
  const handleAfterPlot = useCallback(
    () => countRedraw(itemDataGrid.i),
    [itemDataGrid.i],
  );
  const coordsUsedInAxes: 1 | 2 = 2;
  const SELECT_AXIS_HEIGHT = 90; // Height of the select axis container
  const [xAxis, setXAxis] = useState<Axis>(null);
  const [yAxis, setYAxis] = useState<Axis>(null);
  const [zAxis, setZAxis] = useState<Axis>(null);
  const [data3D, setData3D] = useState<AxisData | null>(null);
  const [are3DAxisInit, setAre3DAxisInit] = useState(false);
  const [x, setX] = useState<number[]>([]);
  const [y, setY] = useState<number[]>([]);
  const [z, setZ] = useState<(number | string)[][]>([]);
  const plotRef = useRef<Plot | null>(null);
  const [shouldForceRatio, setShouldForceRatio] = useState<boolean>(false);
  const [layoutPlot, setLayoutPlot] = useState<Partial<Layout>>({
    autosize: true,
    scene: {
      xaxis: { title: { text: xAxis?.name || '' } },
      yaxis: { title: { text: yAxis?.name || '' } },
      zaxis: { title: { text: zAxis?.name || '' } },
    },
    xaxis: {
      exponentformat: 'power',
      showexponent: 'all',
      separatethousands: true,
      scaleanchor: null,
      scaleratio: null,
      zeroline: false,
      showgrid: itemDataGrid.displayGrid,
    },
    yaxis: {
      exponentformat: 'power',
      showexponent: 'all',
      separatethousands: true,
      zeroline: false,
      showgrid: itemDataGrid.displayGrid,
    },
    modebar: {
      orientation: 'v',
    },
    legend: {
      x: 1.3,
      y: 1,
      groupclick: 'togglegroup',
      tracegroupgap: 0,
    },
  });
  const selectedPlot = itemDataGrid.plot[parseInt(plotIndex)];
  // Custom hook used for trigger some useEffects to update the layout
  usePlotLayout({
    itemDataGrid,
    setLayoutPlot,
  });
  const [title, setTitle] = useState(itemDataGrid.title);
  const layoutPlotWidth = showSliders ? width * 0.8 : width;

  /**
   * Rule to determine if we have to force ratio.
   * The value is initialized once at grid creation and only changed via the customization switch.
   */
  useEffect(() => {
    setShouldForceRatio(itemDataGrid.forceXyRatio);
  }, [itemDataGrid.forceXyRatio]);

  /**
   * Update layout to force ratio or not
   */
  useEffect(() => {
    const updatedLayoutPlot = structuredClone(layoutPlot);
    updatedLayoutPlot.xaxis.scaleanchor = shouldForceRatio ? 'y' : null;
    updatedLayoutPlot.xaxis.scaleratio = shouldForceRatio ? 1 : null;
    setLayoutPlot(updatedLayoutPlot);
  }, [shouldForceRatio]);

  /**
   * Update the editable title when layout title change
   */
  useEffect(() => {
    if (!itemDataGrid.isTitleOverwritten) {
      setTitle(itemDataGrid.title || '');
    }
  }, [itemDataGrid.title]);

  /**
   * Update the layout title & dataPlot configuration when editing title
   */
  useEffect(() => {
    // The store is read here rather than subscribed to: this component only
    // ever writes to it, and subscribing would re-render - and so redraw
    // Plotly - on every unrelated change elsewhere in the configuration.
    const { active, updatedConfiguration } = useIbexStore.getState();

    if (!active.dataPlot.find((element) => element.isEditing)) {
      // Update active dataplot title only when editing (to prevent from updating in customization)
      return;
    }

    setLayoutPlot((prevLayout) => ({
      ...prevLayout,
      title: { text: title },
    }));

    const updatedDataPlot: DataGridPlot[] = active.dataPlot.map(
      (item: DataGridPlot) => {
        if (item.i === itemDataGrid.i) {
          return {
            ...itemDataGrid,
            title: title,
          };
        }
        return item;
      },
    );

    const newActive: Configuration = {
      ...active,
      saved: false,
      dataPlot: updatedDataPlot,
    };

    updatedConfiguration(newActive);
  }, [title]);

  const handleRelayout = (newLayout: Partial<Layout>) => {
    setLayoutPlot((prevLayout) => ({
      ...prevLayout,
      ...newLayout, // update the layout with new values
    }));
  };

  const init3DAxis = useCallback(async () => {
    // Transpose data matrix to orign values
    const selectedDataMatrix = selectedPlot?.yData;
    if (!selectedDataMatrix) {
      return;
    }
    setData3D(selectedDataMatrix);

    // get colorscale name and unit linked to selected plot
    const colorscaleName =
      selectedPlot?.name.replace(`_${selectedPlot.labelUri}`, '') || 'Z Axis';
    const colorscaleUnit = selectedPlot?.unit || '';

    //Initialize xAxis, yAxis, zAxis
    setZAxis({
      name: colorscaleName,
      unit: colorscaleUnit,
    });

    const xAxisAtHeatmap = {
      name: itemDataGrid.coordinates.find((xCoord) => xCoord.axeIndex === 0)
        .name,
      unit: itemDataGrid.coordinates.find((xCoord) => xCoord.axeIndex === 0)
        .unit,
    };
    setXAxis(xAxisAtHeatmap);

    const yCoord = itemDataGrid.coordinates.find(
      (yCoord) => yCoord.axeIndex === 1,
    );
    const yAxisAtHeatmap = {
      name: yCoord.name,
      unit: yCoord.unit,
    };
    setLayoutPlot((prevLayout) => ({
      ...prevLayout,
      yaxis: {
        ...prevLayout.yaxis,
        type:
          typeof getFirstArrayValueFromShape(yCoord.data, yCoord.shape)[0] ===
          'string'
            ? 'category'
            : 'linear',
      },
    }));
    setYAxis(yAxisAtHeatmap);
  }, [itemDataGrid.plot, itemDataGrid.coordinates, plotIndex]);

  /* Initialize data3D with generated data */
  useEffect(() => {
    //Get first plot data
    init3DAxis();
  }, [itemDataGrid.plot, itemDataGrid.coordinates, plotIndex]);

  /* Update the layout of the plot */
  useEffect(() => {
    setLayoutPlot((prevLayout) => ({
      ...prevLayout,
      title: { text: itemDataGrid.title },
      height: height,
      width: layoutPlotWidth - 75,
    }));
  }, [itemDataGrid, width, height]);

  /**
   * Update the layout xAxis
   */
  useEffect(() => {
    const XTitle = xAxis?.name
      ? `${xAxis?.name} ${(xAxis?.unit && '[' + xAxis.unit + ']') || ''}`
      : '';
    setLayoutPlot((prevLayout) => ({
      ...prevLayout,
      xaxis: {
        ...prevLayout.xaxis,
        title: {
          ...prevLayout.xaxis?.title,
          text: XTitle,
        },
      },
    }));
  }, [xAxis]);

  /**
   * Update the layout yAxis
   */
  useEffect(() => {
    const YTitle = yAxis?.name
      ? `${yAxis?.name} ${(yAxis?.unit && '[' + yAxis.unit + ']') || ''}`
      : '';
    setLayoutPlot((prevLayout) => ({
      ...prevLayout,
      yaxis: {
        ...prevLayout.yaxis,
        title: {
          ...prevLayout.yaxis?.title,
          text: YTitle,
        },
      },
    }));
  }, [yAxis]);

  useEffect(() => {
    if (data3D && selectedPlot) {
      // Update x, y & z useStates to plot heatmap
      // These vectors index into the store's arrays, and Plotly keeps and
      // mutates whatever it is handed. Copy once here - this effect only runs
      // when the data or the coordinates change - rather than copying the whole
      // matrix again on every render.
      // `getArrayValueFromDependance` returns undefined for an invalid index,
      // so copy only when there is something to copy.
      const xValues = getArrayValueFromDependance(
        itemDataGrid.coordinates,
        0,
      ) as number[];
      const yValues = getArrayValueFromDependance(
        itemDataGrid.coordinates,
        1,
      ) as number[];
      setX(Array.isArray(xValues) ? [...xValues] : xValues);
      setY(Array.isArray(yValues) ? [...yValues] : yValues);
      // Get matrix [[]] needed for z in 3D
      let zData: AxisData | number | string | Complex = selectedPlot.yData;

      // Depth of the nested array. Replaces a tf.tensor() that was built only
      // to read shape.length: it copied the entire matrix and was never
      // disposed.
      let depth = 0;
      let probe: unknown = zData;
      while (Array.isArray(probe)) {
        depth += 1;
        probe = probe[0];
      }
      const depthToGoThrough = depth - 2; // z needs a vector of depth 2 ([][])
      for (let index = 0; index < depthToGoThrough; index++) {
        if (Array.isArray(zData)) {
          zData =
            zData[
              itemDataGrid.coordinates.find(
                (coord) =>
                  coord.axeIndex ===
                  itemDataGrid.coordinates.length - 1 - index,
              ).valueIndex
            ];
        }
      }
      // zData is only a matrix once the loop above has walked down to depth 2;
      // for malformed data it can still be a scalar, which must pass through
      // untouched exactly as it did before.
      setZ(
        Array.isArray(zData)
          ? (zData as (number | string)[][]).map((row) =>
              Array.isArray(row) ? [...row] : row,
            )
          : (zData as unknown as (number | string)[][]),
      );
    }
  }, [data3D, itemDataGrid.coordinates]);

  useEffect(() => {
    if (data3D && x && y && z) {
      setAre3DAxisInit(true);
    }
  }, [data3D, x, y, z]);

  /**
   * Plotly compares `data` by reference, so this array must keep its identity
   * while nothing it depends on changes. `x`, `y` and `z` already hold private
   * copies, made where they are computed, so nothing is copied here.
   */
  const plotData = useMemo<Data[]>(
    () => [
      {
        type: forcedPlotType
          ? forcedPlotType
          : itemDataGrid.selectedPlotMode === 'Heatmap'
            ? 'heatmap'
            : itemDataGrid.selectedPlotMode === 'Contour'
              ? 'contour'
              : 'heatmap',
        contours: {
          coloring: 'lines',
        },
        colorscale: selectedPlot?.customPreferences?.colorscale || 'Viridis',
        colorbar: {
          title: {
            text: zAxis?.name
              ? `${zAxis?.name} ${(zAxis?.unit && '[' + zAxis.unit + ']') || ''}`
              : '',
          },
          exponentformat: 'power',
          showexponent: 'all',
          separatethousands: true,
        },
        hovertemplate:
          'x: %{x}<br>' + 'y: %{y}<br>' + 'z: %{z:,.6g}<extra></extra>',
        x,
        y,
        z,
      },

      // Add geometries in contour type
      ...(itemDataGrid?.geometries ?? []),
    ],
    [
      forcedPlotType,
      itemDataGrid.selectedPlotMode,
      itemDataGrid?.geometries,
      selectedPlot?.customPreferences?.colorscale,
      zAxis?.name,
      zAxis?.unit,
      x,
      y,
      z,
    ],
  );

  return (
    <Grid
      styles={{
        inner: {
          margin: 0,
          width: 'inherit',
          flexWrap: 'nowrap',
          whiteSpace: 'nowrap',
        },
      }}
      mt={10}
    >
      {itemDataGrid.coordinates.filter((coord) => coord.name !== '')?.length >
        0 &&
        showSliders && (
          <>
            <Grid.Col
              className={classes.handlePlotExplorationContainer}
              span="content"
              mt={25}
            >
              <Stack gap={5}>
                {['x', 'y'].map((targetAxis: 'x' | 'y', axisIndex) => (
                  <Group key={`handle_axis_${axisIndex}`} gap={5}>
                    <Text>{targetAxis}</Text>
                    <Select
                      label=""
                      value={
                        itemDataGrid.coordinates.find(
                          (coord: Coordinates) =>
                            coord.axeIndex === (targetAxis === 'y' ? 1 : 0),
                        ).name
                      }
                      data={(itemDataGrid.geometries.length // In contour plot, allow to transpose only x & y to keep compatibles coordinates with geometries
                        ? itemDataGrid.coordinates.filter(
                            (coord) =>
                              coord.axeIndex === 0 || coord.axeIndex === 1,
                          )
                        : itemDataGrid.coordinates
                      ).map((coord: Coordinates) => coord.name)}
                      w={`${width * 0.2}px`}
                      onChange={(value) =>
                        value &&
                        swapAxis(
                          itemDataGrid,
                          itemDataGrid.coordinates.find(
                            (coord: Coordinates) => coord.name === value,
                          ).axeIndex,
                          targetAxis === 'x' ? 0 : 1,
                          false,
                          useIbexStore.getState().active,
                          useIbexStore.getState().updatedConfiguration,
                        )
                      }
                      size="xs"
                      disabled={!itemDataGrid.isEditing}
                    />
                  </Group>
                ))}
              </Stack>

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
                      item.axeIndex !== 0 &&
                      item.axeIndex !== 1 && ( // Don't return slider linked to x & y
                        <VerticalSlider
                          key={`heatmap_slider_${valueIndex}`}
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
                          height={height - 80 - SELECT_AXIS_HEIGHT}
                          disabled={!itemDataGrid.isEditing}
                        />
                      ),
                  )}
                {itemDataGrid.synchronizedGrids.list.length && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 12,
                      ...(itemDataGrid.coordinates.length > 2
                        ? { right: -20 }
                        : { left: 0 }),
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
          </>
        )}

      {are3DAxisInit && [x, y, z].every(isMatrixPlottable) ? (
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
          <Plot
            ref={plotRef}
            data={plotData}
            config={getPlotConfig(itemDataGrid.static)}
            layout={layoutPlot}
            onRelayout={handleRelayout}
            onAfterPlot={handleAfterPlot}
            useResizeHandler={false}
            className={classe.plot2D}
          />
        </Grid.Col>
      ) : are3DAxisInit && ![x, y, z].some(isMatrixPlottable) ? (
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
          <Center h={height}>
            <NoDataForURI
              itemDataGrid={itemDataGrid}
              selectedPlot={selectedPlot}
            />
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
          <Center h={height}>
            <Text>{are3DAxisInit ? 'Current index has no data' : ''}</Text>
          </Center>
        </Grid.Col>
      )}
    </Grid>
  );
};
