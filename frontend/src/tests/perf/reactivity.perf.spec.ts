import { Key } from 'selenium-webdriver';
import { expect } from 'chai';
import {
  startApp,
  getDriver,
  stopApp,
  waitForApi,
  getTestState,
  setTestState,
} from '../setup';
import {
  addUriAndAwaitSelection,
  ensureCssElementIsDisplayed,
  findCssElementAndClickIt,
  getDatasetPath,
  resetAppState,
  waitForElementToDisappear,
  waitForValue,
  writeTextInCssElement,
} from '../utils';
import {
  assertPerfInstalled,
  dataRequests,
  measure,
  reportMeasurements,
  totalRedraws,
} from './perfHelpers';
import '../../config/bridge';

/**
 * Reactivity benchmark.
 *
 * Deliberately NOT part of `npm run test:e2e`, whose glob `src/tests/*.spec.ts`
 * is not recursive. Run it with `npm run test:perf` against an app started by
 * `npm run start:e2e`.
 *
 * It asserts on *counts* — backend requests and Plotly redraws — never on
 * wall-clock times: counts are deterministic, timings on a shared runner are
 * not. Timings are still recorded and printed for information.
 *
 * Canvas: the one named in the issue — a 2-D
 * `equilibrium/time_slice/profiles_2d/psi` heatmap plus a 1-D grid. The
 * disruption dataset is used because it carries several time slices
 * (psi is [3, 1, 120, 70]), so the coordinate slider is actually usable; the
 * scenario dataset has a single slice and renders every slider disabled.
 */

const DATASET = 'iter_disruption_113112_1.nc';
const EQUILIBRIUM = 'equilibrium:0';
const TIME_SLICE = `${EQUILIBRIUM}/time_slice[:]`;
const PROFILES_2D = `${TIME_SLICE}/profiles_2d[:]`;
const GLOBAL_QUANTITIES = 'disruption:0/global_quantities';

/** Retry budget for steps that wait on a backend round trip. */
const SLOW = { retries: 200, delay: 300 };

let heatmapGridId = '';
let lineGridId = '';

