import classes from './HoverButtons.module.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Group,
  Tooltip,
  ActionIcon,
  Text,
  Tabs,
  Switch,
  ScrollArea,
  Menu,
} from '@mantine/core';
import {
  IconBrandDatabricks,
  IconCheck,
  IconDatabaseEdit,
  IconEdit,
  IconEyeEdit,
  IconTrash,
  IconTarget,
} from '@tabler/icons-react';
import { useElementSize, useHover, useMergedRef } from '@mantine/hooks';
import {
  Configuration,
  CustomizedGridType,
  DataGridPlot,
  PlotType,
} from '../../types';
import { applyRange, fetchErrorBandsInConfig } from '../../utils';
import { useIbexStore } from '../../stores';

interface HoverButtonsProps {
  data: DataGridPlot;
  shouldDisplayMetadata: boolean;
  handleEditGrid: (id: string) => void;
  handleInspectMetadata: (id: string) => void;
  handleCustomization: (id: string, typeOfEdition: CustomizedGridType) => void;
  handleDeleteGrid: (id: string) => void;
  is3DView: boolean;
  active3DTab: string;
  setActive3DTab: React.Dispatch<React.SetStateAction<string>>;
}

export const HoverButtons = React.memo(
  ({
    data,
    shouldDisplayMetadata,
    handleEditGrid,
    handleInspectMetadata,
    handleCustomization,
    handleDeleteGrid,
    is3DView,
    active3DTab,
    setActive3DTab,
  }: HoverButtonsProps) => {
    const { active, updatedConfiguration } = useIbexStore();
    const { hovered, ref: hoverRef } = useHover();
    const { ref: sizeRef, width: containerWidth } = useElementSize();
    const containerRef = useMergedRef(hoverRef, sizeRef);
    const previousValueDisplayErrorBands = useRef<boolean | undefined>(
      undefined,
    );
    const [plotMode, setPlotMode] = useState<PlotType>(
      active.dataPlot.find((dataPlot) => dataPlot.i === data.i)
        ?.selectedPlotMode,
    );
    const [plotTypeMenuOpened, setPlotTypeMenuOpened] = useState(false);
    const [forcePlotTypeMenuOpened, setForcePlotTypeMenuOpened] =
      useState(false);

    const heatmapLogo = (
      <svg width="20" height="20" viewBox="0 0 50 50">
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
    );

    const modes: {
      value: PlotType;
      icon?: React.ReactNode;
    }[] = [
      { value: '1D' },
      { value: 'Heatmap', icon: heatmapLogo },
      { value: 'Contour', icon: <IconTarget width={22} /> },
    ];

    const updateDisplayErrorBands = useCallback(
      (newValue: boolean) => {
        // Copy only the grid being changed: cloning the configuration here
        // deep-copied every fetched array to flip one boolean.
        const updatedActive: Configuration = {
          ...active,
          dataPlot: active.dataPlot.map((dataPlot) =>
            dataPlot.i === data.i
              ? { ...dataPlot, displayErrorBand: newValue }
              : dataPlot,
          ),
        };
        updatedConfiguration(updatedActive);
      },
      [active],
    );

    const removeErrorBands = useCallback(
      (active: Configuration) => {
        const selectedDataPlot = active.dataPlot.find(
          (dataPlot) => dataPlot.i === data.i,
        );
        for (const plot of selectedDataPlot.plot) {
          active.checkedNodeURI = active.checkedNodeURI.filter(
            (checkedNode) =>
              !plot?.error_bands
                ?.map((err) => err.path)
                ?.includes(checkedNode.uri),
          );
          delete plot?.error_bands;
        }
      },
      [active],
    );

    useEffect(() => {
      const updateErrorBands = async () => {
        const updatedActive = structuredClone(active) as Configuration;
        if (data.displayErrorBand) {
          if (
            (previousValueDisplayErrorBands.current === false ||
              previousValueDisplayErrorBands.current === undefined) &&
            data.displayErrorBand === true
          ) {
            // Get all error bands from selected dataPlot when user active error bands
            const selectedDataPlot = updatedActive.dataPlot.find(
              (dataPlot) => dataPlot.i === data.i,
            );
            for (const plot of selectedDataPlot.plot) {
              await fetchErrorBandsInConfig(updatedActive, plot.nodeUri);
            }

            if (previousValueDisplayErrorBands.current === false) {
              // Apply ranges to the new error bands added with switch "display error bands" and if not already applied at load
              for (const coordinate of selectedDataPlot.coordinates) {
                if (coordinate?.range) {
                  const keepValueIndex = true;
                  await applyRange(
                    coordinate,
                    coordinate.rangeValues,
                    selectedDataPlot,
                    [
                      ...selectedDataPlot.plot.map(
                        (plot) => plot.nodeUri + '_error_upper',
                      ),
                      ...selectedDataPlot.plot.map(
                        (plot) => plot.nodeUri + '_error_lower',
                      ),
                    ],
                    keepValueIndex,
                  );
                }
              }
            }
          }
        } else {
          // Removes all error bands from selected dataPlot
          removeErrorBands(updatedActive);
        }
        // Update previous value (used to determine the condition: previous === false && new === true)
        previousValueDisplayErrorBands.current = data.displayErrorBand;

        // Update config
        updatedConfiguration(updatedActive);
      };

      // Triggerred when update "Error bands" switch
      updateErrorBands();
    }, [data.displayErrorBand]);

    const updateTypeOfPlot = async (wantedType: PlotType) => {
      setPlotTypeMenuOpened(false);
      setForcePlotTypeMenuOpened(false);
      setPlotMode(wantedType);
      // Update plot type on that grid only, keeping every other grid's
      // identity - and without deep-copying their data.
      const updatedDataPlot: DataGridPlot[] = active.dataPlot.map((dataPlot) =>
        dataPlot.i === data.i
          ? { ...dataPlot, selectedPlotMode: wantedType }
          : dataPlot,
      );

      const updatedActive: Configuration = {
        ...active,
        dataPlot: updatedDataPlot,
      };
      updatedConfiguration(updatedActive);
    };

    return (
      <div ref={containerRef} className={classes.containerButton}>
        <Group justify="space-between" h={'100%'}>
          {is3DView || !data.coordinates.length || shouldDisplayMetadata ? (
            <Tabs
              value={active3DTab}
              onChange={(value) => setActive3DTab(value)}
            >
              <ScrollArea
                type="hover"
                scrollHideDelay={0} // keep visible scrollbar only during hover
                scrollbarSize={6}
                offsetScrollbars
                maw={
                  containerWidth
                    ? !data.coordinates.length || shouldDisplayMetadata
                      ? containerWidth - 110
                      : containerWidth - 280
                    : '100%'
                }
              >
                <Tabs.List
                  style={{
                    flexWrap: 'nowrap',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {data.plot.map((plot, index) => (
                    <Tabs.Tab key={`3D_tab_${index}`} value={index.toString()}>
                      {plot.name}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
              </ScrollArea>
            </Tabs>
          ) : (
            <div></div>
          )}

          {hovered ||
          data.isEditing ||
          plotTypeMenuOpened ||
          forcePlotTypeMenuOpened ? (
            <Group pos="absolute" right={'1rem'} top={5}>
              {!is3DView && data.isEditing && !shouldDisplayMetadata && (
                <Switch
                  label="Error bands"
                  checked={data.displayErrorBand}
                  onChange={(event) =>
                    updateDisplayErrorBands(event.currentTarget.checked)
                  }
                />
              )}

              {data.coordinates.length >= 2 && !shouldDisplayMetadata && (
                <Menu
                  opened={plotTypeMenuOpened || forcePlotTypeMenuOpened}
                  onChange={setPlotTypeMenuOpened}
                  shadow="md"
                  width={180}
                  trigger="click-hover"
                >
                  <Menu.Target>
                    <Tooltip label="Select plot mode">
                      <ActionIcon
                        onClick={() => setForcePlotTypeMenuOpened((o) => !o)}
                        variant="filled"
                        aria-label="Select plot mode"
                        className={classes.actionButton}
                      >
                        {modes.find((m) => m.value === plotMode)?.icon || (
                          <Text fw="bold">{plotMode}</Text>
                        )}
                      </ActionIcon>
                    </Tooltip>
                  </Menu.Target>

                  <Menu.Dropdown>
                    {modes.map((mode) => (
                      <Menu.Item
                        key={mode.value}
                        onClick={() => updateTypeOfPlot(mode.value)}
                        leftSection={mode.icon}
                        rightSection={
                          plotMode === mode.value ? (
                            <IconCheck size={14} />
                          ) : null
                        }
                      >
                        {mode.value}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              )}

              {data.coordinates.length && !shouldDisplayMetadata && (
                <Tooltip label="Inspect metadatas information">
                  <ActionIcon
                    variant="filled"
                    aria-label="Metadatas"
                    onClick={() => handleInspectMetadata(data.i)}
                    className={classes.actionButton}
                    // Disable when no names in plots (case when add template with bad URIs in first URIs selection)
                    disabled={
                      !(data.plot.filter((plot) => plot.name)?.length > 0)
                    }
                  >
                    <IconBrandDatabricks
                      style={{ width: '70%', height: '70%' }}
                      stroke={1.5}
                    />
                  </ActionIcon>
                </Tooltip>
              )}

              {data.coordinates.length && !shouldDisplayMetadata && (
                // Show data manipulation button only if plottable
                <Tooltip label="Data manipulation">
                  <ActionIcon
                    variant="filled"
                    aria-label="Data manipulation"
                    data-testid="data-customization-access-button"
                    onClick={() => handleCustomization(data.i, 'data')}
                    className={classes.actionButton}
                  >
                    <IconDatabaseEdit
                      style={{ width: '70%', height: '70%' }}
                      stroke={1.5}
                    />
                  </ActionIcon>
                </Tooltip>
              )}

              {data.coordinates.length && !shouldDisplayMetadata && (
                // Show visual customization button only if plottable
                <Tooltip label="Visual customization">
                  <ActionIcon
                    variant="filled"
                    aria-label="Visual customization"
                    data-testid="visual-customization-access-button"
                    onClick={() => handleCustomization(data.i, 'visual')}
                    className={classes.actionButton}
                  >
                    <IconEyeEdit
                      style={{ width: '70%', height: '70%' }}
                      stroke={1.5}
                    />
                  </ActionIcon>
                </Tooltip>
              )}

              <Tooltip
                label={data.isEditing ? 'Save the edition' : 'Edit the grid'}
              >
                <ActionIcon
                  variant="filled"
                  aria-label="Editing"
                  data-testid={`grid-edit-toggle-${data.i}`}
                  onClick={() => handleEditGrid(data.i)}
                  className={classes.actionButton}
                  color={data.isEditing ? 'yellow' : 'green'}
                >
                  {data.isEditing ? (
                    <IconCheck
                      style={{ width: '70%', height: '70%' }}
                      stroke={1.5}
                    />
                  ) : (
                    <IconEdit
                      style={{ width: '70%', height: '70%' }}
                      stroke={1.5}
                    />
                  )}
                </ActionIcon>
              </Tooltip>

              {handleDeleteGrid && (
                <Tooltip label="Delete the grid">
                  <ActionIcon
                    variant="filled"
                    aria-label="Delete"
                    onClick={() => handleDeleteGrid(data.i)}
                    className={classes.actionButton}
                    color="red"
                  >
                    <IconTrash
                      style={{ width: '70%', height: '70%' }}
                      stroke={1.5}
                    />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          ) : (
            <div />
          )}
        </Group>
      </div>
    );
  },
);
