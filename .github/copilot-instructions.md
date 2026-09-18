# IBEX

IBEX (IMAS variaBles EXplorer) is a graphical tool for exploring IMAS structured
data (IDS), plotting 1D/2D quantities. It has two independent projects in one repo:

- `backend/` — Python/FastAPI service (`imas-ibex` package) that reads IDS data
  (via `imas`/`imas_core`) and exposes it over a REST API.
- `frontend/` — Electron + React (TypeScript) desktop app that consumes the
  backend API and renders the UI.

They are versioned/built together but have separate dependency managers,
linters, and test suites — always `cd` into the relevant directory first.

`.github/copilot-instructions.md` is a copy of this file's content; keep both in
sync when changing repo guidance.

## How the two halves connect

This is the part that isn't obvious from either directory alone:

- `frontend/src/main/backend-manager.ts` (Electron main process) spawns
  `run_ibex_service` (expected on `PATH`) on the first free port from 8000,
  then polls `GET /info/version` until the backend answers. Set
  `IBEX_BACKEND_URL` to point at an already-running/remote backend instead of
  spawning one.
- The resolved URL flows main → `frontend/src/config/config.ts` (`API_URL`,
  overridden by `IBEX_BACKEND_URL`) → renderer via the preload bridge
  (`window.api.getConfig()`).
- **All** renderer→backend HTTP calls live in
  `frontend/src/renderer/utils/fetchData.ts`; response types come from
  `src/renderer/types/`. Adding a backend endpoint means touching that file plus
  the matching type, not scattering `fetch` calls in components.
- Backend response/request shapes are Pydantic models in
  `backend/ibex/endpoints/schemas/` — they are the de-facto API contract;
  the TS types mirror them by hand, so change both together.

## Backend (`backend/`)

```bash
python -m venv venv
. venv/bin/activate
pip install -e .[test]        # editable install + pytest deps
```

