import {
  Accordion,
  ActionIcon,
  Container,
  Grid,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useIbexStore } from '../../stores';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SimplePlotly, Heatmap2D, TabsListCustom } from '../../components';
import {
  Configuration,
  CustomizedGridType,
  DataGridPlot,
  DataPlotly,
  synchronizedList,
} from '../../types';
import {
  CustomizeDownsampling,
  CustomizeGlobal,
  CustomizeHeatmap,
  Customize1DPlot,
  CustomizeDataRange,
  CustomizeSynchronization,
  CustomizeInterpolation,
  CustomizeSmoothing,
  CustomizeDataOperations,
  CustomizeGeometry,
} from './customizableElements';
import { IconGeometry, IconLink } from '@tabler/icons-react';
import { initPlotColors } from '../../utils';

export const DataplotCustomization = () => {
  const customContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const WIDTH_PLOT = Math.floor(containerWidth * (6 / 12));
  const HEIGHT_PLOT = 390;
  const { active, updatedConfiguration } = useIbexStore();
  const [tabsValue, setTabsValue] = useState<string | null>();
  const [customizedDataGrid, setCustomizedDataGrid] =
    useState<DataGridPlot | null>(null);
  const [dataGridLayout, setDataGridLayout] = useState<DataGridPlot | null>(
    null,
  );
  const [selectedAccordion, setSelectedAccordion] = useState<string | null>(
    null,
  );
  const [selectedPlot, setSelectedPlot] = useState<DataPlotly | null>(null);
  const [applyToAllHeatmap, setApplyToAllHeatmap] = useState(true);

  useEffect(() => {
    if (customizedDataGrid) {
      // Update dataGridLayout when customizedDataGrid changes
      const updatedDataGridLayout = {
        ...dataGridLayout,
        title: customizedDataGrid?.title,
        downsampled_method: customizedDataGrid?.downsampled_method,
        interpolated_method: customizedDataGrid.interpolated_method,
        plot: customizedDataGrid?.plot,
        // A data operation can change a unit and move a plot to the second axis
        yAxisData: customizedDataGrid?.yAxisData,
        y2AxisData: customizedDataGrid?.y2AxisData,
      } as DataGridPlot;
      setDataGridLayout(updatedDataGridLayout);
      setSelectedPlot(
        updatedDataGridLayout.plot.find((data) => data.name === tabsValue),
      );
    }
  }, [customizedDataGrid]);

  /**
   * Handle find grid layout corresponding to the selected tab
   */
  useEffect(() => {
    if (active?.customizedGridLayout) {
      const data = structuredClone(
        active.dataPlot.find(
          (item: DataGridPlot) => item.i === active.customizedGridLayout.id,
        ),
      );
      if (data) {
        setDataGridLayout(data);
        setCustomizedDataGrid(data);
        setTabsValue(data.plot[0]?.name || null);
      }
    }
  }, []);

  useEffect(() => {
    initPlotColors(
      customizedDataGrid,
      customContainerRef,
      setCustomizedDataGrid,
    );
  }, [customContainerRef.current]);

  /**
   * Handle the resizing of the width
   */
  useEffect(() => {
    if (!customContainerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(customContainerRef.current);
    return () => observer.disconnect();
  }, [tabsValue]);

  /**
   * Handle close of customization
   */
  const closeWithoutSaving = useCallback(() => {
    // Closing the panel changes one field; there is nothing to deep-copy.
    const updatedActive: Configuration = {
      ...active,
      customizedGridLayout: null,
    };
    updatedConfiguration(updatedActive);
  }, [active]);

  /**
   * Handle save & close of customization
   */
  const saveAndClose = useCallback(() => {
    const updatedActive: Configuration = {
      ...active,
      customizedGridLayout: null,
      saved: false,
    };
    const oldDataGrid = updatedActive.dataPlot.find(
      (dp) => dp.i === active.customizedGridLayout.id,
    );
    const updatedDataPlot: DataGridPlot[] = [
      ...updatedActive.dataPlot.filter(
        (dp) => dp.i !== active.customizedGridLayout.id,
      ),
      customizedDataGrid,
    ];

    // Update synchronized grids dependencies
    if (
      structuredClone(oldDataGrid.synchronizedGrids.list).sort().toString() !==
      structuredClone(customizedDataGrid.synchronizedGrids.list)
        .sort()
        .toString()
    ) {
      for (const [
        index,
        dataPlotDependency,
      ] of updatedActive.dataPlot.entries()) {
        if (dataPlotDependency.i !== customizedDataGrid.i) {
          // Add & remove automatically dataPlots excepted the updated one
          if (
            !oldDataGrid.synchronizedGrids.list.includes(
              dataPlotDependency.i,
            ) &&
            customizedDataGrid.synchronizedGrids.list.includes(
              dataPlotDependency.i,
            )
          ) {
            const newSynchronizedList = {
              color: customizedDataGrid.synchronizedGrids.color,
              list: [
                customizedDataGrid.i,
                ...customizedDataGrid.synchronizedGrids.list.filter(
                  (i) => i !== dataPlotDependency.i,
                ),
              ],
            } as synchronizedList;

            // Reset synchronized list for deleted dependencies
            for (const oldSyncIdFromNewDep of dataPlotDependency
              .synchronizedGrids.list) {
              const indexDPProbablyDesync = updatedActive.dataPlot.findIndex(
                (dp) => oldSyncIdFromNewDep === dp.i,
              );
              if (
                !newSynchronizedList.list.includes(
                  updatedActive.dataPlot[indexDPProbablyDesync].i,
                )
              ) {
                updatedActive.dataPlot[
                  indexDPProbablyDesync
                ].synchronizedGrids = { color: '', list: [] };
              }
            }

            // Add in other grid the synchronized list and include the customized grid
            updatedActive.dataPlot[index].synchronizedGrids =
              newSynchronizedList;
          } else if (
            oldDataGrid.synchronizedGrids.list.includes(dataPlotDependency.i) &&
            !customizedDataGrid.synchronizedGrids.list.includes(
              dataPlotDependency.i,
            )
          ) {
            // Remove synchronization for deleted dependencies
            updatedActive.dataPlot[index].synchronizedGrids = {
              color: '',
              list: [],
            };
          } else if (
            customizedDataGrid.synchronizedGrids.list.includes(
              dataPlotDependency.i,
            )
          ) {
            // Update relations of unchanged dataGrids
            updatedActive.dataPlot[index].synchronizedGrids = {
              color: customizedDataGrid.synchronizedGrids.color,
              list: [
                customizedDataGrid.i,
                ...customizedDataGrid.synchronizedGrids.list.filter(
                  (i) => i !== dataPlotDependency.i,
                ),
              ],
            };
          }
        }
      }
    }

    updatedConfiguration({ ...updatedActive, dataPlot: updatedDataPlot });
  }, [active, customizedDataGrid]);

  /**
   * Handle selected tab change
   */
  const handleSelectedTab = useCallback(
    (value: string | null) => {
      setTabsValue(value);
      if (dataGridLayout) {
        const plotTab = dataGridLayout.plot.find((item) => item.name === value);
        if (plotTab) {
          setSelectedPlot(plotTab);
        }
      }
    },
    [dataGridLayout, setCustomizedDataGrid],
  );

  return (
    <Container fluid pb={10}>
      <Tabs value={tabsValue} onChange={(value) => handleSelectedTab(value)}>
        <TabsListCustom
          data={
            dataGridLayout
              ? dataGridLayout.plot
                  .map((item) => item?.name || '')
                  .filter((item) => item)
              : []
          }
          value={tabsValue}
          usedFor="personalization"
          closeWithoutSaving={closeWithoutSaving}
          saveAndClose={saveAndClose}
        />

        {dataGridLayout &&
          dataGridLayout.plot.map((item: DataPlotly, index) => {
            // force to have only one axis in metadata plot
            const itemWithoutY2axis = structuredClone(item);
            if (item.yaxis != '') {
              delete itemWithoutY2axis.yaxis;
            }

            return (
              item?.name && (
                <Tabs.Panel key={index} value={item.name}>
                  {tabsValue === item.name && (
                    <Grid type="container" ref={customContainerRef}>
                      <Grid.Col span={6}>
                        {selectedAccordion === 'Heatmap' ||
                        selectedAccordion === 'Geometry' ? (
                          <Heatmap2D
                            itemDataGrid={customizedDataGrid}
                            width={WIDTH_PLOT}
                            height={HEIGHT_PLOT}
                            plotIndex={customizedDataGrid.plot
                              .findIndex((data) => data.name === item.name)
                              .toString()}
                            showSliders={false}
                            forcedPlotType={
                              selectedAccordion === 'Heatmap'
                                ? 'heatmap'
                                : 'contour'
                            }
                          />
                        ) : (
                          <SimplePlotly
                            itemDataGrid={customizedDataGrid}
                            width={WIDTH_PLOT}
                            height={HEIGHT_PLOT}
                            showSliders={false}
                          />
                        )}
                      </Grid.Col>
                      <Grid.Col span={6}>
                        <Customization
                          customizedDataGrid={customizedDataGrid}
                          customizedType={active.customizedGridLayout.type}
                          selectedAccordion={selectedAccordion}
                          selectedPlot={selectedPlot}
                          applyToAllHeatmap={applyToAllHeatmap}
                          customContainerRef={customContainerRef}
                          setCustomizedDataGrid={setCustomizedDataGrid}
                          setSelectedAccordion={setSelectedAccordion}
                          setApplyToAllHeatmap={setApplyToAllHeatmap}
                        />
                      </Grid.Col>
                    </Grid>
                  )}
                </Tabs.Panel>
              )
            );
          })}
      </Tabs>
    </Container>
  );
};

interface CustomizationProps {
  customizedDataGrid: DataGridPlot;
  customizedType: CustomizedGridType;
  selectedAccordion: string | null;
  selectedPlot: DataPlotly | null;
  applyToAllHeatmap: boolean;
  customContainerRef: React.MutableRefObject<HTMLDivElement>;
  setCustomizedDataGrid: React.Dispatch<React.SetStateAction<DataGridPlot>>;
  setSelectedAccordion: React.Dispatch<React.SetStateAction<string | null>>;
  setApplyToAllHeatmap: React.Dispatch<React.SetStateAction<boolean>>;
}
const Customization = ({
  customizedDataGrid,
  customizedType,
  selectedAccordion,
  selectedPlot,
  applyToAllHeatmap,
  customContainerRef,
  setCustomizedDataGrid,
  setSelectedAccordion,
  setApplyToAllHeatmap,
}: CustomizationProps) => {
  type accordionItemsType = {
    value: string;
    component: JSX.Element;
    icon?: JSX.Element;
    disabled?: boolean;
    tooltip?: string;
  };
  const visualAccordions: accordionItemsType[] = [
    {
      value: 'Global',
      component: (
        <CustomizeGlobal
          customizedDataGrid={customizedDataGrid}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
    },
    {
      value: '1D plots',
      component: (
        <Customize1DPlot
          customizedDataGrid={customizedDataGrid}
          selectedPlot={selectedPlot}
          customContainerRef={customContainerRef}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
      icon: (
        <ActionIcon variant="filled" component="span">
          <Text fw="bold">1D</Text>
        </ActionIcon>
      ),
    },
    {
      value: 'Heatmap',
      component: (
        <CustomizeHeatmap
          customizedDataGrid={customizedDataGrid}
          selectedPlot={selectedPlot}
          applyToAllHeatmap={applyToAllHeatmap}
          setCustomizedDataGrid={setCustomizedDataGrid}
          setApplyToAllHeatmap={setApplyToAllHeatmap}
        />
      ),
      icon: (
        <ActionIcon
          variant="filled"
          component="span"
          disabled={customizedDataGrid.coordinates.length < 2}
        >
          <svg width="50" height="50" viewBox="0 0 50 50">
            <rect x="0" y="0" width="15" height="15" fill="#440154" />
            <rect x="17" y="0" width="15" height="15" fill="#31688e" />
            <rect x="34" y="0" width="15" height="15" fill="#35b779" />

            <rect x="0" y="17" width="15" height="15" fill="#fde725" />
            <rect x="17" y="17" width="15" height="15" fill="#440154" />
            <rect x="34" y="17" width="15" height="15" fill="#31688e" />

            <rect x="0" y="34" width="15" height="15" fill="#35b779" />
            <rect x="17" y="34" width="15" height="15" fill="#fde725" />
            <rect x="34" y="34" width="15" height="15" fill="#440154" />
          </svg>
        </ActionIcon>
      ),
      disabled: customizedDataGrid.coordinates.length < 2,
      tooltip: "This grid can't display heatmap",
    },
    {
      value: 'Geometry',
      component: (
        <CustomizeGeometry
          customizedDataGrid={customizedDataGrid}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
      icon: (
        <ActionIcon
          variant="filled"
          component="span"
          disabled={customizedDataGrid.coordinates.length < 2}
        >
          <IconGeometry width={20} />
        </ActionIcon>
      ),
      disabled: customizedDataGrid.coordinates.length < 2,
      tooltip: "This grid can't have geometries",
    },
    {
      value: 'Axis range',
      component: (
        <CustomizeDataRange
          customizedDataGrid={customizedDataGrid}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
    },
    {
      value: 'Dataplots synchronization',
      component: (
        <CustomizeSynchronization
          customizedDataGrid={customizedDataGrid}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
      icon:
        customizedDataGrid.synchronizedGrids.color !== '' ? (
          <IconLink
            size={20}
            color={customizedDataGrid.synchronizedGrids.color}
          />
        ) : (
          <IconLink size={20} />
        ),
      disabled: customizedDataGrid.coordinates.length < 2,
      tooltip: "This grid can't be synchronized",
    },
  ];

  const dataAccordions: accordionItemsType[] = [
    {
      value: 'Downsampling',
      component: (
        <CustomizeDownsampling
          customizedDataGrid={customizedDataGrid}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
    },
    {
      value: 'Interpolation',
      component: (
        <CustomizeInterpolation
          customizedDataGrid={customizedDataGrid}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
    },
    {
      value: 'Data smoothing',
      component: (
        <CustomizeSmoothing
          customizedDataGrid={customizedDataGrid}
          selectedPlot={selectedPlot}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
    },
    {
      value: 'Data operations',
      component: (
        <CustomizeDataOperations
          customizedDataGrid={customizedDataGrid}
          selectedPlot={selectedPlot}
          setCustomizedDataGrid={setCustomizedDataGrid}
        />
      ),
    },
  ];

  const items = (
    customizedType === 'visual' ? visualAccordions : dataAccordions
  ).map((item) => (
    <Tooltip
      key={item.value}
      label={
        item?.disabled
          ? item?.tooltip || 'This feature will be available soon'
          : ''
      }
      position="bottom-start"
      opened={item?.disabled ? null : false}
    >
      <Accordion.Item value={item.value}>
        <Accordion.Control
          icon={item.icon}
          disabled={item?.disabled || false}
          data-testid={`customization-${item.value}-accordion`}
        >
          {item.value}
        </Accordion.Control>
        <Accordion.Panel>{item.component}</Accordion.Panel>
      </Accordion.Item>
    </Tooltip>
  ));

  return (
    <Stack gap={0}>
      <Title ta={'center'} order={3} pt={10}>
        {customizedType === 'visual'
          ? 'Visual customization'
          : 'Data manipulation'}
      </Title>
      <ScrollArea h="79vh">
        <Accordion
          value={selectedAccordion}
          onChange={setSelectedAccordion}
          {...(window.env.E2E_TEST === 'true' && { transitionDuration: 0 })}
        >
          {items}
        </Accordion>
      </ScrollArea>
    </Stack>
  );
};
