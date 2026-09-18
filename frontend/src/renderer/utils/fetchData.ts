import { showNotification } from '@mantine/notifications';
import {
  ArraySummaryResponse,
  AxisData,
  DataIdsResponse,
  DataManipulationListResponse,
  DownsamplingMethodsResponse,
  FieldValueResponse,
  FormDbEntries,
  GeometryInfosResponse,
  InfoVersionResponse,
  NodeInfoResponse,
  DataOperation,
  NodeInfoTypeEnum,
  OperationKind,
  PlotDataResponse,
  SearchNodeResponse,
  SignalOperation,
  SmoothingParams,
  UnaryOperation,
  URDataEntriesResponse,
  URIExistsResponse,
  URIFromPathResponse,
} from '../types';
import { getTensorizedMatrix, transformComplexData } from './plot';
import { replaceNullsWithNaN } from './functions';
import { normalizeIndices } from './uri';
import { OptionWithTooltip } from '../types/components/select';
import { cachedRequest } from './requestCache';

/**
 * Retrieves the API configuration.
 */
let configPromise: ReturnType<typeof window.api.getConfig> | null = null;

const getConfig = async () => {
  try {
    // The config is fixed for the lifetime of the session, so resolve it once
    // instead of crossing the Electron IPC boundary on every request.
    configPromise ??= window.api.getConfig();
    const config = await configPromise;
    if (!config) throw new Error('Failed to load configuration');
    return config;
  } catch (error) {
    configPromise = null; // allow a retry
    console.error('Error fetching config:', error);
    throw error;
  }
};

/**
 * Error already reported to the user by handleError.
 */
type NotifiedError = Error & { notified?: boolean };

/**
 * Tells whether the user has already been notified of this error, so that
 * callers can skip their own generic notification.
 */
/** An `Error` carrying the HTTP status of the response that produced it. */
type HttpError = Error & { status?: number };

export const isNotifiedError = (error: unknown): boolean =>
  Boolean((error as NotifiedError)?.notified);

/**
 * Handles API errors.
 * You can also report the error to a monitoring service here (e.g., Sentry).
 */
const handleError = (error: unknown, context: string, code?: number) => {
  if (error instanceof Error) {
    if (
      // Occurs when having at least one plot with error bands and adding a plot without upper / lower in tree
      (code === 404 &&
        error.toString().includes('has no attribute') &&
        (error.toString().includes('_error_upper') ||
          error.toString().includes('_error_lower'))) || // Occurs when calling automatically error bands without data
      (code === 464 &&
        error.toString().includes('No data for') &&
        (error.toString().includes('_error_upper') ||
          error.toString().includes('_error_lower')))
    ) {
      // Prevent from showing notification when no error band founded
      throw error;
    }

    // Notify the user in case of an error including an error message if it is not a 500 error.
    // Only once per error object: concurrent callers that share one in-flight
    // request also share its rejection, and the user must not be told twice
    // about a single failure.
    if (!isNotifiedError(error)) {
      showNotification({
        title: !code ? 'Unable to contact the server' : `Error ${code}`,
        message:
          !code || (code >= 400 && code < 500)
            ? error.message
            : 'Internal error',
        color: 'red',
      });
      // Flag the error so that callers do not stack a second, generic
      // notification on top of the detailed message coming from the server.
      (error as NotifiedError).notified = true;
    }
  }
  console.error(`Error in ${context}:`, error);
  throw error;
};

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = 2000,
) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Generic GET request to the API.
 */
const fetchFromApi = async <T>(
  endpoint: string,
  timeout?: number,
  cacheable = true,
): Promise<T> => {
  let responseStatus: number;
  try {
    const config = await getConfig();
    const url = `${config.API_URL}${endpoint}`;

    const fetchFn = async () => {
      if (timeout) {
        return await fetchWithTimeout(
          url,
          {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
          },
          timeout,
        );
      } else {
        return await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
      }
    };
    // The cache stores the body text and each caller parses its own copy: the
    // parsed graph is mutated in place downstream, so it must never be shared.
    const body = await cachedRequest(
      url,
      async () => {
        const response = await fetchFn();

        if (!response.ok) {
          if (response?.status) {
            responseStatus = response.status;
          }
          const errorData = await response.json();
          const error: HttpError = new Error(
            errorData.message || errorData.detail || 'Failed to fetch data',
          );
          // Carry the status on the error itself. A caller that joined an
          // in-flight request never runs this function, so a status kept only
          // in the closure above would reach it as undefined - and the rules
          // that suppress expected 404/464 error-band failures would not fire.
          error.status = response.status;
          throw error;
        }

        return response.text();
      },
      cacheable,
    );

    return JSON.parse(body) as T;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`Timeout after ${timeout}ms: fetchFromApi(${endpoint}).`);
      throw error;
    } else {
      handleError(
        error,
        `fetchFromApi(${endpoint})`,
        (error as HttpError)?.status ?? responseStatus,
      );
    }
  }
};

