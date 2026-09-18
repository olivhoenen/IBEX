import { useCallback, useEffect, useState } from 'react';
import {
  Axis,
  Configuration,
  Coordinates,
  CustomizedGridType,
  DataGridPlot,
  DataPlotly,
  GridLayoutPlotProps,
  NodeInfoTypeEnum,
  URITreeNodeData,
} from '../../../renderer/types';
import { Center, Container, Text } from '@mantine/core';
import { SimplePlotly, Heatmap2D } from '../plot';
import { useIbexStore } from '../../stores';
import { countRender } from '../../utils/perf';
import {
  getArrayValueFromDependance,
  getErrorYVectors,
  getLastIndexedField,
  getVectorData,
  limitSlidersToMaxLength,
  normalizeIndices,
  updateIndexFieldName,
} from '../../utils';
import { MetaDataInfos } from '../../pages/visualization/VisualizationMetaData';
import { HoverButtons } from './HoverButtons';

export const GridLayoutPlot = ({
  data,
  colWidth,
  rowHeight,
}: GridLayoutPlotProps) => {
  const { active, updatedConfiguration } = useIbexStore();
  countRender(`GridLayoutPlot:${data.i}`);
  const [heightGrid, setHeightGrid] = useState(
    data.h * rowHeight + (23 * (data.h * rowHeight)) / 100,
  );
  const [widthGrid, setWidthGrid] = useState(Math.floor(data.w * colWidth));
  const [is3DView, setIs3DView] = useState<boolean>(
    data?.selectedPlotMode === 'Heatmap' || data?.selectedPlotMode === 'Contour'
      ? true
      : false,
  );
  const [active3DTab, setActive3DTab] = useState<string>('0');
  const [metadataTabsValue, setMetadataTabsValue] = useState<string>(
    data.plot[0]?.path || '',
  );
  const [shouldDisplayMetadata, setShouldDisplayMetadata] = useState(false);

  /**
   * updateslider coordinate value
   */
  const handleUpdateCoordinate = async (
    coordinate: Coordinates,
    valueIndex: number,
  ) => {
    // Check if the coordinate has a target
    const lastTargetLastName = getLastIndexedField(coordinate.target);
    if (!lastTargetLastName)
      return console.warn('No indexed field found in target');

    const updatedActive: Configuration = {
      ...active,
      dataPlot: active.dataPlot.map((item: DataGridPlot) => {
        const mainDataGrid = item.i === data.i;
        const isSynchronized = data.synchronizedGrids.list.includes(item.i);
        const coordWithSameName = item.coordinates.find(
          (ic) => ic.name === coordinate.name,
        );
        const sameCoordinate =
          coordWithSameName &&
          JSON.stringify(coordinate.data) ===
            JSON.stringify(coordWithSameName.data);

        if (mainDataGrid || (isSynchronized && sameCoordinate)) {
          // Update main slider with new valueIndex & update synchronized ones matching with the same coordinate
          const updatedCoordinatesValue = item.coordinates.map((coordItem) => {
            const updatedPath = updateIndexFieldName(
              coordItem.path,
              lastTargetLastName,
              valueIndex,
            );
            const updatedTarget = updateIndexFieldName(
              coordItem.target,
              lastTargetLastName,
              valueIndex,
            );

            return {
              ...coordItem,
              path: updatedPath,
              target: updatedTarget,
              valueIndex:
                coordItem.name === coordinate.name
                  ? valueIndex
                  : coordItem.valueIndex,
            };
          }) as Coordinates[];
          limitSlidersToMaxLength(updatedCoordinatesValue);

          const updatedXAxisData: Axis = {
            ...item.xAxisData,
            path: updateIndexFieldName(
              item.xAxisData?.path || '',
              lastTargetLastName,
              valueIndex,
            ),
          };

          // Get x values switch x dependances
          const newXData = getArrayValueFromDependance(
            updatedCoordinatesValue,
            0,
          );

          const updatedPlot = item.plot.map((plotItem) => {
            const updatedNodeUri = updateIndexFieldName(
              plotItem.nodeUri,
              lastTargetLastName,
              valueIndex,
            );

            const updatedPath = updateIndexFieldName(
              plotItem.path || '',
              lastTargetLastName,
              valueIndex,
            );

            const newYData = getVectorData(
              updatedCoordinatesValue,
              plotItem.yData,
            );

            if (plotItem?.error_bands?.length) {
              const updated_error_bands = getErrorYVectors(
                plotItem,
                updatedCoordinatesValue,
              );
              let customdata;
              if (plotItem.error_bands.length === 2) {
                customdata = plotItem.error_bands[0].array.map((v, i) => [
                  plotItem.error_bands[0].array[i],
                  plotItem.error_bands[1].array[i],
                ]);
              } else {
                customdata = plotItem.error_bands[0].array.map((v, i) => [
                  plotItem.error_bands[0].array[i],
                ]);
              }

              return {
                ...plotItem,
                x: [...newXData],
                y: [...newYData],
                customdata: customdata,
                error_bands: updated_error_bands,
                nodeUri: updatedNodeUri,
                path: updatedPath,
              };
            } else {
              return {
                ...plotItem,
                x: [...newXData],
                y: [...newYData],
                nodeUri: updatedNodeUri,
                path: updatedPath,
              };
            }
          });

          return {
            ...item,
            coordinates: updatedCoordinatesValue,
            plot: updatedPlot,
            xAxisData: updatedXAxisData,
          };
        }

        return item;
      }) as DataGridPlot[],
    };

    updatedConfiguration(updatedActive);
  };

  useEffect(() => {
    let forceToDisplayMetadata = false;

    // Rule to force to show metadata when y data is of type string
    let isYDataString = false;
    for (const plot of data.plot) {
      if (plot.y) {
        const typeOfYData = typeof plot.y[0];
        if (typeOfYData === 'string') {
          isYDataString = true;
        }
      }
    }

    // Rule to force to show metadata when y data is a geometry
    let isGeometry = false;
    if (data.is_geometry_node === true) {
      isGeometry = true;
    }

    forceToDisplayMetadata = isYDataString || isGeometry;
    setShouldDisplayMetadata(forceToDisplayMetadata);
  }, [data.plot.length]);

  /**
   * Handle resize the grid
   */
  useEffect(() => {
    setHeightGrid(data.h * rowHeight + (23 * (data.h * rowHeight)) / 100);
    setWidthGrid(Math.floor(data.w * colWidth));
  }, [data.h, rowHeight, data.w, colWidth]);

  useEffect(() => {
    if (parseInt(active3DTab) > data.plot.length - 1) {
      setActive3DTab('0');
    }

    // Update metadataTabsValue for metadata when removing selected tab
    if (
      !data.plot.find((plot: DataPlotly) => plot.path === metadataTabsValue)
    ) {
      setMetadataTabsValue(data.plot[0]?.path);
    }
  }, [data.plot]);

  useEffect(() => {
    setIs3DView(
      data?.selectedPlotMode === 'Heatmap' ||
        data?.selectedPlotMode === 'Contour'
        ? true
        : false,
    );
  }, [data.selectedPlotMode]);

  /**
   * Handle the delete grid event
   */
  const handleDeleteGrid = useCallback((id: string) => {
    const { active, updatedConfiguration } = useIbexStore.getState();
    const newDataPlot: DataGridPlot[] = active.dataPlot.filter(
      (item: DataGridPlot) => item.i !== id,
    );
    const checkedNodeURI = newDataPlot.find((dataPlot) => dataPlot.isEditing)
      ? active.checkedNodeURI
      : [];
    const newActive: Configuration = {
      ...active,
      saved: false,
      dataPlot: newDataPlot,
      checkedNodeURI: checkedNodeURI,
    };

    // Remove from synchronized relations deleted dataGrid
    const oldDataPlot = active.dataPlot.find(
      (item: DataGridPlot) => item.i === id,
    );
    for (const synchronizedId of oldDataPlot.synchronizedGrids.list) {
      const dataPlotToUpdate = newDataPlot.find(
        (dp) => synchronizedId === dp.i,
      );
      const updatedList = dataPlotToUpdate.synchronizedGrids.list.filter(
        (id) => id !== oldDataPlot.i,
      );
      dataPlotToUpdate.synchronizedGrids = {
        color:
          updatedList.length > 0
            ? dataPlotToUpdate.synchronizedGrids.color
            : '',
        list: updatedList,
      };
    }

    updatedConfiguration(newActive);
  }, []);

  /**
   * Handle edit grid event
   */
  const handleEditGrid = useCallback(
    (id: string) => {
      const { active, updatedConfiguration } = useIbexStore.getState();

      const findPlot = active.dataPlot.find((item) => item.i === id);
      if (!findPlot) return;

      const updatedDataPlot = active.dataPlot.map((item) =>
        item.i === id
          ? { ...item, isEditing: !item.isEditing, static: !item.isEditing }
          : { ...item, isEditing: false, static: false },
      );

      // Check from tree selected plots (all plots used in dataGrid)
      const checkedNodeURI: URITreeNodeData[] = !findPlot.isEditing
        ? findPlot.plot.map((item) => ({
            uri: normalizeIndices(item.nodeUri),
            name: item.labelUri,
            type: findPlot.dataType,
            is_geometry_node: findPlot.is_geometry_node,
          }))
        : [];

      if (checkedNodeURI.length) {
        for (const plot of findPlot.plot) {
          if (!plot.error_bands) {
            continue;
          }

          for (const error_band of plot.error_bands) {
            const newCheckedNode = {
              name: plot.labelUri,
              uri: normalizeIndices(error_band.path),
              type: findPlot.dataType,
              is_geometry_node: findPlot.is_geometry_node,
            };
            const exists = checkedNodeURI.some(
              (node) =>
                node.name === newCheckedNode.name &&
                node.uri === newCheckedNode.uri,
            );
            if (!exists) {
              // Check from tree selected error bands to plot
              checkedNodeURI.push(newCheckedNode);
            }
          }
        }

        if (findPlot?.geometries) {
          // Check geometries in tree
          for (const geometry of findPlot.geometries) {
            for (const uriOfGeo of geometry.nodeUris) {
              const newCheckedNode = {
                name: findPlot.plot[0].labelUri,
                uri: normalizeIndices(uriOfGeo),
                type: NodeInfoTypeEnum.FLOAT,
                is_geometry_node: true,
              } as URITreeNodeData;
              const exists = checkedNodeURI.some(
                (node) =>
                  node.name === newCheckedNode.name &&
                  node.uri === newCheckedNode.uri,
              );
              if (!exists) {
                checkedNodeURI.push(newCheckedNode);
              }
            }
          }
        }
      }

      const updatedActive: Configuration = {
        ...active,
        saved: false,
        dataPlot: updatedDataPlot,
        checkedNodeURI: checkedNodeURI,
      };

      updatedConfiguration(updatedActive);
    },
    [active],
  );

  /**
   * Inspect metadata of plot
   */
  const handleInspectMetadata = useCallback(
    (id: string) => {
      const updatedActive: Configuration = {
        ...active,
        metadataGridLayout: id,
      };
      updatedConfiguration(updatedActive);
    },
    [active],
  );

  /**
   * Customize plot
   */
  const handleCustomization = useCallback(
    (id: string, typeOfEdition: CustomizedGridType) => {
      const updatedActive: Configuration = {
        ...active,
        customizedGridLayout: { id: id, type: typeOfEdition },
      };
      updatedConfiguration(updatedActive);
    },
    [active],
  );

  return (
    <Container fluid w={widthGrid} p={0}>
      {active.dataURI.length > 0 && (
        <HoverButtons
          data={data}
          shouldDisplayMetadata={shouldDisplayMetadata}
          handleEditGrid={handleEditGrid}
          handleInspectMetadata={handleInspectMetadata}
          handleCustomization={handleCustomization}
          handleDeleteGrid={handleDeleteGrid}
          is3DView={is3DView}
          active3DTab={active3DTab}
          setActive3DTab={setActive3DTab}
        />
      )}

      {!(active.dataURI.length > 0) ? (
        // Control when loading a template without selecting URIs
        <Center h={heightGrid}>
          <Text>Current configuration has no data. Please, select URIs.</Text>
        </Center>
      ) : !data.coordinates.length || shouldDisplayMetadata ? (
        <Container pt="40px" p="1rem">
          {data.plot.map((plot: DataPlotly, index) => {
            return (
              index.toString() === active3DTab && (
                <MetaDataInfos
                  key={`metadata_${data.i}`}
                  gridLayoutKey={data.i}
                  data={plot}
                  yAxis={plot.yaxis !== '' ? data.y2AxisData : data.yAxisData}
                  height={(heightGrid - 72).toString()} // 72px is equivalent to paddings (40px from top + 2rem for y padding)
                  tabsSelected={plot.path}
                />
              )
            );
          })}
        </Container>
      ) : is3DView ? (
        // Show heatmap
        <Heatmap2D
          itemDataGrid={data}
          width={widthGrid}
          height={heightGrid}
          plotIndex={active3DTab}
          showSliders={true}
          handleUpdateCoordinate={handleUpdateCoordinate}
        />
      ) : (
        // Show simple plot
        <SimplePlotly
          itemDataGrid={data}
          width={widthGrid}
          height={heightGrid}
          showSliders={true}
          is3DView={is3DView}
          handleUpdateCoordinate={handleUpdateCoordinate}
        />
      )}
    </Container>
  );
};