describe('Reactivity benchmark', function () {
  this.timeout(900000);

  before(async () => {
    await startApp();
    await waitForApi();
    await assertPerfInstalled();
    await resetAppState();
    await buildCanvas();
  });

  after(async () => {
    reportMeasurements();
    await stopApp();
  });

  /** Builds the two-panel benchmark canvas from a single data entry. */
  async function buildCanvas() {
    await findCssElementAndClickIt('header-add-configuration');
    await ensureCssElementIsDisplayed('config-create-modal');
    await writeTextInCssElement('config-create-name-input', 'Perf', true);
    await findCssElementAndClickIt('config-create-submit-button');
    await waitForValue(
      'configuration created',
      async () => (await getTestState()).configurations.length,
      1,
    );

    const dataPath = await getDatasetPath(DATASET);
    const uriModal = await ensureCssElementIsDisplayed(
      'config-uri-selection-modal',
    );
    await writeTextInCssElement(
      'config-uri-selection-modal-uri-text-input',
      dataPath,
      true,
    );
    await addUriAndAwaitSelection(dataPath);
    await findCssElementAndClickIt(
      'config-uri-selection-modal-validate-button',
      100,
      300,
    );
    await waitForElementToDisappear(uriModal, 60000);

    await ensureCssElementIsDisplayed(`uriAccordion-${dataPath}`, 600, 100);
    await findCssElementAndClickIt(`uriAccordion-${dataPath}`, 200, 100);
    await findCssElementAndClickIt(
      `folder-${dataPath}#${EQUILIBRIUM}/`,
      200,
      100,
    );
    await findCssElementAndClickIt(
      `folder-${dataPath}#${TIME_SLICE}/`,
      200,
      100,
    );
    await findCssElementAndClickIt(
      `folder-${dataPath}#${PROFILES_2D}/`,
      200,
      100,
    );

    // Grid 1: the 2-D psi heatmap, with a usable time slider.
    await findCssElementAndClickIt(`checkbox-${dataPath}#${PROFILES_2D}/psi`);
    await waitForValue(
      '2D grid created',
      async () => (await getTestState()).active.dataPlot.length,
      1,
      undefined,
      SLOW.retries,
      SLOW.delay,
    );
    heatmapGridId = (await getTestState()).active.dataPlot[0].i;
    await leaveEditMode(0);

    // Grid 2: two 1-D traces over time.
    await findCssElementAndClickIt(
      `folder-${dataPath}#disruption:0/`,
      200,
      100,
    );
    await findCssElementAndClickIt(
      `folder-${dataPath}#${GLOBAL_QUANTITIES}/`,
      200,
      100,
    );
    await addTrace(dataPath, `${GLOBAL_QUANTITIES}/power_ohm`, 1, 2);
    lineGridId = (await getTestState()).active.dataPlot[1].i;
    await addTrace(dataPath, `${GLOBAL_QUANTITIES}/power_ohm_halo`, 2, 2);
    await leaveEditMode(1);
  }

  /** Checks a leaf and waits for the resulting grid/trace to settle. */
  async function addTrace(
    dataPath: string,
    leaf: string,
    expectedTraces: number,
    expectedGrids: number,
  ) {
    await findCssElementAndClickIt(`checkbox-${dataPath}#${leaf}`, 200, 100);
    await waitForValue(
      `grid count after ${leaf}`,
      async () => (await getTestState()).active.dataPlot.length,
      expectedGrids,
      undefined,
      SLOW.retries,
      SLOW.delay,
    );
    await waitForValue(
      `trace count after ${leaf}`,
      async () => (await getTestState()).active.dataPlot[1].plot.length,
      expectedTraces,
      undefined,
      SLOW.retries,
      SLOW.delay,
    );
  }

  /** Takes a grid out of edit mode so the next leaf opens a new grid. */
  async function leaveEditMode(index: number) {
    const gridId = (await getTestState()).active.dataPlot[index].i;
    await findCssElementAndClickIt(`grid-edit-toggle-${gridId}`, 200, 100);
    await waitForValue(
      `grid ${index} left edit mode`,
      async () => (await getTestState()).active.dataPlot[index].isEditing,
      false,
      undefined,
      SLOW.retries,
      SLOW.delay,
    );
  }

  it('a pure UI toggle costs no backend request and spares the other panel', async () => {
    // Entering edit mode flips one boolean. No data changes at all.
    const snapshot = await measure('toggle edit mode (UI flag)', async () => {
      await findCssElementAndClickIt(`grid-edit-toggle-${lineGridId}`);
      await waitForValue(
        'grid entered edit mode',
        async () =>
          (await getTestState()).active.dataPlot.find(
            (grid) => grid.i === lineGridId,
          )?.isEditing,
        true,
        undefined,
        SLOW.retries,
        SLOW.delay,
      );
    });

    expect(
      dataRequests(snapshot),
      `a UI-only toggle must not query the backend, got ${JSON.stringify(
        dataRequests(snapshot),
      )}`,
    ).to.have.length(0);

    expect(
      snapshot.redraws[heatmapGridId] ?? 0,
      'toggling one panel must not redraw the untouched heatmap panel',
    ).to.equal(0);

    await findCssElementAndClickIt(`grid-edit-toggle-${lineGridId}`);
  });

  it('stepping a coordinate slider queries nothing and spares other panels', async () => {
    // Coordinate sliders are only operable while their grid is being edited
    // (Heatmap2D.tsx passes `disabled={!itemDataGrid.isEditing}`), so enter
    // edit mode first — outside the measured block, so its cost is not counted.
    await setGridEditing(heatmapGridId, true);
    const slider = await findEnabledSlider();

    const snapshot = await measure('coordinate slider, 2 steps', async () => {
      await slider.click();
      await slider.sendKeys(Key.ARROW_UP);
      await getDriver().sleep(400);
      await slider.sendKeys(Key.ARROW_UP);
    });

    expect(
      dataRequests(snapshot),
      `sliders slice already-loaded data and must not refetch, got ${JSON.stringify(
        dataRequests(snapshot),
      )}`,
    ).to.have.length(0);

    expect(
      snapshot.redraws[lineGridId] ?? 0,
      'stepping the heatmap slider must not redraw the 1-D panel',
    ).to.equal(0);

    await setGridEditing(heatmapGridId, false);
  });

  it('revisiting a metadata tab does not re-download the payload', async () => {
    await measure('metadata panel, first open', async () => {
      await setMetadataPanel(lineGridId);
      await waitForValue(
        'metadata panel open',
        async () => Boolean((await getTestState()).active.metadataGridLayout),
        true,
        undefined,
        SLOW.retries,
        SLOW.delay,
      );
    });

    const snapshot = await measure('metadata panel, revisit', async () => {
      await setMetadataPanel(null);
      await waitForValue(
        'metadata panel closed',
        async () => Boolean((await getTestState()).active.metadataGridLayout),
        false,
        undefined,
        SLOW.retries,
        SLOW.delay,
      );
      await setMetadataPanel(lineGridId);
      await waitForValue(
        'metadata panel reopened',
        async () => Boolean((await getTestState()).active.metadataGridLayout),
        true,
        undefined,
        SLOW.retries,
        SLOW.delay,
      );
    });

    const plotDataCalls = snapshot.fetchUrls.filter((url) =>
      url.includes('/data/plot_data'),
    );
    expect(
      plotDataCalls,
      `reopening the same metadata tab must not re-download plot_data, got ${plotDataCalls.length}`,
    ).to.have.length(0);

    await setMetadataPanel(null);
  });

  it('is quiet at rest', async () => {
    const snapshot = await measure('idle (no interaction)', async () => {
      await getDriver().sleep(1500);
    });
    expect(totalRedraws(snapshot), 'an idle canvas must not redraw').to.equal(
      0,
    );
    expect(
      dataRequests(snapshot),
      'an idle canvas must not query the backend',
    ).to.have.length(0);
  });
});