// ---- Specific API calls ----

/**
 * Fetches information about a given node.
 */
export const fetchNodeInfos = async (
  nodeUri: string,
  showErrorBars: boolean,
) => {
  const nodeInfos = await fetchFromApi<NodeInfoResponse>(
    `/ids_info/node_info?uri=${encodeURIComponent(nodeUri)}&show_error_bars=${showErrorBars}`,
  );
  nodeInfos.children = nodeInfos.children.filter((c) => c.has_data !== false);
  return nodeInfos;
};

/**
 * Finds matching node paths based on a search value.
 */
export const fetchFindPaths = async (
  uri: string,
  value: string,
  showErrorBars: boolean,
) => {
  const searchedNodes = await fetchFromApi<SearchNodeResponse>(
    `/ids_info/find_paths?uri=${encodeURIComponent(uri)}&searched_node=${encodeURIComponent(value)}&show_error_bars=${showErrorBars}`,
  );
  searchedNodes.paths = searchedNodes.paths.filter((c) => c.has_data !== false);
  return searchedNodes;
};

/**
 * Retrieves downsampling methods.
 */
export const fetchDownsamplingMethods = async () => {
  return fetchFromApi<DownsamplingMethodsResponse>(
    `/info/downsampling_methods`,
  );
};

/**
 * Retrieves data manipulation methods.
 */
export const fetchDataManipulationMethods = async () => {
  return fetchFromApi<DataManipulationListResponse>(
    `/info/data_manipulation_methods`,
  );
};

export const getInterpolationMethods = async (): Promise<
  OptionWithTooltip[]
> => {
  const methodsRes = await fetchDataManipulationMethods();
  const interpolation = methodsRes.data_manipulation_methods.find(
    (m) => m.name === 'Data interpolation',
  );
  const param = interpolation?.method_parameters.find(
    (p) => p.name === 'interpolation_method',
  );
  return (
    param?.possible_values?.map((item) => ({
      value: item.value,
      tooltip: item.description,
    })) ?? []
  );
};

export const getSmoothingMethods = async (): Promise<OptionWithTooltip[]> => {
  const methodsRes = await fetchDataManipulationMethods();
  const smoothing = methodsRes.data_manipulation_methods.find(
    (m) => m.name === 'Data smoothing/denoising',
  );
  const param = smoothing?.method_parameters.find(
    (p) => p.name === 'smoothing_method',
  );
  return (
    param?.possible_values?.map((item) => ({
      value: item.value,
      tooltip: item.description,
    })) ?? []
  );
};

/**
 * Read the operation types exposed by a data manipulation method.
 * Both "Simple Data Operations" and "Signal Data Operations" expose a parameter
 * named "operations", so the method name is the only discriminator.
 */
const getOperationTypeOptions = async (
  methodName: string,
): Promise<{ value: string; label: string }[]> => {
  const methodsRes = await fetchDataManipulationMethods();
  const operations = methodsRes.data_manipulation_methods.find(
    (m) => m.name === methodName,
  );
  const operationsParam = operations?.method_parameters.find(
    (p) => p.name === 'operations',
  );
  const typeField = operationsParam?.fields?.find(
    (f) => f.name === 'operation_type',
  );
  // Display the human-readable description as the label while keeping the raw
  // operation value (e.g. "add") for the fetchDataPlot request.
  return (
    typeField?.possible_values?.map((item) => ({
      value: item.value,
      label: item.description,
    })) ?? []
  );
};

/**
 * Operation types available for a scalar (unary) operation.
 */
export const getOperationMethods = async (): Promise<
  { value: string; label: string }[]
> => getOperationTypeOptions('Simple Data Operations');

/**
 * Operation types available for a signal (binary) operation. The back-end
 * exposes fewer types here than for scalar operations (no pow / root).
 */
export const getSignalOperationMethods = async (): Promise<
  { value: string; label: string }[]
> => getOperationTypeOptions('Signal Data Operations');

