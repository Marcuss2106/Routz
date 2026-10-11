from collections import defaultdict
from types import SimpleNamespace

from backend.coordinates import CoordinateSystem
from backend.dataset_generator import GeneratorConfig, generate_dataset
from backend.pathfinder_evaluation import (
    Metrics,
    evaluate_dataset,
    select_frequency_model,
    split_for_run,
)
from backend.rail_network import Edge
from backend.rail_pathfinder import (
    TrainFix,
    fit_branch_priors,
    predict_paths,
)


def _switch_network():
    coordinates = CoordinateSystem(34.0007, -81.0348)
    east = coordinates.origin_easting
    north = coordinates.origin_northing
    nodes = [
        (east, north - 100),
        (east, north),
        (east, north + 100),
        (east + 100, north),
    ]
    edges = {
        "incoming": Edge("incoming", 0, 1, [nodes[0], nodes[1]], 100.0, {}),
        "straight": Edge("straight", 1, 2, [nodes[1], nodes[2]], 100.0, {}),
        "right": Edge("right", 1, 3, [nodes[1], nodes[3]], 100.0, {}),
    }
    adjacency = defaultdict(list)
    for edge in edges.values():
        adjacency[edge.start].append((edge.end, edge.edge_id, edge.length_m))
        adjacency[edge.end].append((edge.start, edge.edge_id, edge.length_m))
    return SimpleNamespace(
        coordinates=coordinates,
        nodes=nodes,
        edges=edges,
        adjacency=dict(adjacency),
    )


def _fix(network, speed_mps=10.0):
    east = network.coordinates.origin_easting
    north = network.coordinates.origin_northing - 50
    longitude, latitude = network.coordinates.utm_to_wgs(east, north)
    return TrainFix(latitude, longitude, 0.0, speed_mps)


def test_heading_baseline_ranks_straight_branch_first():
    network = _switch_network()
    result = predict_paths(network, _fix(network), (5.0, 10.0), top_k=2)

    assert result.snapped_edge_id == "incoming"
    assert len(result.candidates) == 2
    assert result.candidates[0].first_switch_id == "node-1"
    assert result.candidates[0].first_branch_edge_id == "straight"
    assert result.candidates[1].first_branch_edge_id == "right"
    assert result.candidates[0].probability > result.candidates[1].probability
    assert abs(result.candidates[0].positions[1].local_z_m + 50.0) < 0.01


def test_frequency_prior_can_change_top_branch_without_destination():
    network = _switch_network()
    priors = {(1, "incoming"): {"right": 1.0, "straight": 0.0}}
    result = predict_paths(
        network,
        _fix(network),
        (10.0,),
        top_k=2,
        branch_priors=priors,
    )

    assert result.candidates[0].first_branch_edge_id == "right"


def test_fix_exactly_at_switch_node_uses_snapped_heading():
    network = _switch_network()
    east = network.coordinates.origin_easting
    north = network.coordinates.origin_northing
    longitude, latitude = network.coordinates.utm_to_wgs(east, north)
    fix = TrainFix(latitude, longitude, 0.0, 10.0)

    result = predict_paths(network, fix, (5.0, 15.0), top_k=2)

    assert result.candidates
    assert result.candidates[0].first_branch_edge_id == "straight"


def test_stopped_fix_stays_on_snapped_segment():
    network = _switch_network()
    result = predict_paths(network, _fix(network, speed_mps=0.0), (5.0, 30.0))

    assert result.uncertain is True
    assert len(result.candidates) == 1
    assert all(position.stopped for position in result.candidates[0].positions)
    assert result.candidates[0].first_branch_edge_id is None


def test_branch_priors_use_only_observable_switch_context_and_label():
    rows = [
        {
            "upcoming_switch_id": "node-7",
            "track_segment_id": "incoming",
            "actual_branch_edge_id": "left",
            "destination_node_id": 999,
        },
        {
            "upcoming_switch_id": "node-7",
            "track_segment_id": "incoming",
            "actual_branch_edge_id": "left",
            "planned_directed_edge_ids": ["answer"],
        },
        {
            "upcoming_switch_id": "node-7",
            "track_segment_id": "incoming",
            "actual_branch_edge_id": "right",
        },
    ]
    priors = fit_branch_priors(rows)

    assert set(priors) == {(7, "incoming"), (7, "*")}
    assert priors[(7, "incoming")]["left"] > priors[(7, "incoming")]["right"]


def test_dataset_evaluation_uses_run_splits_and_writes_metrics(tmp_path):
    dataset_dir = tmp_path / "dataset"
    generate_dataset(
        GeneratorConfig(
            run_count=12,
            duration_s=8.0,
            sampling_rate_hz=2.0,
            seed=9876,
            batch_size=50,
            output_dir=dataset_dir,
            prediction_horizons_s=(1.0, 3.0),
            measurement_noise_m=2.0,
            min_route_length_m=1200.0,
            desktop_notification=False,
        )
    )
    report = evaluate_dataset(dataset_dir, max_rows=100)

    assert report["split_policy"].startswith("sha256(run_id)")
    assert report["selection"]["selected_model"] in {
        "heading_baseline",
        "frequency_priors",
    }
    assert set(report["test"]) == {"heading_baseline", "frequency_priors"}
    assert split_for_run("same-run") == split_for_run("same-run")


def test_frequency_model_requires_validation_improvement():
    baseline = Metrics(
        branch_count=100,
        branch_top1_hits=70,
        branch_brier_sum=40.0,
    )
    better_calibration = Metrics(
        branch_count=100,
        branch_top1_hits=70,
        branch_brier_sum=35.0,
    )
    worse_accuracy = Metrics(
        branch_count=100,
        branch_top1_hits=60,
        branch_brier_sum=20.0,
    )

    assert select_frequency_model(baseline, better_calibration) is True
    assert select_frequency_model(baseline, worse_accuracy) is False