`imas`/`idstools` come from PyPI via the `imas-idstools` dependency, so a plain
pip install is enough to run the suite (that's what CI does). On the ITER
cluster, `module load IMAS-Python IDStools` is what provides `imas_core` and the
MDSplus/AL-backed data access used against real data entries.

Run the service:
```bash
./bin/run_ibex_service [-p PORT] [--host HOST]   # Uvicorn; docs at http://127.0.0.1:<port>/docs
```
Default port is 0 (OS-assigned) — the Electron app always passes an explicit port.

Test (must use `python -m pytest`, not bare `pytest`, or FastAPI packages won't be found):
```bash
python -m pytest tests/                                  # full suite
python -m pytest tests/test_data_endpoints.py             # single file
python -m pytest tests/test_data_endpoints.py::test_name  # single test
python -m pytest -n auto --cov=ibex --cov-report=term-missing tests/  # like CI (backend-pytest.yml)
```
Tests drive the API through a FastAPI `TestClient` (`pytest.test_client` in
`tests/conftest.py`) against IDS fixtures written to temp HDF5 data entries by
session-scoped fixtures — no external dataset is needed.

Lint/format (ruff, config in `pyproject.toml`, line-length 120):
```bash
ruff check backend/
ruff format --check backend/
```
`.pre-commit-config.yaml` runs `ruff --fix` + `ruff-format` automatically if hooks are installed (`setup_git-hooks.sh`).

Docs: `make -C docs html` (needs `sphinx`, `sphinx-autosummary-accessors`, `sphinx_immaterial`).

Benchmarks: `./ci/run_benchmarks.sh` (uses `asv`, config `asv.conf.json` at repo root).

### Backend architecture

Request flow: `endpoints/*` → `core/ibex_service.py` → `data_source/*`.

- `ibex/main.py` — FastAPI app entrypoint; includes the four routers and
  registers global exception handlers (`ibex/exception_handlers.py`). The
  `imas.exception.ALException` handler is registered only if `imas` is importable.
- `ibex/endpoints/` — one module per route group (`data.py`, `data_entry.py`,
  `ids_info.py`, `info.py`) with request/response models in
  `ibex/endpoints/schemas/`. Endpoints stay thin: they validate and delegate to
  `ibex_service`.
- `ibex/core/ibex_service.py` — the only layer that knows about a concrete data
  source: module-level `data_source = IMASPythonSource()`. This is the swap
  point for an alternative backend.
- `ibex/data_source/data_source_interface.py` — abstract `DataSourceInterface`
  listing every method a data source must implement (`get_data`, `get_node_info`,
  `find_paths`, `list_db_entries`, `get_geometry_overlay_nodes`, ...).
  `imas_python_source.py` is the (currently only) implementation, backed by
  `imas`/`imas_core`/`idstools`. New data sources implement this interface
  rather than being bolted onto endpoint code.
- `ibex/core/` — source-agnostic helpers (`data_manipulation_methods.py`,
  `utils.py` e.g. `IMAS_URI`, `downsample_data`, `transform_2D_data`).
- Custom errors (`NodeNotFoundException`, `IdsNotFoundException`,
  `EntryNotFoundException`, `CannotGenerateUriException`, ...) live in
  `ibex/data_source/exception.py` and are translated to HTTP responses by the
  exception handlers — raise these instead of generic exceptions.

## Frontend (`frontend/`)

Requires Node.js >= 22.12 (`module load nodejs` on ITER cluster gives 22.17.1); CI uses Node 22. Electron 43, @electron/packager, @electron/rebuild and selenium-webdriver all refuse older Node.

```bash
npm install
npm run start        # Electron app in dev mode (hot reload, remote debugging on 9222)
npm run lint         # eslint . --max-warnings=0
npm run format       # prettier --write .
npm run package      # package app for distribution
npm run make         # build platform-specific binaries -> out/
```

E2E tests (Mocha + Selenium/Chromedriver against a running Electron+backend instance):
```bash
npm run start:e2e &                 # starts app with E2E_TEST=true, no watch
npx wait-on tcp:9222                # electron remote debugging port
npx wait-on http://127.0.0.1:8000/docs/   # backend must also be running (pip install -e ../backend)
npm run test:e2e                    # runs mocha against src/tests/*.spec.ts
```
Run a single e2e spec: `mocha -r ts-node/register src/tests/plot-ui.spec.ts`.

Reactivity benchmark (opt-in, not part of `test:e2e` — its glob is not recursive):
```bash
npm run start:e2e &                 # same app instance as the e2e suite
npm run test:perf                   # src/tests/perf/*.perf.spec.ts
```
It builds a canvas with a 2D `equilibrium/time_slice/profiles_2d/psi` heatmap
plus 1D traces and asserts on *counts* (backend requests, Plotly redraws), never
on wall-clock times. The renderer-side counters live in
`src/renderer/utils/perf.ts` and are installed only when `E2E_TEST=true`;
`src/tests/perf/BASELINE.md` records the measured numbers.

On a headless machine wrap the run in `xvfb-run --auto-servernum` as CI does.

`E2E_TEST=true` changes app behaviour in two places: `src/preload.ts` swaps the
filesystem/dialog IPC calls for stubs that record into `window.stubDataStorage`
(so specs assert on saved content without touching disk), and components read
`window.env.E2E_TEST` to disable Mantine transitions. Keep new modals/dialogs
consistent with that pattern or specs become flaky.

The suite attaches to the app that `start:e2e` runs (via its DevTools endpoint on
9222) and drives it with the chromedriver shipped by `electron-chromedriver` — so
`electron-chromedriver`'s major version must always match `electron`'s, or every spec
fails in its `before all` hook. `npm run test:e2e` alone, with no app running, fails
fast with a message saying so.

There is no unit test runner configured — only lint/format and e2e specs.

**Dependencies**: never run `npm audit fix --force` here — npm's "fix" for the Electron
Forge advisories is a downgrade to `@electron-forge/cli@6.4.2` and
`@electron-forge/plugin-webpack@0.0.2`, which breaks the build. Plain `npm audit fix` is
safe. `frontend/SECURITY-NOTES.md` records the advisories that have no upstream fix and
why they are accepted.

### Frontend architecture

- `src/main/` — Electron main process (`backend-manager.ts`, `ipc.ts`,
  `window.ts`); `src/preload.ts` — context-bridge exposing `window.api`;
  `src/config/` — runtime config loading; `src/renderer/` — the React app.
  The renderer has no Node access: anything touching the filesystem, dialogs or
  process state goes through an `ipcMain.handle` in `src/main/ipc.ts` plus an
  entry in `preload.ts`.
- `src/renderer/stores/` — Zustand store composed of "slices"
  (e.g. `configurationSlice.ts`) combined via `store.ts`; follow the existing
  slice pattern (`StateCreator<SliceState>` returning state + actions) when
  adding new global state.
- `src/renderer/components/` — reusable UI building blocks, one subfolder per
  component domain (`grid`, `plot`, `tree`, `matrixViewer`, `select`, `tabs`, ...).
- `src/renderer/pages/` + `src/renderer/router/` — route-level views and the
  `AppRouter` wiring them together.
- `src/renderer/types/` — shared TypeScript types imported across stores/components.
- `src/renderer/utils/` — `fetchData.ts` (API layer) plus pure helpers
  (`plot.ts`, `tree.ts`, `uri.ts`, `matrix.ts`, ...).
- `resources/config.json` (packaged) / `config.json.exemple` (template) —
  runtime app configuration (`API_URL`, `WEBPACK_HOST`, `WEBPACK_PORT`), not
  baked into the bundle.
- Styling via Mantine + `postcss-preset-mantine`; formatting is prettier-enforced
  (single quotes, semicolons, trailing commas, printWidth 80) — run `npm run format` before committing.

### UI conventions

- Every interaction must work with a single click; never make a feature depend
  on a double-click.
- Tree labels are deliberately non-selectable (issue #135) — don't reintroduce
  `userSelect: 'text'` there.

## Repo-wide conventions

- `install.sh` — packages the frontend and prepares a backend site-packages
  install for a combined deployment (used on SDCC/ITER cluster installs).
- `launch-dev.sh` — creates a dev venv, installs backend editable, and runs
  the frontend together; requires `module load IMAS-Python IDStools nodejs`.
- `launch.sh` — runs an already-installed IBEX (post `install.sh`) on SDCC.
- CI (GitHub Actions in `.github/workflows/`) runs backend pytest across
  Python 3.10–3.13, backend ruff lint/format, frontend eslint/prettier, frontend
  packaging, and frontend e2e tests (which download fixture datasets listed in
  `zenodo_datasets.txt` into `e2e_datasets/`) — mirror these when validating
  changes locally.
- Contribution flow (see `CONTRIBUTING.md`): fork, branch off `develop`, open
  PRs against `develop`; file/search issues before starting non-trivial work.
- The backend endpoint API is explicitly still unstable between releases
  (see README "Project Status") — changing a response shape is acceptable, but
  update `fetchData.ts` and `src/renderer/types/` in the same change.