// Smoothing methods
export const GAUSSIAN_FILTER = 'gaussian_filter';
export const SAVGOL_FILTER = 'savitzky-golay_filter';

// Default smoothing parameters, reused for input display and request building
export const DEFAULT_GAUSSIAN_SMOOTHING_SIGMA = 1;
// Sigma is expressed in samples. A null or negative sigma leaves the data
// untouched, so the gaussian filter would silently do nothing: keep the input
// at or above this floor
export const MIN_GAUSSIAN_SMOOTHING_SIGMA = 0.1;
export const DEFAULT_SAVGOL_WINDOW_LENGTH = 5;
export const DEFAULT_SAVGOL_POLYORDER = 2;
export const DEFAULT_SAVGOL_DERIV = 0;
export const DEFAULT_SAVGOL_DELTA = 1.0;
export const DEFAULT_SAVGOL_MODE = 'interp';
export const DEFAULT_SAVGOL_CVAL = 0.0;

/**
 * Build a clean, complete SmoothingParams for the selected method (unedited fields
 * filled with their defaults), or undefined when no method is set.
 */
export const buildSmoothingRequest = (
  smoothing?: SmoothingParams,
): SmoothingParams | undefined => {
  if (smoothing?.smoothing_method === GAUSSIAN_FILTER) {
    return {
      smoothing_method: GAUSSIAN_FILTER,
      gaussian_smoothing_sigma:
        smoothing.gaussian_smoothing_sigma ?? DEFAULT_GAUSSIAN_SMOOTHING_SIGMA,
    };
  }
  if (smoothing?.smoothing_method === SAVGOL_FILTER) {
    return {
      smoothing_method: SAVGOL_FILTER,
      savgol_smoothing_window_length:
        smoothing.savgol_smoothing_window_length ??
        DEFAULT_SAVGOL_WINDOW_LENGTH,
      savgol_smoothing_polyorder:
        smoothing.savgol_smoothing_polyorder ?? DEFAULT_SAVGOL_POLYORDER,
      savgol_smoothing_deriv:
        smoothing.savgol_smoothing_deriv ?? DEFAULT_SAVGOL_DERIV,
      savgol_smoothing_delta:
        smoothing.savgol_smoothing_delta ?? DEFAULT_SAVGOL_DELTA,
      savgol_smoothing_mode:
        smoothing.savgol_smoothing_mode ?? DEFAULT_SAVGOL_MODE,
      savgol_smoothing_cval:
        smoothing.savgol_smoothing_cval ?? DEFAULT_SAVGOL_CVAL,
    };
  }
  return undefined;
};

/**
 * Tell apart the two kinds of rows stored in `plot.operations`. Rows saved
 * before the "Data operations" panel have no `kind` and are scalar operations.
 */
export const isSignalOperation = (
  operation: DataOperation,
): operation is SignalOperation => operation.kind === 'signal';

export const getOperationKind = (operation: DataOperation): OperationKind =>
  operation.kind ?? 'unary';

/**
 * Build the ordered "type:value" list from scalar operation rows
 * (dropping rows without a type or without a usable number).
 */
export const formatOperations = (operations?: DataOperation[]): string[] =>
  (operations ?? [])
    .filter(
      (operation): operation is UnaryOperation => !isSignalOperation(operation),
    )
    .filter((operation) => operation.type && Number.isFinite(operation.value))
    .map((operation) => `${operation.type}:${operation.value}`);

/**
 * Build the ordered "type:uri" list from signal operation rows (dropping
 * incomplete rows). URIs are normalized so that they match the entries sent in
 * `interpolate_over`: the back-end reuses an already interpolated signal only
 * when both strings are identical.
 */
export const formatSignalOperations = (
  operations?: DataOperation[],
): string[] =>
  (operations ?? [])
    .filter(isSignalOperation)
    .filter((operation) => operation.type && operation.value)
    .map(
      (operation) => `${operation.type}:${normalizeIndices(operation.value)}`,
    );

/**
 * Retrieves plot data for a given URI.
 */