/**
 * Returns the first coordinate slider that is actually operable. Sliders over a
 * single-valued coordinate render disabled, and driving one would measure
 * nothing.
 */
async function findEnabledSlider() {
  const sliders = await getDriver().findElements({
    css: '[data-testid^="slider-"]',
  });
  for (const slider of sliders) {
    const max = Number(await slider.getAttribute('aria-valuemax'));
    if (Number.isFinite(max) && max > 0) return slider;
  }
  throw new Error(
    'no operable coordinate slider on the benchmark canvas: every slider ' +
      'covers a single-valued coordinate',
  );
}

/** Puts one grid in or out of edit mode through the e2e state bridge. */
async function setGridEditing(gridId: string, editing: boolean) {
  const state = await getTestState();
  await setTestState({
    configurations: state.configurations,
    active: {
      ...state.active,
      dataPlot: state.active.dataPlot.map((grid) =>
        grid.i === gridId
          ? { ...grid, isEditing: editing, static: editing }
          : { ...grid, isEditing: false, static: false },
      ),
    },
  });
  await waitForValue(
    `grid ${gridId} editing=${editing}`,
    async () =>
      (await getTestState()).active.dataPlot.find((g) => g.i === gridId)
        ?.isEditing ?? false,
    editing,
    undefined,
    SLOW.retries,
    SLOW.delay,
  );
}

/**
 * Opens or closes the metadata panel through the e2e state bridge. What is
 * measured is the panel's data fetching, not the button that opens it.
 */
async function setMetadataPanel(gridId: string | null) {
  const state = await getTestState();
  await setTestState({
    configurations: state.configurations,
    active: { ...state.active, metadataGridLayout: gridId },
  });
}
