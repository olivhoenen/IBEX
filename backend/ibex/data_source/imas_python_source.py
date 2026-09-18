"""IMAS-Python data source - default for IBEX"""

from typing import Optional, Sequence, List

import imas  # type: ignore
import imas_core
import numpy as np  # type: ignore
import re  # type: ignore
from idstools.database import DBMaster  # type: ignore
from imas.ids_metadata import IDSMetadata  # type: ignore
from imas.ids_primitive import (
    IDSNumericArray,
    IDSString0D,
    IDSString1D,
    IDSComplex0D,
    IDSFloat0D,
    IDSInt0D,
    IDSPrimitive,
)  # type: ignore
from imas.ids_struct_array import IDSStructArray  # type: ignore
from imas.ids_structure import IDSStructure  # type: ignore
from imas.ids_data_type import IDSDataType  # type: ignore
from imas.ids_base import IDSBase  # type: ignore
from imas.ids_path import IDSPath  # type: ignore

from itertools import zip_longest, chain  # type: ignore

from imas_core.exception import ImasCoreBackendException

from ibex.data_source.data_source_interface import DataSourceInterface
from ibex.data_source.exception import (
    NodeNotFoundException,
    IdsNotFoundException,
    NotALeafNodeException,
    NotAnArrayException,
    EntryNotFoundException,
    NoDataException,
    InvalidParametersException,
)
from ibex.core.utils import downsample_data, transform_2D_data, find_first_value_in_list
from ibex.core.utils import IMAS_URI
from ibex.data_source.imas_python_source_utils import (
    path_in_filled_paths,
    convert_ids_data_into_numpy_array,
    resample_data_with_interpolation,
    resample_data_without_interpolation,
    pad_to_rectangular,
    flatten,
    expand,
    calculate_coordinate_shapes,
    apply_savgol_filter,
    apply_gaussian_filter,
    apply_simple_operations,
    resolve_irregular_coordinate_data_shape,
    apply_signal_operations,
    combine_signal_units,
)
from ibex.core.data_manipulation_methods import SmoothingMethod, InterpolationMethod
from ibex.endpoints.schemas.request_data_schemas import PlotDataRequestModel