export const fetchDataPlot = async (
  uri: string,
  downsamplingMethod?: string,
  downsamplingSize?: number,
  type?: NodeInfoTypeEnum,
  interpolateOver?: string[],
  interpolationMethod?: string,
  smoothing?: SmoothingParams,
  operations?: string[],
  signalOperations?: string[],
) => {
  const downsampled_size = downsamplingSize || 1000;
  let response: PlotDataResponse;
  let firstDownsampledMethod: string;

  // Provide interpolate_over param if needed
  let encodedInterpolateOver: string = '';
  if (interpolateOver) {
    for (const uriToInterpolate of interpolateOver) {
      encodedInterpolateOver += `&interpolate_over=${encodeURIComponent(uriToInterpolate)}`;
    }
    if (!interpolationMethod) {
      // Use first interpolation method by default to fetch data
      const interpolationMethods = await getInterpolationMethods();
      interpolationMethod = interpolationMethods[0]?.value;
      if (!interpolationMethod) {
        showNotification({
          title: 'No interpolation methods',
          message:
            'No interpolation methods returned by /info/data_manipulation_methods',
          color: 'red',
        });
        return;
      }
    }
    encodedInterpolateOver += `&interpolation_method=${encodeURIComponent(interpolationMethod)}`;
  }

  // Provide smoothing params if needed
  let encodedSmoothing: string = '';
  if (smoothing?.smoothing_method) {
    for (const [key, value] of Object.entries(smoothing)) {
      if (value != null) {
        encodedSmoothing += `&${key}=${encodeURIComponent(value)}`;
      }
    }
  }

  // Provide operations param if needed
  let encodedOperations: string = '';
  if (operations) {
    for (const operation of operations) {
      encodedOperations += `&operations=${encodeURIComponent(operation)}`;
    }
  }

  // Provide signal_operations param if needed
  let encodedSignalOperations: string = '';
  if (signalOperations) {
    for (const signalOperation of signalOperations) {
      encodedSignalOperations += `&signal_operations=${encodeURIComponent(signalOperation)}`;
    }
  }

  if (downsamplingMethod) {
    // Get downsampled data plot
    response = await fetchFromApi<PlotDataResponse>(
      `/data/plot_data?uri=${encodeURIComponent(uri)}&downsampling_method=${encodeURIComponent(downsamplingMethod)}&downsampled_size=${encodeURIComponent(downsampled_size)}${encodedInterpolateOver}${encodedSmoothing}${encodedOperations}${encodedSignalOperations}`,
    );
  } else {
    try {
      // Try to fetch data without downsampling in according timeout
      response = await fetchFromApi<PlotDataResponse>(
        `/data/plot_data?uri=${encodeURIComponent(uri)}${encodedInterpolateOver}${encodedSmoothing}${encodedOperations}${encodedSignalOperations}`,
        5000,
      );
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'SyntaxError') {
        // "SyntaxError" can be triggered when too heavy (eof error)
        // Use first downsampling method by default to fetch data
        const downsampledMethods = await fetchDownsamplingMethods();
        if (
          !downsampledMethods.downsampling_methods.length ||
          downsampledMethods.downsampling_methods.length < 2
        ) {
          showNotification({
            title: 'No downsampling methods',
            message:
              'No downsampling methods returned by /info/downsampling_methods',
            color: 'red',
          });
          return;
        }
        firstDownsampledMethod =
          downsampledMethods?.downsampling_methods.find(
            (meth) => meth.name === 'M4',
          )?.name || downsampledMethods?.downsampling_methods.slice(0)[1].name;
        response = await fetchFromApi<PlotDataResponse>(
          `/data/plot_data?uri=${encodeURIComponent(uri)}&downsampling_method=${encodeURIComponent(firstDownsampledMethod)}&downsampled_size=${encodeURIComponent(downsampled_size)}${encodedInterpolateOver}${encodedSmoothing}${encodedOperations}${encodedSignalOperations}`,
        );
      } else {
        // Any other error (e.g. a 466 raised when a signal operation cannot be
        // applied) has already been notified by handleError: propagate it
        // instead of falling through with an undefined response.
        throw error;
      }
    }
  }

  // Rule to rename data when "value" or "data":
  if (response.data.name == 'data' || response.data.name == 'value') {
    const targetStringList = response.data.path.split('/');
    response.data.name =
      targetStringList.length >= 2
        ? `${targetStringList.at(-2)}`
        : response.data.name;
  }

  // Force all targets to ends with '[:]'
  for (const coord of response.data.coordinates) {
    if (!coord.target.endsWith(']')) {
      coord.target = coord.target += '[:]';
    }
  }

  // Return used methods
  response.data.downsampled_method =
    firstDownsampledMethod || downsamplingMethod;
  response.data.interpolated_method = interpolationMethod;

  if (response.data.shape === 'irregular') {
    // Alert when getting irregular shape
    showNotification({
      title: 'Warning',
      message: 'Data are incomplete.',
      color: 'yellow',
    });

    for (const coord of response.data.coordinates) {
      // Fill incomplete coordinates with NaN to be a matrix format
      const tensorizedCoordinate = await getTensorizedMatrix(coord.value);
      coord.value = (await tensorizedCoordinate.array()) as AxisData;
      coord.shape = tensorizedCoordinate.shape;
      coord.downsampled_shape = tensorizedCoordinate.shape;
    }
    // Fill incomplete data with NaN to be a matrix format
    const dataTensorized = await getTensorizedMatrix(response.data.value);
    response.data.value = (await dataTensorized.array()) as AxisData;
    response.data.shape = dataTensorized.shape;
    response.data.downsampled_shape = dataTensorized.shape;
  }

  if (type === 'CPX') {
    // Transform complex data
    const updatedData = transformComplexData(response.data.value) as AxisData;
    response.data.value = updatedData;
  }

  response.data.value = replaceNullsWithNaN(response.data.value);
  return response;
};

