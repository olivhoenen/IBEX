"""Endpoints extracting metadata from data source"""

from fastapi import APIRouter  # type: ignore

from ibex.core import ibex_service
from ibex.endpoints.schemas.response_ids_info_schemas import (
    NodeInfoResponse,
    FindPathsResponse,
    ArraySummaryResponse,
    GeometryOverlayNodesResponse,
)

router = APIRouter()


@router.get(
    "/ids_info/node_info",
    status_code=200,
    response_model=NodeInfoResponse,
    responses={
        200: {"description": "Node info returned successfully"},
        404: {"description": "Data node not found"},
    },
    description="Returns given ids node parameters and description",
)
@ibex_service.measure_execution_time
def node_info(uri: str, show_error_bars: bool = False) -> dict:
    """
    IBEX endpoint. Returns metadata of a node (leaf or intermediate).

    | Response JSON is constructed as follows:
    | {
    |     "name": <node_name (str)>,
    |     "type": <type_of_data (str)>,
    |     "ndim": <number_of_data_dimensions (int)>,
    |     "shape": <data_shape (list(int))>,
    |     "has_data": <True if node has data inside (bool)>
    |     "children": <node_info_of_children_nodes (list(dict))>,
    |     "coordinates": <coordinates_names (list(str))>
    | }

    :param uri: IMAS URI with the path to leaf node
    :rtype: dict (automatically converted to JSON by FastAPI)
    :return: JSON response

    """
    return ibex_service.get_node_info(uri.strip(), show_error_bars=show_error_bars)


@router.get(
    "/ids_info/find_paths",
    status_code=200,
    response_model=FindPathsResponse,
    responses={
        200: {"description": "Paths returned successfully"},
    },
    description="Searches for given node path in the pulsefile",
)
@ibex_service.measure_execution_time
def find_field(uri: str, searched_node: str, show_error_bars: bool = False) -> dict:
    """
    IBEX endpoint. Returns list of nodes that have searched text within it's name.

    | Response JSON is constructed as follows:
    | {
    |   "paths": [
    |   {"path" : <path_1 (str)>, "has_data" : <has_data (bool)>},
    |   {"path" : <path_2 (str)>, "has_data" : <has_data (bool)>},
    |   ...
    |   {"path" : <path_N (str)>, "has_data" : <has_data (bool)>},
    |   ]
    | }

    :param uri: IMAS URI
    :param searched_node: name of searched node
    :param show_error_bars: switch used to hide _error* nodes
    :rtype: dict (automatically converted to JSON by FastAPI)
    :return: JSON response

    """
    return ibex_service.find_paths(uri.strip(), searched_node, show_error_bars)


@router.get(
    "/ids_info/array_summary",
    status_code=200,
    response_model=ArraySummaryResponse,
    responses={
        200: {"description": "Array summary returned successfully"},
        404: {"description": "Data node not found"},
        462: {"description": "Given node is not an array"},
        466: {"description": "Current implementation does not support tensorized paths"},
    },
    description="Returns summarized array node parameters",
)
@ibex_service.measure_execution_time
def array_summary(uri: str) -> dict:
    """
    IBEX endpoint. Returns summary of an array node.

    | Response JSON is constructed as follows:
    | {
    |     "shape": <data_shape (list(int))>
    |     "min": <minimum_value (float)>,
    |     "max": <maximum_value (float)>,
    |     "mean": <mean_value (float)>,
    |     "standard_deviation": <standard_deviation (float))>
    | }

    :param uri: IMAS URI with the path to leaf node
    :rtype: dict (automatically converted to JSON by FastAPI)
    :return: JSON response

    """
    return ibex_service.array_summary(uri.strip())


@router.get(
    "/ids_info/geometry_overlay_nodes",
    status_code=200,
    response_model=GeometryOverlayNodesResponse,
    responses={
        200: {"description": "Geometry overlay nodes returned successfully"},
    },
    description="Returns geometry overlay nodes metadata",
)
@ibex_service.measure_execution_time
def geometry_overlay_nodes(uri: str, show_empty_nodes: bool = False, show_error_bars: bool = False) -> dict:
    """
    IBEX endpoint. Returns paths to geometry overlay nodes.

    | Response JSON is constructed as follows:
    | {
    | "outline_nodes" : [<node1>, <node2>, ...]
    | }

    :param uri: IMAS URI
    :param show_empty_nodes: switch used to hide empty nodes
    :param show_error_bars: switch used to hide _error* nodes
    :rtype: dict (automatically converted to JSON by FastAPI)
    :return: JSON response

    """
    return ibex_service.get_geometry_overlay_nodes(
        uri.strip(), show_empty_nodes=show_empty_nodes, show_error_bars=show_error_bars
    )
