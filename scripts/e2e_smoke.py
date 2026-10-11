#!/usr/bin/env python3
"""Exercise the live microphone -> estimate -> user WebSocket path.

Run this while scripts/dev.sh is running. The synthetic source position is
used only to generate the test microphone capture and to check the resulting
localization; it is never included in a message sent to the acoustic service.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request
from pathlib import Path
from typing import Any, Callable

import numpy as np

try:
    from websockets.asyncio.client import connect
except ImportError:  # websockets < 14
    from websockets import connect  # type: ignore[no-redef]


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SIMULATION_ROOT = PROJECT_ROOT / "simulation_backend"
sys.path.insert(0, str(SIMULATION_ROOT))
sys.path.insert(0, str(SIMULATION_ROOT / "tests"))

from app.geometry import MICROPHONES  # noqa: E402
from synthetic_audio import chunks_from_window, synthesize_window  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--rail-port", type=int, default=8000)
    parser.add_argument("--acoustic-port", type=int, default=8001)
    parser.add_argument("--user-port", type=int, default=8002)
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--source-s", type=float, default=80.0)
    return parser.parse_args()


def health(host: str, port: int) -> dict[str, Any]:
    with urllib.request.urlopen(f"http://{host}:{port}/health", timeout=3) as response:
        payload = json.load(response)
    if payload.get("status") != "ok":
        raise RuntimeError(f"health check failed on port {port}: {payload}")
    return payload


async def next_matching(
    socket: Any,
    predicate: Callable[[dict[str, Any]], bool],
    timeout: float,
    description: str,
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"timed out waiting for {description}")
        raw = await asyncio.wait_for(socket.recv(), timeout=remaining)
        message = json.loads(raw)
        if isinstance(message, dict) and predicate(message):
            return message


def assert_microphone_only(payload: dict[str, Any]) -> None:
    forbidden = {
        "train_state",
        "train_position_m",
        "train_speed_mps",
        "train_length_m",
        "true_position_m",
        "true_speed_mps",
        "ground_truth",
    }
    leaked = forbidden.intersection(payload)
    if leaked:
        raise AssertionError(f"ground truth leaked into audio payload: {sorted(leaked)}")
    if payload.get("type") != "microphone_audio_chunk":
        raise AssertionError("smoke test generated the wrong message type")
    microphones = payload.get("microphones")
    if not isinstance(microphones, list) or len(microphones) != len(MICROPHONES):
        raise AssertionError("smoke test did not generate three microphone channels")


async def run(args: argparse.Namespace) -> None:
    for port in (args.rail_port, args.acoustic_port, args.user_port):
        health(args.host, port)

    simulation_id = "routz-e2e-smoke"
    acoustic_url = f"ws://{args.host}:{args.acoustic_port}/ws/simulation"
    user_url = f"ws://{args.host}:{args.user_port}/ws/updates"
    source_positions = [args.source_s + offset for offset in (0.0, 10.0, 20.0)]
    payloads: list[dict[str, Any]] = []
    sequence = 0
    for window_index, source_s in enumerate(source_positions):
        channels = synthesize_window(
            source_s,
            t0_s=1.0 + window_index * 1.25,
            duration_s=1.25,
            snr_db=20.0,
            rng=np.random.default_rng(20261010 + window_index),
        )
        chunks = chunks_from_window(
            channels,
            t0_s=1.0 + window_index * 1.25,
            simulation_id=simulation_id,
            sequence_start=sequence,
        )
        payloads.extend(chunk.model_dump(mode="json", exclude_none=True) for chunk in chunks)
        sequence += len(chunks)
    for payload in payloads:
        assert_microphone_only(payload)

    async with connect(user_url, open_timeout=args.timeout) as user_socket:
        async with connect(acoustic_url, open_timeout=args.timeout) as acoustic_socket:
            reset = {"type": "simulation_reset", "simulation_id": simulation_id}
            await acoustic_socket.send(json.dumps(reset))
            acoustic_ack = await next_matching(
                acoustic_socket,
                lambda message: message.get("type") == "simulation_reset_ack"
                and message.get("simulation_id") == simulation_id,
                args.timeout,
                "acoustic reset acknowledgement",
            )
            await next_matching(
                user_socket,
                lambda message: message.get("type") == "simulation_reset"
                and message.get("simulation_id") == simulation_id,
                args.timeout,
                "user-backend reset broadcast",
            )

            acoustic_estimates: list[dict[str, Any]] = []
            for payload in payloads:
                await acoustic_socket.send(json.dumps(payload))
                response = json.loads(await asyncio.wait_for(acoustic_socket.recv(), args.timeout))
                if response.get("type") == "train_state_estimate":
                    acoustic_estimates.append(response)

            if len(acoustic_estimates) < 3:
                raise AssertionError("acoustic backend did not produce an estimate")
            acoustic_estimate = acoustic_estimates[-1]
            user_estimate = await next_matching(
                user_socket,
                lambda message: message.get("type") == "train_state_estimate"
                and message.get("simulation_id") == simulation_id
                and int(message.get("sequence", -1)) == int(acoustic_estimate["sequence"]),
                args.timeout,
                "canonical estimate on user WebSocket",
            )

            for message in (acoustic_estimate, user_estimate):
                if message.get("source") != "acoustic_array":
                    raise AssertionError(f"estimate source is not acoustic: {message}")
                if "audio" in message or "train_position_m" in message:
                    raise AssertionError("audio or simulator truth reached estimate output")
                for field in ("latitude", "longitude", "speed_mps", "direction_deg_from_east"):
                    if message.get(field) is None:
                        raise AssertionError(f"estimate is missing {field}: {message}")

            estimated_s = float(acoustic_estimate.get("track_position_m", 0.0))
            expected_s = source_positions[-1]
            if abs(estimated_s - expected_s) > 12.0:
                raise AssertionError(
                    f"live localization error exceeded 12 m: estimated={estimated_s:.2f}, "
                    f"source={expected_s:.2f}"
                )
            if acoustic_estimate.get("direction_deg_from_east") is None:
                raise AssertionError("moving synthetic source did not produce direction")

            await acoustic_socket.send(json.dumps(reset))
            await next_matching(
                acoustic_socket,
                lambda message: message.get("type") == "simulation_reset_ack"
                and message.get("simulation_id") == simulation_id,
                args.timeout,
                "second acoustic reset acknowledgement",
            )
            await next_matching(
                user_socket,
                lambda message: message.get("type") == "simulation_reset"
                and message.get("simulation_id") == simulation_id,
                args.timeout,
                "second user-backend reset broadcast",
            )

            restarted = dict(payloads[0])
            restarted["sequence"] = 0
            restarted["simulation_time_s"] = 10.0
            await acoustic_socket.send(json.dumps(restarted))
            restarted_response = json.loads(
                await asyncio.wait_for(acoustic_socket.recv(), args.timeout)
            )
            if restarted_response.get("type") != "train_state_estimate":
                raise AssertionError(f"sequence 0 was not accepted after reset: {restarted_response}")
            await next_matching(
                user_socket,
                lambda message: message.get("type") == "train_state_estimate"
                and message.get("simulation_id") == simulation_id
                and int(message.get("sequence", -1)) == 0,
                args.timeout,
                "sequence 0 after reset on user WebSocket",
            )

    print(
        "E2E smoke passed: "
        f"{len(acoustic_estimates)} acoustic estimates, "
        f"live position {estimated_s:.1f} m for synthetic source {source_positions[-1]:.1f} m, "
        f"reset accepted sequence 0 (ack={acoustic_ack['type']})"
    )


def main() -> None:
    args = parse_args()
    try:
        asyncio.run(run(args))
    except Exception as exc:
        print(f"E2E smoke failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