/**
 * Retrieves field values for a given URI.
 */
export const fetchFieldValue = async (
  uri: string,
  downsamplingMethod?: string,
  downsamplingSize?: number,
  type?: NodeInfoTypeEnum,
) => {
  const downsampled_size = downsamplingSize || 1000;
  let response: FieldValueResponse;
  if (downsamplingMethod) {
    response = await fetchFromApi<FieldValueResponse>(
      `/data/field_value?uri=${encodeURIComponent(uri)}&downsampling_method=${encodeURIComponent(downsamplingMethod)}&downsampled_size=${encodeURIComponent(downsampled_size)}`,
    );
  } else {
    response = await fetchFromApi<FieldValueResponse>(
      `/data/field_value?uri=${encodeURIComponent(uri)}`,
    );
  }

  if (type === 'CPX') {
    // Transform complex data
    const updatedData = transformComplexData(response.value) as AxisData;
    response.value = updatedData;
  }
  response.value = replaceNullsWithNaN(response.value);
  return response;
};

/**
 * Lists all available IDS IDs for a given URI.
 */
export const fetchDataIds = async (uri: string) => {
  return fetchFromApi<DataIdsResponse>(
    `/data_entry/list_idses?uri=${encodeURIComponent(uri)}`,
  );
};

/**
 * Checks whether a specific URI exists.
 */
export const fetchURIFromPath = async (path: string) => {
  return fetchFromApi<URIFromPathResponse>(
    `/data_entry/uri_from_path?path=${encodeURIComponent(path)}`,
  );
};

/**
 * Checks whether a specific URI exists.
 */
export const fetchURIExists = async (uri: string) => {
  return fetchFromApi<URIExistsResponse>(
    `/data_entry/exists?uri=${encodeURIComponent(uri)}`,
  );
};

/**
 * Retrieves available entries for a user/database configuration.
 */
export const fetchDataEntries = async (
  dataEntriesParameters: FormDbEntries,
) => {
  return fetchFromApi<URDataEntriesResponse>(
    `/data_entry/available_entries?user=${dataEntriesParameters.user}&backend=${dataEntriesParameters.backend}&database=${dataEntriesParameters.database}&version=${dataEntriesParameters.version}`,
  );
};

/**
 * Retrieves plot data for a given URI.
 */
export const fetchArraySummary = async (uri: string) => {
  return fetchFromApi<ArraySummaryResponse>(
    `/ids_info/array_summary?uri=${encodeURIComponent(uri)}`,
  );
};

/**
 * Retrieves geometries to overlay for a given URI.
 */
export const fetchGeometryNodes = async (uri: string, labelUri: string) => {
  const geometries = await fetchFromApi<GeometryInfosResponse>(
    `/ids_info/geometry_overlay_nodes?uri=${encodeURIComponent(uri)}`,
  );
  for (const geometry of geometries.outline_nodes) {
    const splittedNode = geometry.geometry_node.split('#');
    geometry.geometry_node = labelUri + '#' + splittedNode[1] + '/';
  }
  return geometries.outline_nodes;
};

/**
 * Return backend version.
 */
export const fetchInfoVersion = async () => {
  // Never cached: the header polls this to show whether the backend is alive,
  // and a cached answer would freeze that indicator on its first value.
  return fetchFromApi<InfoVersionResponse>(`/info/version`, undefined, false);
};
