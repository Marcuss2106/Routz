import asyncio
import math

from backend.config import settings
from backend.coordinates import CoordinateSystem
from backend.rail_network import RailNetwork
from backend.simulation import TrainSimulation


def make_network():
    coordinates = CoordinateSystem(settings.center_lat, settings.center_lon)
    return coordinates, RailNetwork(settings.data_path, coordinates)


def test_coordinate_round_trip():
    coordinates, _ = make_network()
    samples = [(-81.0348, 34.0007), (-80.98, 34.04), (-81.10, 33.96)]
    for longitude, latitude in samples:
        x, _, z = coordinates.wgs_to_scene(longitude, latitude)
        actual_lon, actual_lat = coordinates.scene_to_wgs(x, z)
        assert math.isclose(actual_lon, longitude, abs_tol=1e-8)
        assert math.isclose(actual_lat, latitude, abs_tol=1e-8)


def test_route_is_continuous_and_substantial():
    _, network = make_network()
    assert math.isclose(network.route_length_m, network.demo_route_length_m, abs_tol=0.1)
    assert network.route_length_m < 1000
    for left, right in zip(network.route_edges, network.route_edges[1:]):
        assert set((network.edges[left].start, network.edges[left].end)) & set(
            (network.edges[right].start, network.edges[right].end)
        )


def test_play_pause_restart_and_completion():
    _, network = make_network()
    simulation = TrainSimulation(network, speed_mps=20.0)

    async def scenario():
        initial = await simulation.snapshot()
        await simulation.command({"command": "play"})
        simulation._last_tick -= 1.0
        await simulation.tick()
        moving = await simulation.snapshot()
        assert moving["distance_along_route_m"] > initial["distance_along_route_m"]
        await simulation.command({"command": "pause"})
        paused_distance = (await simulation.snapshot())["distance_along_route_m"]
        simulation._last_tick -= 1.0
        await simulation.tick()
        assert (await simulation.snapshot())["distance_along_route_m"] == paused_distance
        await simulation.command({"command": "restart"})
        restarted = await simulation.snapshot()
        assert restarted["distance_along_route_m"] == simulation.train_length_m
        assert restarted["simulation_time_s"] == 0
        assert all(vehicle["distance_m"] >= 0 for vehicle in restarted["vehicles"])

    asyncio.run(scenario())
