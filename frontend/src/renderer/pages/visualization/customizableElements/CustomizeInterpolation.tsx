import { useEffect, useRef, useState } from 'react';
import { DataGridPlot } from '../../../types';
import {
  fetchDataPlot,
  fetchErrorBands,
  getArrayValueFromDependance,
  getFirstArrayValueFromShape,
  getVectorData,
  normalizeIndices,
  getInterpolationMethods,
  getUrisToInterpolate,
  reapplyAxisOrder,
} from '../../../utils';
import { showNotification } from '@mantine/notifications';
import { Group, Loader, Select, Stack } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { OptionWithTooltip } from '../../../types/components/select';
import { RenderSelectOption } from '../../../components/select';

interface CustomizeInterpolationProps {
  customizedDataGrid: DataGridPlot;
  setCustomizedDataGrid: React.Dispatch<React.SetStateAction<DataGridPlot>>;
}
export const CustomizeInterpolation = ({
  customizedDataGrid,
  setCustomizedDataGrid,
}: CustomizeInterpolationProps) => {
  const [interpolationMethods, setInterpolationMethods] = useState<
    OptionWithTooltip[]
  >([]);
  const [selectedInterpolation, setSelectedInterpolation] = useState<string>(
    customizedDataGrid.interpolated_method,
  );
  const [loading, { open, close }] = useDisclosure();
  // Identifies the request in flight. A method selected while an earlier one is
  // still running used to leave both writing to the grid, last response wins.
  const currentRequest = useRef(0);

  /**
   * Update configuration with interpolated data (changes coordinates, plots & error bands)
   */
  const getInterpolatedData = async () => {
    const requestId = currentRequest.current + 1;
    currentRequest.current = requestId;
    try {
      open();
      const updatedDataPlot = structuredClone(
        customizedDataGrid,
      ) as DataGridPlot;

      let plotIndex = 0;
      for (const plot of updatedDataPlot.plot) {
        // Interpolated data
        const urisToInterpolate = getUrisToInterpolate(
          plot.nodeUri,
          updatedDataPlot.plot,
        );
        const dataPlotInterpolated = await fetchDataPlot(
          normalizeIndices(plot.nodeUri),
          customizedDataGrid?.downsampled_method,
          customizedDataGrid?.downsampled_size,
          updatedDataPlot?.dataType,
          urisToInterpolate,
          selectedInterpolation,
        );

        if (plot?.error_bands?.length) {
          // Interpolate error bands with provided parameters if error bands exists for this plot
          await fetchErrorBands(
            updatedDataPlot,
            plot.nodeUri,
            undefined,
            undefined,
            selectedInterpolation,
          );
        }

        if (plotIndex === 0) {
          // Update coordinates with interpolated data only once because each plots have same coordinates
          let coordinateIndex = 0;
          for (const coordinate of updatedDataPlot.coordinates) {
            // Apply new shape
            coordinate.shape =
              dataPlotInterpolated.data.coordinates[
                coordinateIndex
              ].downsampled_shape;
            // Apply new data
            coordinate.data =
              dataPlotInterpolated.data.coordinates[coordinateIndex].value;
            coordinateIndex++;
            // Apply new range
            coordinate.range = [
              0,
              coordinate.shape[coordinate.shape.length - 1] - 1,
            ];
            const firstArrayValueFromCoord = getFirstArrayValueFromShape(
              coordinate.data,
              coordinate.shape,
            );

            coordinate.rangeValues = [
              firstArrayValueFromCoord[0],
              firstArrayValueFromCoord[firstArrayValueFromCoord.length - 1],
            ];
          }

          // Update interpolated method
          updatedDataPlot.interpolated_method =
            dataPlotInterpolated.data.interpolated_method;
        }

        // Update plot with interpolated data
        plot.shape = dataPlotInterpolated.data.downsampled_shape;
        // Get x axis switch coordinates dependances
        plot.x = getArrayValueFromDependance(updatedDataPlot.coordinates, 0);
        plot.yData = dataPlotInterpolated.data.value;
        // Get y axis
        const vectorData = getVectorData(
          updatedDataPlot.coordinates,
          plot.yData,
        );
        plot.y = vectorData;

        plotIndex++;
      }

      // Re-apply axis transposition: the back-end returns data in default axis
      // order, so restore the user's transposition after the fetch
      const wantedAxeIndexOrder = customizedDataGrid.coordinates.map(
        (coord) => coord.axeIndex,
      );
      await reapplyAxisOrder(updatedDataPlot, wantedAxeIndexOrder);

      // Save new configuration with interpolated data, unless another method
      // was selected while this one was in flight.
      if (currentRequest.current !== requestId) {
        return;
      }
      setCustomizedDataGrid({
        ...customizedDataGrid,
        coordinates: updatedDataPlot.coordinates,
        interpolated_method: updatedDataPlot.interpolated_method,
        plot: updatedDataPlot.plot,
      });
    } catch (error) {
      console.error('Error getting interpolated data: ', error);
      showNotification({
        title: 'Error',
        message: `Unable to get interpolated data.`,
        color: 'red',
      });
    } finally {
      if (currentRequest.current === requestId) {
        close();
      }
    }
  };

  /*
   * Get interpolated methods to show in select
   */
  useEffect(() => {
    const getInterpolationOptions = async () => {
      const options = await getInterpolationMethods();
      setInterpolationMethods(options);
    };
    getInterpolationOptions();
  }, []);

  useEffect(() => {
    if (selectedInterpolation !== customizedDataGrid?.interpolated_method) {
      getInterpolatedData();
    }
  }, [selectedInterpolation]);

  return (
    <Stack w="fit-content">
      <Group align="flex-end" justify="space-between">
        <Select
          label="Method"
          description="Select the method"
          placeholder="Select the method"
          value={selectedInterpolation}
          data={interpolationMethods.map((meth) => meth.value)}
          rightSection={loading ? <Loader size={16} /> : null}
          // Selecting another method mid-flight refetched every plot in the
          // grid a second time; the two results then raced.
          disabled={loading}
          onChange={(selectedMethod) => {
            if (selectedMethod !== selectedInterpolation) {
              setSelectedInterpolation(selectedMethod || selectedInterpolation);
            }
          }}
          renderOption={(option) => {
            const selectedOption = interpolationMethods.find(
              (meth) => option.option.value === meth.value,
            );
            return (
              <RenderSelectOption
                option={selectedOption}
                checked={option.checked}
              />
            );
          }}
        />
      </Group>
    </Stack>
  );
};
