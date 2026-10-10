import asyncio
import time

from .rail_network import RailNetwork


class TrainSimulation:
    train_id = "train-columbia-001"
    route_id = "columbia-audio-demo-corridor"
    vehicle_offsets_m = [0.0, 44.0, 80.0, 116.0, 152.0, 188.0]
    train_length_m = 210.0

    def __init__(self, network: RailNetwork, speed_mps: float):
        self.network = network
        self.base_speed_mps = speed_mps
        self.playback_speed = 1.0
        self.distance_m = self.train_length_m
        self.simulation_time_s = 0.0
        self.sequence = 0
        self.status = "paused"
        self._last_tick = time.monotonic()
        self._lock = asyncio.Lock()

    async def tick(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = min(now - self._last_tick, 0.5)
            self._last_tick = now
            if self.status == "running":
                step = elapsed * self.playback_speed
                self.simulation_time_s += step
                self.distance_m = min(
                    self.network.route_length_m,
                    self.distance_m + self.base_speed_mps * step,
                )
                if self.distance_m >= self.network.route_length_m:
                    self.status = "completed"
            self.sequence += 1

    async def command(self, message: dict) -> None:
        async with self._lock:
            command = message.get("command")
            if command == "play" and self.status != "completed":
                self.status = "running"
            elif command == "pause" and self.status == "running":
                self.status = "paused"
            elif command == "restart":
                self.distance_m = self.train_length_m
                self.simulation_time_s = 0.0
                self.status = "paused"
            elif command == "set_playback_speed":
                value = float(message.get("value", 1.0))
                if not 0.25 <= value <= 8.0:
                    raise ValueError("playback speed must be between 0.25 and 8")
                self.playback_speed = value
            else:
                raise ValueError(f"unsupported command: {command}")
            self._last_tick = time.monotonic()

    async def snapshot(self) -> dict:
        async with self._lock:
            lead = self.network.point_at(self.distance_m)
            vehicles = [
                {
                    "id": "locomotive" if index == 0 else f"wagon-{index}",
                    **self.network.point_at(self.distance_m - offset),
                }
                for index, offset in enumerate(self.vehicle_offsets_m)
            ]
            return {
                "type": "train_state",
                "train_id": self.train_id,
                "sequence": self.sequence,
                "simulation_time_s": self.simulation_time_s,
                "status": self.status,
                "route_id": self.route_id,
                "distance_along_route_m": self.distance_m,
                "speed_mps": self.base_speed_mps if self.status == "running" else 0.0,
                "playback_speed": self.playback_speed,
                "latitude": lead["latitude"],
                "longitude": lead["longitude"],
                "scene_position": lead["scene"],
                "heading_deg": lead["heading_deg"],
                "train_length_m": self.train_length_m,
                "vehicles": vehicles,
            }