class IMASPythonSource(DataSourceInterface):
    """
    Default data_source for IBEX
    """

    def __init__(self):
        """
        Default constructor
        """
        ...

    def data_serializer_custom(self, obj):
        """
        Custom data sub-serializer. Replaces arbitrary objects with ones supported by ORJSON serializer (IDSNumericArray -> np.array).
        """
        if isinstance(obj, IDSPrimitive):
            return obj.value
        if isinstance(obj, np.ndarray) and not obj.flags.c_contiguous:
            return np.ascontiguousarray(obj)
        if isinstance(obj, (np.ndarray, IDSNumericArray)):  # np.arrays with not supported dtype
            return obj.tolist()
        if isinstance(obj, complex):  # not supported dtype extracted from np.array
            return (obj.real, obj.imag)
        raise TypeError

    def _open_entry(self, uri: str) -> imas.DBEntry:
        """
        Opens DBEntry with mode "r". Handles possible exceptions.

        :param uri: imas URI
        :return: DBEntry object
        """
        try:
            return imas.DBEntry(uri, mode="r")
        except ImasCoreBackendException:
            message = f"Could not open pulsefile: {uri}"
            raise EntryNotFoundException(message) from None

    def _get_ids_from_entry(self, entry: imas.DBEntry, ids: str, occurrence: int = 0):
        """
        Reads ids from already opened DBEntry. Handles possible exceptions.

        :param entry: imas.DBEntry
        :param ids: name of ids e.g. core_profiles
        :param occurrence: ids occurrence number
        :return: IDSBase object
        """
        try:
            ids_root = entry.get(ids, lazy=True, autoconvert=False, occurrence=occurrence)
            return ids_root
        except imas.exception.IDSNameError as e:
            raise IdsNotFoundException(e) from None
        except imas.exception.DataEntryException as e:
            raise IdsNotFoundException(e) from None

    def data_entry_exists(self, uri: str) -> bool:
        """
        Check if data entry can be opened

        :param uri: imas URI
        :return: True if entry can be opened, False otherwise
        """

        try:
            entry = self._open_entry(uri)
            entry.close()
        except EntryNotFoundException:
            return False
        return True

    def list_idses(self, uri: str) -> dict:
        """
        Returns list of IDSes with occurrence numbers that are filled in given data entry uri

        :param uri: imas URI
        :return: dictionary: {'idses': [{'name':<name>, 'occurrences':[<0>,<1>,...]}, {'name': ...}]}
        """

        entry = self._open_entry(uri)
        ids_list = entry.factory.ids_names()
        result: dict = {"idses": []}

        # if "/uda?" in uri:
        #    return result

        for ids_name in ids_list:
            filled_occurrences = entry.list_all_occurrences(ids_name=ids_name)
            # filled_occurrences contains numpy.int32 types that have to be converted into int
            filled_occurrences = list(map(int, filled_occurrences))
            if filled_occurrences:
                result["idses"].append({"name": ids_name, "occurrences": filled_occurrences})

        entry.close()
        return result

    def _jsonify_metadata(self, metadata: IDSMetadata, recursive: bool = False, show_error_bars: bool = False) -> dict:
        """
        Converts imas.ids_metadata.IDSMetadata into dictionary

        :param metadata: imas.ids_metadata.IDSMetadata - metadata to be converted
        :param recursive: if it should append recursively metadata of children, children of children and so on...
        :param show_error_bars: whether error bar nodes should be returned, or not
        :return: metadata turned into dictionary with keys: `name`:str, `type`:str, `ndim`:str, `shape`:str, `children`:list[dict]
        """

        result = {}
        result["name"] = metadata.name
        result["type"] = metadata.data_type or "structure"
        result["ndim"] = metadata.ndim
        result["shape"] = []  # empty for 0D data
        result["is_geometry_node"] = self._is_geometry_node(metadata)

        if recursive:
            result["children"] = [self._jsonify_metadata(child, recursive, show_error_bars) for child in metadata]
        else:
            result["children"] = [
                {
                    "name": child.name,
                    "type": child.data_type,
                    "ndim": child.ndim,
                    "is_geometry_node": self._is_geometry_node(child),
                }
                for child in metadata
                if show_error_bars or not any(x in child.name for x in ["_error_upper", "_error_lower", "_error_index"])
            ]

        return result

    def _is_geometry_node(self, metadata: IDSMetadata):
        """
        Checks if node lies inside geometry structure
        :param metadata: metadata of ids node
        :return:
        """
        if metadata is None:
            return False

        node_type = getattr(metadata, "structure_reference", None)
        is_outline_static = node_type == "outline_2d_geometry_static"
        is_outline_rz = "outline" in metadata.name and node_type == "rz1d_static"

        if is_outline_rz or is_outline_static:
            return True

        return self._is_geometry_node(metadata._parent)

    def get_node_info(
        self,
        uri: str,
        ids: str,
        node_path: str,
        occurrence: int = 0,
        recursive: bool = False,
        show_error_bars: bool = False,
    ) -> dict:
        """
        Returns dictionary with basic info about IDS node pointed by `node_path` argument

        :param uri: pulsefile uri - used only to get proper DD version
        :param ids: name of ids e.g. core_profiles
        :param node_path: path to ids node e.g. ids_properties/version_put
        :param occurrence: ids occurrence number
        :param recursive: If True, creates node_info tree. If False, returns only pointed node and it's children node_info
        :param show_error_bars: whether error bar nodes should be returned, or not
        :return: dictionary containing node metadata
        """

        with self._open_entry(uri) as entry:
            metadata, coordinates = self._get_metadata_and_coordinates(entry, ids, node_path, occurrence)
            metadata_dict = self._jsonify_metadata(metadata, recursive, show_error_bars)

            # coordinates key contains list of lists of strings
            metadata_dict["coordinates"] = list(coordinates.values())
            # flatten list
            metadata_dict["coordinates"] = list(chain.from_iterable(metadata_dict["coordinates"]))

            # ========== check if node and it's children have data ==========
            try:
                filled_paths = entry.list_filled_paths(ids, int(occurrence))
            except (
                AttributeError,
                imas.backends.imas_core.imas_interface.LLInterfaceError,
                imas_core.exception.ImasCoreBackendException,
            ):
                # AttributeError - current version of IMAS-Python doesn't support list_filled paths
                # LLInterfaceError - current version of IMAS-Core doesn't support list_filled paths
                # ImasCoreBackendException - selected backend doesn't support list_filled paths
                ...  # proceed
            else:
                metadata_dict["has_data"] = path_in_filled_paths(metadata.path_string, filled_paths)

                if metadata.path_string == "":
                    # ids roots always have data (otherwise they cannot be obtained)
                    metadata_dict["has_data"] = True

                # update metadata dict
                for child_dict in metadata_dict["children"]:
                    child_metadata = metadata[child_dict["name"]]
                    child_dict["has_data"] = path_in_filled_paths(child_metadata.path_string, filled_paths)

            # ========== END check if node and it's children have data ==========

            # fill 'shape', but omit it if path points to more than one node
            if metadata_dict["ndim"] > 0 and ":" not in node_path:
                ids_path = IDSPath(node_path)
                path_elements = list(ids_path.items())
                ids_obj = self._get_ids_from_entry(entry, ids, occurrence)
                data_nodes = self._get_raw_data(ids_obj, path_elements)

                target_node = data_nodes
                # traverse through data until you find value
                while isinstance(target_node, list):
                    target_node = target_node[0]

                if isinstance(target_node, IDSStructure):
                    return metadata_dict

                if metadata_dict["type"] == IDSDataType.STRUCT_ARRAY or metadata_dict["type"] == IDSDataType.STR:
                    metadata_dict["shape"] = [len(target_node)]
                else:  # Numeric array
                    metadata_dict["shape"] = target_node.shape

        return metadata_dict

    def _get_raw_data(self, ids_obj: IDSBase, path_elements: List[IDSPath] | None):
        """
        Internal function. Returns raw data extracted from IDS

        :param ids_obj: root element used to traverse path
        :param path_elements: list of paths from root to leaf e.g. [IDSPath("ids_properties"), IDSPath("version_put"), IDSPath("access_layer")]
        :return: value, or list of values depending on context. Could be int, str, np.ndarray, complex, IDSStructure, etc.
        """

        if len(path_elements) == 0:
            # exit recursion
            return ids_obj

        # path_elements contains list of pairs (node_name, node_index/slice)
        # path_elements[0] represents first element of path
        # e.g. in path `profiles_1d[2]/t_i_average` path_elements[0] is tuple ('profiles_1d', 2)

        # There are 3 possible values of path index:
        # - None (no index at all e.g. in 'ids_properties')
        # - int value (single index e.g. in 'profiles_1d[2]')
        # - slice (range of values e.g. in 'profiles_1d[5:10]')

        path_node_name = path_elements[0][0]
        path_index = path_elements[0][1]

        if path_index is None:
            # No index in path element, just go deeper with recursion
            try:
                new_ids_obj = ids_obj[path_node_name]
            except AttributeError as e:
                raise NodeNotFoundException(e)
            return self._get_raw_data(new_ids_obj, path_elements[1:])

        elif isinstance(path_index, int):
            # int index in path element, just go deeper with recursion using index
            try:
                new_ids_obj = ids_obj[f"{path_node_name}[{path_index}]"]
            except AttributeError as e:
                raise NodeNotFoundException(e)
            except IndexError:
                message = f"Index out of range: {path_node_name} has no index {path_index}"
                raise NodeNotFoundException(message)
            return self._get_raw_data(new_ids_obj, path_elements[1:])

        elif isinstance(path_index, slice):
            # slice index in path element
            # here recursive tree splits into another branches. Then all returned values are put into single list.
            try:
                new_ids_obj = ids_obj[f"{path_node_name}"]
            except AttributeError as e:
                raise NodeNotFoundException(e)

            # === Evaluate start, stop and step parameters ===
            slice_obj = path_index

            start = slice_obj.start if slice_obj.start else 0
            if slice_obj.stop:
                stop = slice_obj.stop
            else:
                stop = len(new_ids_obj)

            step = slice_obj.step if slice_obj.step else 1
            # === ===

            # === Extract values ===
            result = []
            for x in range(start, stop, step):
                result.append(self._get_raw_data(new_ids_obj[x], path_elements[1:]))
            return result
        else:
            raise Exception(
                f"Type {type(path_index)} slices are not supported. Unsupported slice was found in {path_elements[0]} path part"
            )

    def _slice_to_string(self, slice_obj: slice | None | int):
        """
        Coverts slice object into it's string representation e.g. slice(1,2,3) -> [1:2:3]

        :param slice_obj: slice object
        :return: string representation of slice
        """
        if slice_obj is None:
            return ""
        if not isinstance(slice_obj, slice):
            # str, int, etc.
            return f"[{slice_obj}]"

        start = str(slice_obj.start) if slice_obj.start else ""
        stop = str(slice_obj.stop) if slice_obj.stop else ""
        step = str(slice_obj.step) if slice_obj.step else ""

        if not step:
            return f"[{start}:{stop}]"
        elif not start:
            return f"[:{stop}:{step}]"
        elif not stop:
            return f"[{start}::{step}]"
        else:
            return f"[{start}:{stop}:{step}]"

    def _get_path_and_path_ancestors(self, node_path: IDSPath):
        """
        Returns list of path and it's ancestors

        :param node_path: node_path
        :return: list of path and ancestors
        """

        # =========== Extract path ancestors ===========
        path_elements: List[str] = [f"{x[0]}{self._slice_to_string(x[1])}" for x in node_path.items()]

        # contains IDSPaths of all ancestors of path + path itself
        ancestors_and_path = []
        for i in range(1, len(path_elements) + 1):
            ancestors_and_path.append(IDSPath("/".join(path_elements[:i])))

        # sort list to contain leaf nodes at the beginning
        ancestors_and_path.sort(key=lambda x: len(str(x)), reverse=True)

        return ancestors_and_path

    def _get_metadata_and_coordinates(
        self, entry: imas.DBEntry, ids: str, node_path: str, occurrence: int = 0
    ) -> (IDSMetadata, List[str]):
        """
        Returns metadata of node and coordinates of node and it's ancestors

        :param entry: IMAS.DBEntry - used only to get proper DD version
        :param ids: name of ids e.g. core_profiles
        :param node_path: path to ids node e.g. ids_properties/version_put
        :param occurrence: ids occurrence number
        :return: tuple(IDSMetadata, dict(k: <node_name>, v: <coordinate_node_name>))
        """

        ids_obj = self._get_ids_from_entry(entry, ids, occurrence)

        is_time_homogeneous = ids_obj.ids_properties.homogeneous_time.value

        data_path = IDSPath(node_path)
        try:
            node_metadata = data_path.goto_metadata(ids_obj.metadata)
        except ValueError as e:
            raise NodeNotFoundException(e) from None
        ancestors_and_path = self._get_path_and_path_ancestors(data_path)

        # dict "node" : "coordinate"
        # e.g "profiles_1d[:]" : "time"
        coordinates = {}
        for element in ancestors_and_path:
            element_metadata = element.goto_metadata(ids_obj.metadata)

            # replace time-based coordinates with generic "time", if time is homogeneous
            for coord in element_metadata.coordinates:
                if element not in coordinates:
                    coordinates[element] = []

                if is_time_homogeneous and bool(coord.is_time_coordinate):
                    coordinates[element].append("time")
                else:
                    coordinates[element].append(str(coord))
        return (node_metadata, coordinates)

    def get_data(
        self,
        uri: str,
        ids: str,
        node_path: str,
        occurrence: int = 0,
        downsampling_method: str | None = None,
        downsampled_size: int = 1000,
    ) -> dict:
        """
        Returns data extracted from IDS, converted into dictionary

        :param uri: imas URI
        :param ids: name of ids e.g. core_profiles
        :param node_path: path to ids node e.g. ids_properties/version_put
        :param occurrence: ids occurrence number
        :param downsampling_method: method to be used during downsampling process
        :param downsampled_size: target size for downsampling
        :return: dictionary {'value':<node_value>}, where <node_value> represents data extracted from IDS node
        """
        with self._open_entry(uri) as entry:
            try:
                ids_root = self._get_ids_from_entry(entry, ids, occurrence)
            except imas.exception.DataEntryException as e:
                raise IdsNotFoundException(str(e)) from None
            ids_path = IDSPath(node_path)
            path_elements = list(ids_path.items())
            ids_data = self._get_raw_data(ids_root, path_elements)
        self._check_data_is_leaf_node(ids_data)

        data_to_be_returned = ids_data

        first_value = ids_data
        while isinstance(first_value, list):
            first_value = first_value[0]

        self._replace_empty_numbers(data_to_be_returned)
        if self._is_empty(data_to_be_returned):
            raise NoDataException(f"No data for {node_path}")

        if first_value.metadata.ndim == 1 and downsampling_method is not None:
            _, data_to_be_returned = downsample_data(
                data=data_to_be_returned, target_size=downsampled_size, method=downsampling_method
            )

        return {"value": data_to_be_returned}

    def _add_index_to_aos_in_path(self, ids_metadata: imas.ids_base.IDSBase, path_str: str):
        """
        Helper function to add `[:]` to AoSs in path:
        eg: source/profiles_1d/time -> source[:]/profiles_1d[:]/time (core_sources)

        :param ids_metadata: root of metadata path refers to
        :param path_str: path string
        :return: reworked string path
        """
        path_elements = path_str.split("/")
        result = ""

        for element in path_elements:
            ids_path = IDSPath(element)
            ids_metadata = ids_path.goto_metadata(ids_metadata)

            result += element
            if ids_metadata.data_type == IDSDataType.STRUCT_ARRAY:
                result += "[:]"
            result += "/"

        # return result without unnecessary "/" at the end
        return result[:-1]

    def find_paths(self, uri: str, searched_node: str, show_error_bars: bool = False) -> dict:
        """
        Finds paths containing phrase passed in searched_node argument

        :param uri: imas URI
        :param searched_node: searched text
        :param show_error_bars: whether error bar nodes should be returned, or not
        :return: dictionary {'paths': ['path/to/node1','path/to/node2', ...]}
        """
        with self._open_entry(uri) as entry:
            found_paths = []
            ids_list = entry.factory.ids_names()

            for ids in ids_list:
                try:
                    try:
                        filled_paths = entry.list_filled_paths(ids, occurrence=0)
                    except (AttributeError, imas.backends.imas_core.imas_interface.LLInterfaceError):
                        # AttributeError - current version of IMAS-Python doesn't support list_filled paths
                        # LLInterfaceError - current version of IMAS-Core doesn't support list_filled paths
                        # proceed
                        filled_paths = []
                    ids_obj = entry.get(ids, occurrence=0, autoconvert=False, lazy=True)
                    paths = [node for node in imas.util.find_paths(ids_obj, searched_node)]
                    for path in paths:
                        if not show_error_bars and any(
                            error_node in path for error_node in ["_error_upper", "_error_lower", "_error_index"]
                        ):
                            continue

                        # collect only leaf nodes
                        node_data_type = ids_obj.metadata[path].data_type
                        if node_data_type.value != "structure" and node_data_type.value != "struct_array":
                            path_name = f"#{ids}/{self._add_index_to_aos_in_path(ids_obj.metadata, path)}"
                            is_geometry_node = self._is_geometry_node(ids_obj.metadata[path])
                            if not filled_paths:
                                # every ids has at least one filled path. If not, it means functionality is not available.
                                found_paths.append(
                                    {"path": path_name, "has_data": None, "is_geometry_node": is_geometry_node}
                                )
                            else:
                                path_has_data = path_in_filled_paths(path, filled_paths)
                                found_paths.append(
                                    {"path": path_name, "has_data": path_has_data, "is_geometry_node": is_geometry_node}
                                )

                except imas.exception.DataEntryException:
                    continue

        return {"paths": found_paths}

    def array_summary(self, uri: str, ids: str, node_path: str, occurrence: int = 0) -> dict:
        """
        Returns short summary of array node as a dictionary

        :param uri: imas URI
        :param ids: name of ids e.g. core_profiles
        :param node_path: path to ids node e.g. ids_properties/version_put
        :param occurrence: ids occurrence number
        :return: dictionary {'shape': [<dim1>,<dim2>, ...], 'min':<min_value>, 'max':<max_value>, 'mean':<mean>, 'standard_deviation':<s_d>}
        """
        if "[:]" in node_path:
            message = "Array summary supports only single leaf node, not tensorized AoS (path with ':')"
            raise InvalidParametersException(message)

        ids_path = IDSPath(node_path)
        path_elements = list(ids_path.items())

        with self._open_entry(uri) as entry:
            ids_obj = self._get_ids_from_entry(entry, ids, occurrence)
            ids_data = self._get_raw_data(ids_obj, path_elements)
        self._check_data_is_leaf_node(ids_data)

        if isinstance(ids_data, IDSStructure) or isinstance(ids_data, IDSStructArray):
            raise NotALeafNodeException(f"Path {node_path} does not point to a leaf node")

        if not isinstance(ids_data, IDSNumericArray):
            raise NotAnArrayException("Cannot get array summary of non array node")

        result = {}

        result["shape"] = ids_data.shape
        result["min"] = np.min(ids_data)
        result["max"] = np.max(ids_data)
        result["mean"] = np.mean(ids_data)
        result["standard_deviation"] = np.std(ids_data)

        return result

    def list_db_entries(
        self,
        user: str,
        backends: Optional[Sequence[str]] = None,
        database: Optional[str] = None,
        version: Optional[int] = None,
    ) -> dict:
        """
        Returns list of available data entries

        :param user: owner of searched data entry
        :param backends: searched backends [<be1>, <be2>, ...]: default(None)
        :param database: searched database name: default(None)
        :param version: searched AL major version:
        :return: dictionary {'entries': [<uri1>, <uri2>, ...]}
        """

        result: dict[str, list[str]] = {}
        result["entries"] = []

        try:
            dbs = DBMaster.get_database_files(user, database, version, backends)
        except FileNotFoundError as e:
            raise InvalidParametersException(e)

        # Part of IDStools dblist script
        for dbname, dvs in dbs:
            if database and database not in dbname:
                continue
            for dv, dbbackends in dvs:
                if version and dv != version:
                    continue
                for backend, dbs in dbbackends:
                    if backends and backend not in backends:
                        continue
                    for pulse, runs in sorted(dbs.items()):
                        for r in sorted(runs, key=lambda x: x[1]):
                            result["entries"].append(
                                f"imas:{backend.lower()}?user={user};pulse={pulse};"
                                f"run={r[1]};database={dbname};version={dv}"
                            )
        return result

    def _extract_1_N_coord_values(self, data):
        """
        Goes through list of IDSStructArray (or lists of lists of lists...) and returns all 1...N coordinates values

        :param data: flat or nested list of IDSStructArray
        :return: list of 1...N values. Has the same shape as input list
        """
        if isinstance(data, list):
            return [self._extract_1_N_coord_values(x) for x in data]
        else:
            return data.coordinates[0]

    def _check_data_is_leaf_node(self, data) -> None:
        """
        Helper function. Helps determine if data could be returned (e.g. is not IDSStructure).
        It has to be done before data is returned to serializer.
        """
        if isinstance(data, list):
            for x in data:
                self._check_data_is_leaf_node(x)
        elif isinstance(data, IDSStructure):
            raise NotALeafNodeException("Cannot serialize non-leaf node")

    def _leaf_node_coordinates_contain_time(self, leaf_node_path: str, coordinates_to_be_returned: list[dict]) -> bool:
        """
        Returns True when the leaf-node coordinates contain a time coordinate.

        :param loaf_node_path: path to tested_node
        :param coordinates_to_be_returned: list of dicts of coordinates from get_plot_data() method
        :return: True or False
        """
        if not coordinates_to_be_returned:
            return False
        for coordinate in coordinates_to_be_returned:
            if coordinate["name"] == "time" and coordinate["target"] == leaf_node_path:
                return True

        return False

    def _generate_grid_quantity_alias(self, grid_node: IDSNumericArray):
        """
        Generates alias and unit for selected grid node. Assumes grid_node.name == "dimX" X=(1...N)
        :param grid_node: IDSNode (named dimX, X = [1...N])
        :return:
        """
        result = {"axis_label": None, "unit": None}
        if grid_node._parent is None or grid_node._parent._parent is None:
            return result
        if not re.search(r"dim[1-9]", grid_node.metadata.name):
            return result

        # assume grid_node is located inside XXX/grid/<node> and grid_type is located in XXX/grid_type
        grid_type_index = grid_node._parent._parent.grid_type.index
        if grid_type_index == imas.ids_defs.EMPTY_INT:
            return result

        dim_index = int(grid_node.metadata.name[-1]) - 1  # dim1->0, dim2->1 etc...
        # Extract units
        try:
            units = imas.identifiers.poloidal_plane_coordinates_identifier(grid_type_index).units.split(",")
            result["unit"] = units[dim_index]
        except (ValueError, KeyError, AttributeError):
            result["unit"] = None

        # Extract axis labels
        try:
            axis_labels = imas.identifiers.poloidal_plane_coordinates_identifier(grid_type_index).axis_labels.split(",")
            result["axis_label"] = axis_labels[dim_index]
        except AttributeError:
            description = imas.identifiers.poloidal_plane_coordinates_identifier(grid_type_index).description
            match = re.findall(r"(\w+)=(dim[1-9])", description)
            axis_labels = {v: k for k, v in match}
            result["axis_label"] = axis_labels.get(grid_node.metadata.name, None)

        return result

    def get_geometry_overlay_nodes(
        self,
        uri: str,
        show_empty_nodes: bool = False,
        show_error_bars: bool = False,
    ) -> dict:
        """
        Returns paths to metadata nodes that describe geometry overlays.

        A node is included when:
        - its type is ``outline_2d_geometry_static``, or
        - its name contains ``outline`` and its type is ``rz1d_static`` or ``rz1d_dynamic_aos``.
        Error bar nodes are filtered out by default and can be included with ``show_error_bars=True``.

        :param uri: imas URI
        :param show_empty_nodes: whether empty nodes should be returned, or not
        :param show_error_bars: whether error bar nodes should be returned, or not
        :return: dictionary {'outline_nodes': [{'geometry_node': '...', 'parameters': [...]}, ...]}
        """

        # ============ HELPER FUNCTION ============
        def _get_descendant_node_names(metadata: IDSMetadata):

            res = []
            if metadata.data_type in (IDSDataType.STRUCTURE, IDSDataType.STRUCT_ARRAY):
                for child in metadata:
                    res.extend([f"{metadata.name}/{x}" for x in _get_descendant_node_names(child)])
            else:
                res.append(f"{metadata.name}")
            return res

        def _walk_outline_nodes(
            uri: str,
            ids: str,
            occurrence: int,
            root_metadata: IDSMetadata,
            metadata: IDSMetadata,
            results: list[dict[str, list[str]]],
            show_error_bars: bool = False,
            filled_paths: list[str] | None = None,
        ) -> None:
            """
            Recursively traverses IDS metadata tree and collects nodes describing geometry overlays.

            A node is collected when its type is ``outline_2d_geometry_static``
            or when its name contains ``outline`` and its type is ``rz1d_static`` or ``rz1d_dynamic_aos``.

            :param uri: imas URI
            :param ids: name of IDS (e.g. core_profiles)
            :param occurrence: IDS occurrence number
            :param root_metadata: root metadata of the IDS (used to resolve tensorized paths)
            :param metadata: current metadata node to inspect
            :param results: list to which collected geometry overlay entries are appended
            :param show_error_bars: whether to include error bar parameter names (e.g. ``_error_upper``)
            :param filled_paths: optional list of filled paths; when given, only nodes with filled parameters are collected
            """

            if self._is_geometry_node(metadata):
                tensorized_path = self._add_index_to_aos_in_path(root_metadata, metadata.path_string)
                full_uri_with_path = f"{uri}#{ids}:{occurrence}/{tensorized_path}"
                parameters_entry = {"geometry_node": full_uri_with_path, "parameters": []}

                params = []
                for child in metadata:
                    params.extend(_get_descendant_node_names(child))

                for param in params:
                    is_error_node = any(
                        error_node in param for error_node in ["_error_upper", "_error_lower", "_error_index"]
                    )
                    if show_error_bars or not is_error_node:
                        if filled_paths is not None:
                            node = f"{metadata.path_string}/{param}"
                            if node in filled_paths:
                                parameters_entry["parameters"].append(param)
                        else:
                            parameters_entry["parameters"].append(param)

                if parameters_entry["parameters"]:  # don't put structures with empty "parameters"
                    results.append(parameters_entry)

            else:
                for child in metadata:
                    _walk_outline_nodes(
                        uri=uri,
                        ids=ids,
                        occurrence=occurrence,
                        root_metadata=root_metadata,
                        metadata=child,
                        results=results,
                        show_error_bars=show_error_bars,
                        filled_paths=filled_paths,
                    )

        # ============ END HELPER FUNCTION ============

        # Iterate over all filled IDSes and their occurrences to collect geometry overlay nodes
        filled_idses = self.list_idses(uri)["idses"]

        with self._open_entry(uri) as entry:
            result = []

            for ids_dict in filled_idses:
                # ids_dict = {'name': < name >, 'occurrences': [ < 0 >, < 1 >, ...]}
                for occurrence in ids_dict["occurrences"]:
                    ids_obj = self._get_ids_from_entry(entry, ids_dict["name"], occurrence)
                    outline_nodes = []

                    filled_paths = None
                    if not show_empty_nodes:
                        try:
                            filled_paths = entry.list_filled_paths(ids_dict["name"], int(occurrence))
                        except (AttributeError, imas.backends.imas_core.imas_interface.LLInterfaceError):
                            # AttributeError - current version of IMAS-Python doesn't support list_filled paths
                            # LLInterfaceError - current version of IMAS-Core doesn't support list_filled paths
                            # proceed without filtering empty nodes
                            ...

                    _walk_outline_nodes(
                        uri=uri,
                        ids=ids_dict["name"],
                        occurrence=occurrence,
                        root_metadata=ids_obj.metadata,
                        metadata=ids_obj.metadata,
                        results=outline_nodes,
                        show_error_bars=show_error_bars,
                        filled_paths=filled_paths,
                    )

                    result.extend(outline_nodes)

        return {"outline_nodes": result}

    def get_plot_data(self, plot_data_query: PlotDataRequestModel) -> dict:
        """
        Returns all data used to plot selected quantity. Result contains data values, metadata and coordinates.

        :param plot_data_query: See :class:`ibex.endpoints.schemas.request_data_schemas.PlotDataRequestModel`
        :type plot_data_query: :class:`ibex.endpoints.schemas.request_data_schemas.PlotDataRequestModel`
        :return: Dictionary containing data values, metadata and coordinates.
        """

        uri_obj = IMAS_URI(plot_data_query.uri.strip())
        uri = uri_obj.uri_entry_identifiers
        ids = uri_obj.ids_name
        node_path = uri_obj.node_path
        occurrence = uri_obj.occurrence

        if not plot_data_query.interpolation_method:
            plot_data_query.interpolation_method = InterpolationMethod.EXACT_VALUE

        with self._open_entry(uri) as entry:
            ids_obj = self._get_ids_from_entry(entry, ids, occurrence)

            ids_path = IDSPath(node_path)
            path_elements = list(ids_path.items())
            ids_data = self._get_raw_data(ids_obj, path_elements)
            self._check_data_is_leaf_node(ids_data)

            if self._is_empty(ids_data):
                raise NoDataException(f"No data for {uri}#{ids}/{node_path}")
            coordinates_to_be_returned = []

            # =================================
            metadata, coordinates_dict = self._get_metadata_and_coordinates(entry, ids, node_path, occurrence)
            # replace all dummy indexes i.e. "itime", "i1", "i2", "i3"... -> [<value_from_target_node>]
            for _node_path, _coordinate_path_list in coordinates_dict.items():
                _new_coordinate_path_list = []
                for _coordinate_path in _coordinate_path_list:
                    if _coordinate_path.startswith("1..."):  # 1...N, 1...2, 1...3 etc.
                        _new_coordinate_path_list.append(_coordinate_path)
                        continue

                    _new_coordinate_path = ""

                    # iterate over path elements. X stands target node path element, while Y stands for coordinate path elements
                    # we do this in order to fill dummy indexes with indexes extracted from target node path
                    for x, y in zip_longest(_node_path.items(), IDSPath(_coordinate_path).items()):
                        # x[0] is node name in path e.g. profiles_1d
                        # x[1] is indices or single index. For instance x=profiles_1d[123] -> x[0]=profiles_1d & x[1]=123
                        # the same applies to y

                        y_indices = y[1] if y is not None else None

                        if y is not None:
                            if x is not None and x[0] == y[0]:
                                y_indices = x[1]
                            # construct new coordinate path element from node_name and slice extracted from x[1]
                            _new_coordinate_path += f"{y[0]}{self._slice_to_string(y_indices)}/"

                    # delete last "/" from path
                    _new_coordinate_path = _new_coordinate_path[:-1]

                    _new_coordinate_path_list.append(_new_coordinate_path)
                coordinates_dict[_node_path] = _new_coordinate_path_list

            # =================================
            for target, coord_list in coordinates_dict.items():
                # certain coordinate has influence on final data shape only if it is a slice (e.g. profiles_1d[:]), or a leaf node
                # search for [<number>] in coordinate target
                shapes_dimension = not bool(re.search(r"\[\d+\]$", str(target)))

                for coord in coord_list:
                    if coord.startswith("1..."):
                        # remove last array operator ([<number or colon>]) from path and save it as target_str
                        splitted_target = str(target).split("/")
                        splitted_target[-1] = re.sub(r"[\[\(](.*?)[\]\)]", "", splitted_target[-1])
                        target_str = "/".join([x for x in splitted_target])
                        # ====================================

                        # not returned, only used internally for interpolation check
                        _is_aos = (
                            IDSPath(target_str).goto_metadata(ids_obj.metadata).data_type == IDSDataType.STRUCT_ARRAY
                        )

                        ids_path = IDSPath(str(target_str))
                        path_elements = list(ids_path.items())
                        coord_target_objects = self._get_raw_data(ids_obj, path_elements)
                        self._check_data_is_leaf_node(coord_target_objects)

                        # collect labels for 1... coordinates
                        labels = []
                        try:
                            for element in coord_target_objects:
                                if hasattr(element, "name"):
                                    labels.append(str(element.name))
                                elif hasattr(element, "label"):
                                    labels.append(str(element.label))
                                elif hasattr(element, "identifier") and hasattr(element.identifier, "name"):
                                    labels.append(str(element.identifier.name))
                                elif hasattr(element, "type") and hasattr(element.type, "name"):
                                    labels.append(str(element.type.name))
                                else:
                                    raise AttributeError("No additional data to create label")

                            # if any label is empty, use indexes instead
                            if any(s == "" for s in labels):
                                labels = []
                        except AttributeError:
                            labels = []

                        coord_values: np.ndarray = self._extract_1_N_coord_values(coord_target_objects)

                        # ==================================== find and add shape factors
                        _, coordinates_of_coordinate = self._get_metadata_and_coordinates(
                            entry, ids, str(target), occurrence
                        )
                        shape_factors = []

                        for k, v in coordinates_of_coordinate.items():
                            if k == target:
                                continue
                            shape_factors.append(f"#{ids}/{k}")
                        # ====================================

                        # If direct coordinate of node is 1...N, replace name with '1...N'
                        # (otherwise coordinate name would be the same as target node name)
                        coordinate_name = splitted_target[-1]
                        if f"{target}" == f"{node_path}":
                            coordinate_name = coord

                        try:
                            coord_data_shape = np.asarray(coord_values).shape
                        except ValueError:
                            coord_data_shape = "irregular"

                        c = {
                            "name": coordinate_name,
                            "target": f"#{ids}/{target}",
                            "unit": "",
                            "shape": coord_data_shape,
                            "downsampled_shape": coord_data_shape,
                            "ndim": 1,  # 1...N coord always have 1 dimension
                            "path": "",
                            "description": "1...N",
                            "coordinates": shape_factors,
                            "shapes_dimension": shapes_dimension,
                            "_is_aos": _is_aos,  # not returned, only used internally for interpolation validation
                            "value": labels if labels else coord_values,
                        }
                        coordinates_to_be_returned.append(c)

                    else:
                        coord_path = IDSPath(coord)
                        coord_real_paths = list(coord_path.items())
                        coord_data = self._get_raw_data(ids_obj, coord_real_paths)
                        self._check_data_is_leaf_node(coord_data)

                        first_value = find_first_value_in_list(coord_data)

                        # ==================================== find and add shape factors
                        _, coordinates_of_coordinate = self._get_metadata_and_coordinates(entry, ids, coord, occurrence)
                        shape_factors = []

                        for k, v in coordinates_of_coordinate.items():
                            if str(k) == coord:
                                continue
                            shape_factors.append(f"#{ids}/{k}")
                        # ====================================

                        try:
                            coord_data_shape = np.asarray(coord_data).shape
                        except ValueError:
                            coord_data_shape = "irregular"

                        coord_name = coord.split("/")[-1]
                        axis_label = None
                        unit = None
                        if re.search(r"dim[1-9]", coord_name):
                            labels_dict = self._generate_grid_quantity_alias(first_value)
                            axis_label = labels_dict["axis_label"]
                            unit = labels_dict["unit"]

                        coord_name = axis_label if axis_label else coord_name
                        units = unit if unit else first_value.metadata.units
                        c = {
                            "name": coord_name,
                            "target": f"#{ids}/{target}",
                            "unit": units,
                            "shape": coord_data_shape,  # coord_data could be np.ndarray or list[np.ndarray]
                            "downsampled_shape": coord_data_shape,
                            "ndim": first_value.metadata.ndim,
                            "path": f"#{ids}/{coord}",
                            "description": first_value.metadata.documentation,
                            "coordinates": shape_factors,
                            "shapes_dimension": shapes_dimension,
                            "value": coord_data,
                        }
                        coordinates_to_be_returned.append(c)
            first_value = find_first_value_in_list(ids_data)
            result_unit = first_value.metadata.units or ""
            data_to_be_returned = convert_ids_data_into_numpy_array(ids_data)

            if first_value.metadata.ndim == 2:
                # Transform 2D arrays.
                # By default first dimension of 2D has coordinate that is second on the list
                # FE expects data's first dimension to be connected with second dimension, thus this transformation

                data_to_be_returned = transform_2D_data(data_to_be_returned)

            # ============= BEGIN simple operations ============

            if plot_data_query.operations is not None:
                data_to_be_returned = apply_simple_operations(data_to_be_returned, plot_data_query.operations)

            # ============= END simple operations =============

            # ============= BEGIN data smoothing ============
            if plot_data_query.smoothing_method is not None:
                if not self._leaf_node_coordinates_contain_time(f"#{ids}/{node_path}", coordinates_to_be_returned):
                    raise InvalidParametersException(
                        "Data smoothing is only supported when leaf-node coordinates contain time"
                    )

                if plot_data_query.smoothing_method == SmoothingMethod.SAVITZKY_GOLAY_FILTER:
                    if first_value.metadata.ndim != 1:
                        message = f"Savitzky-Golay filter supports only 1D smoothing. Selected data node is {first_value.metadata.ndim}D."
                        raise InvalidParametersException(message)
                    data_to_be_returned = apply_savgol_filter(
                        data_to_be_returned,
                        window_length=plot_data_query.savgol_smoothing_window_length,
                        polyorder=plot_data_query.savgol_smoothing_polyorder,
                        deriv=plot_data_query.savgol_smoothing_deriv,
                        delta=plot_data_query.savgol_smoothing_delta,
                        mode=plot_data_query.savgol_smoothing_mode,
                        cval=plot_data_query.savgol_smoothing_cval,
                    )

                elif plot_data_query.smoothing_method == SmoothingMethod.GAUSSIAN_FILTER:
                    time_coordinate_axis = None
                    if first_value.metadata.ndim == 2:
                        time_coordinate_axis = next(
                            (i for i, d in enumerate(coordinates_to_be_returned) if d.get("name") == "time"), None
                        )
                    data_to_be_returned = apply_gaussian_filter(
                        data_to_be_returned,
                        sigma=plot_data_query.gaussian_smoothing_sigma,
                        axis=time_coordinate_axis,
                    )

            # ============= END data smoothing =============

            try:
                original_data_shape = np.asarray(data_to_be_returned).shape
            except ValueError:
                original_data_shape = "irregular"

            # ============= BEGIN resample data onto new time vector =============
            def convert_to_lists(data):
                if isinstance(data, list):
                    return [convert_to_lists(d) for d in data]
                elif isinstance(data, (np.ndarray, IDSNumericArray)):
                    return data.tolist()
                else:
                    return data

            # Signals used when combining data after interpolation.
            # {uri: str, data: list[*], coordinates: list[list], shape: list, unit: str}
            signals_data = {
                plot_data_query.uri: {
                    "uri": plot_data_query.uri,
                    "data": data_to_be_returned,
                    "coordinates": [
                        sorted(set(flatten(convert_to_lists(c["value"])))) for c in coordinates_to_be_returned
                    ],
                    "shape": original_data_shape,
                    "unit": result_unit,
                }
            }

            if plot_data_query.interpolate_over:
                # check for non-interpolatable coordinates
                if plot_data_query.interpolation_method != InterpolationMethod.EXACT_VALUE:
                    for _coord in coordinates_to_be_returned:
                        if _coord.get("description") == "1...N" and _coord.get("_is_aos"):
                            raise InvalidParametersException(
                                f"Interpolation is not supported for coordinate '{_coord['name']}' "
                                "which is a Array of Structures coordinate and cannot be used to generate new values. Try using exact_value method."
                            )

                # =================== GATHER ALL COORDINATES ===================
                original_coord_values = []

                should_resample_data_onto_new_coordinates: bool = False

                for c in coordinates_to_be_returned:
                    c["value"] = convert_to_lists(c["value"])
                    original_coord_values.append(sorted(set(flatten(c["value"]))))

                    expected_flattened_shape = np.array(c["value"]).shape[-1]
                    flattened_shape = np.array(original_coord_values[-1]).shape[-1]

                    if expected_flattened_shape != flattened_shape:
                        # If given coordinate is different across AoS indices, we cannot simply flatted coordinates list to 1D.
                        should_resample_data_onto_new_coordinates = True

                if should_resample_data_onto_new_coordinates:
                    # Coordinates values are different across AoS indices
                    # New data array has to be created with all data points
                    data_to_be_returned = resolve_irregular_coordinate_data_shape(
                        coordinates=list(reversed([c["value"] for c in coordinates_to_be_returned])),
                        data=data_to_be_returned,
                        target_coordinates=list(reversed(original_coord_values)),
                    )

                original_coord_values.reverse()

                store_other_signals_data = False  # used for signal combining after interpolation
                if plot_data_query.signal_operations:
                    store_other_signals_data = True

                for _uri in plot_data_query.interpolate_over:
                    _uri_obj = IMAS_URI(_uri)

                    if _uri_obj.ids_name != ids or _uri_obj.node_path != node_path:
                        if any(node_path == _uri_obj.node_path + m for m in ["_error_upper", "_error_lower"]):
                            # it is allowed to interpolate _error node over data node e.g. ip_error_upper over ip
                            ...
                        else:
                            raise InvalidParametersException(
                                "IDS name and node path should be the same for source and target URI when interpolating data"
                            )

                    new_plot_data_query = PlotDataRequestModel(uri=_uri)
                    # interpolate_to will be used later with signal combining
                    interpolate_to = self.get_plot_data(new_plot_data_query)["data"]
                    interpolate_to_coordinates = interpolate_to["coordinates"]
                    if store_other_signals_data:
                        signals_data[_uri] = {
                            "uri": _uri,
                            "data": pad_to_rectangular(interpolate_to["value"]),
                            "coordinates": [
                                sorted(set(flatten(convert_to_lists(c["value"])))) for c in interpolate_to_coordinates
                            ],
                            "shape": interpolate_to["shape"],
                            "unit": interpolate_to["unit"],
                        }

                    if len(interpolate_to_coordinates) != len(coordinates_to_be_returned):
                        message = "Interpolation error. Source and target nodes have different number of coordinates."
                        raise InvalidParametersException(message)

                    for x, y in zip(coordinates_to_be_returned, interpolate_to_coordinates):
                        if x["name"] != y["name"]:
                            # coordinates between quantities doesn't match
                            message = f"Interpolation error. Coordinates names does not match between target and source nodes ({x['name']} vs. {y['name']})."
                            raise InvalidParametersException(message)

                        x["value"] = sorted(set(flatten(x["value"]) + flatten(convert_to_lists(y["value"]))))

                # reverse coordinates list so it matches data dimensions
                common_coords_values = [c["value"] for c in reversed(coordinates_to_be_returned)]
                # =================== INTERPOLATE ===================

                # === make data vector rectangular ===
                data_to_be_returned = pad_to_rectangular(data_to_be_returned)

                # === run interpolation ===
                if plot_data_query.interpolation_method == InterpolationMethod.EXACT_VALUE:
                    data_to_be_returned = resample_data_without_interpolation(
                        tuple(original_coord_values), data_to_be_returned, tuple(common_coords_values)
                    )
                else:
                    data_to_be_returned = resample_data_with_interpolation(
                        tuple(original_coord_values),
                        data_to_be_returned,
                        tuple(common_coords_values),
                        interpolation_method=plot_data_query.interpolation_method,
                    )

                # Keep the primary signal entry in sync with its resampled data.
                signals_data[plot_data_query.uri].update(
                    {
                        "data": np.array(data_to_be_returned, copy=True),
                        "coordinates": [list(values) for values in reversed(common_coords_values)],
                        "shape": list(np.asarray(data_to_be_returned).shape),
                    }
                )

                new_coordinate_shapes = calculate_coordinate_shapes(
                    list(np.asarray(data_to_be_returned).shape),
                    first_value.metadata.ndim,
                )

                # expand flattened coordinates
                for i, c in enumerate(coordinates_to_be_returned):
                    c["shape"] = list(new_coordinate_shapes[i])
                    c["value"] = expand(c["value"], c["shape"][:-1])

            # ============= END resample data onto new time vector =============

            # ============= BEGIN signal operations =============
            #
            # Steps performed in this block:
            # 1. Collect all signal URIs referenced in signal_operations
            # 2. Pad data to rectangular if shape is irregular
            # 3. For each signal URI, fetch and prepare data:
            #    a. If the signal was already interpolated (stored during
            #       interpolation phase), skip fetching
            #    b. Otherwise fetch the signal and check shape compatibility
            # 4. Prepare operand data for each signal:
            #    a. If interpolation was requested, resample onto common coords
            #    b. Otherwise normalize raw signal data to a NumPy array
            # 5. Build a flat uri->array dict and apply all signal operations

            if plot_data_query.signal_operations:
                # Step 1: extract unique signal URIs from operation strings
                signal_op_uris = set()
                for op_str in plot_data_query.signal_operations or []:
                    _, op_uri = op_str.split(":", 1)
                    signal_op_uris.add(op_uri)

                # Step 2: ensure rectangular data for downstream processing
                if original_data_shape == "irregular":
                    data_to_be_returned = pad_to_rectangular(data_to_be_returned)

                # Step 3: fetch and prepare each signal referenced in operations
                for signal_uri in signal_op_uris:
                    if signal_uri not in signals_data:
                        # Signal was not pre-loaded during interpolation phase.
                        # Fetch it now and verify shape compatibility.
                        request = PlotDataRequestModel(uri=signal_uri)
                        other_signal = self.get_plot_data(request)

                        # Comparing signal shapes
                        if (
                            other_signal["data"]["shape"] == "irregular"
                            or other_signal["data"]["shape"] != original_data_shape
                        ):
                            msg = (
                                f"Cannot apply operation on signal {signal_uri} without interpolation. "
                                "Signal and data shapes do not match. "
                                "Try interpolating the signal onto the data shape."
                            )
                            raise InvalidParametersException(msg)

                        # Comparing coordinates
                        coordinates_match = self._coordinates_match(
                            coordinates_to_be_returned, other_signal["data"]["coordinates"]
                        )

                        if not coordinates_match:
                            msg = (
                                f"Cannot apply operation on signal {signal_uri} without interpolation. "
                                "Coordinates do not match. "
                                "Try interpolating the signal onto the data coordinates."
                            )
                            raise InvalidParametersException(msg)

                        signals_data[signal_uri] = {
                            "uri": request.uri,
                            "data": other_signal["data"]["value"],
                            "coordinates": [
                                sorted(set(flatten(convert_to_lists(c["value"]))))
                                for c in other_signal["data"]["coordinates"]
                            ],
                            "shape": other_signal["data"]["shape"],
                            "unit": other_signal["data"]["unit"],
                        }

                    # Step 4: prepare operand data (resampled or raw)
                    if plot_data_query.interpolate_over:
                        # Resample signal data onto the common coordinate grid
                        signal_data = resample_data_without_interpolation(
                            tuple(reversed(signals_data[signal_uri]["coordinates"])),
                            signals_data[signal_uri]["data"],
                            tuple(common_coords_values),
                        )
                    else:
                        signal_data = signals_data[signal_uri]["data"]

                    signals_data[signal_uri]["data"] = np.asarray(signal_data)

                # Step 5: flatten dict and apply operations in order
                signal_data_by_uri = {uri: info["data"] for uri, info in signals_data.items()}

                # Step 6: Handling operations units
                for operation in plot_data_query.signal_operations:
                    operation_type, signal_uri = operation.split(":", 1)
                    result_unit = combine_signal_units(
                        result_unit,
                        signals_data[signal_uri]["unit"],
                        operation_type,
                    )

                # Step 7: Computing 'operations'
                data_to_be_returned = apply_signal_operations(
                    data_to_be_returned, plot_data_query.signal_operations, signal_data_by_uri
                )

            # ============= END signal operations =============

            # Interpolation and signal operations can change the data shape.
            # The response's ``shape`` describes the processed data before
            # downsampling, rather than the raw shape used for compatibility
            # checks above.
            try:
                processed_data_shape = np.asarray(data_to_be_returned).shape
            except ValueError:
                processed_data_shape = "irregular"

            # Downsample only 1D data
            if first_value.metadata.ndim == 1:
                if coordinates_to_be_returned[0]["target"].split("/")[-1] == f"{node_path.split('/')[-1]}":
                    # If coordinate targets node -> downsample coordinate as well
                    coordinates_to_be_returned[0]["value"], data_to_be_returned = downsample_data(
                        data_to_be_returned,
                        target_size=plot_data_query.downsampled_size,
                        method=plot_data_query.downsampling_method,
                        x=coordinates_to_be_returned[0]["value"],
                        single_x_axis=(coordinates_to_be_returned[0]["path"] == f"#{ids}/time"),
                    )

                else:
                    _, data_to_be_returned = downsample_data(
                        data_to_be_returned,
                        target_size=plot_data_query.downsampled_size,
                        method=plot_data_query.downsampling_method,
                    )
            # serialize coordinates and update shapes (they could be changed by downsampling)
            for c in coordinates_to_be_returned:
                try:
                    c["downsampled_shape"] = np.asarray(c["value"]).shape
                except ValueError:
                    c["downsampled_shape"] = "irregular"
            try:
                downsampled_shape = np.asarray(data_to_be_returned).shape
            except ValueError:
                downsampled_shape = "irregular"
            result = {
                "data": {
                    "name": node_path.split("/")[-1],
                    "unit": result_unit,
                    "shape": processed_data_shape,
                    "downsampled_shape": downsampled_shape,
                    "ndim": first_value.metadata.ndim,
                    "path": f"#{ids}/{node_path}",
                    "description": first_value.metadata.documentation,
                    "coordinates": coordinates_to_be_returned,
                    "value": data_to_be_returned,
                }
            }

            # =================================
            # update shape factors
            for coordinate in coordinates_to_be_returned:
                new_shape_factors_list = []
                for shape_factor in coordinate["coordinates"]:
                    # search for coordinates that have <shape_factor> name in "target" key
                    coord_name = next(x["name"] for x in coordinates_to_be_returned if x["target"] == shape_factor)
                    new_shape_factors_list.append(coord_name)
                coordinate["coordinates"] = new_shape_factors_list
        return result

    def _coordinates_match(self, coordinates_1, coordinates_2):
        if len(coordinates_1) != len(coordinates_2):
            return False

        coordinates_match = all(
            coordinate_1["name"] == coordinate_2["name"]
            and np.array_equal(np.asarray(coordinate_1["value"]), np.asarray(coordinate_2["value"]), equal_nan=True)
            for coordinate_1, coordinate_2 in zip(coordinates_1, coordinates_2)
        )
        return coordinates_match

    def _is_empty(self, seq):
        """Checks if list is essentially empty (contains only empty lists or empty strings)"""
        if isinstance(seq, (IDSNumericArray, IDSString0D, IDSString1D, IDSComplex0D, IDSFloat0D, IDSInt0D)):
            return not seq.has_value
        if isinstance(seq, np.ndarray):
            return seq.size == 0
        if isinstance(seq, list):
            return all(map(self._is_empty, seq))
        if np.isnan(seq):
            return True
        else:
            return False

    def _replace_empty_numbers(self, arr, replace_to=np.nan):
        for i, x in enumerate(arr):
            if isinstance(x, list):
                self._replace_empty_numbers(x, replace_to)
            else:
                try:
                    if not x.has_value:
                        arr[i] = replace_to
                # exception occurs for numpy values e.g. numpy.float64
                except AttributeError:
                    if (
                        x == imas.ids_defs.EMPTY_FLOAT
                        or x == imas.ids_defs.EMPTY_INT
                        or x == imas.ids_defs.EMPTY_COMPLEX
                    ):
                        arr[i] = replace_to
