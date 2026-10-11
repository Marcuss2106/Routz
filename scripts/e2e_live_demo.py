#!/usr/bin/env python3
"""Stream a moving synthetic train through the live services and print what the map sees.

Run while the three Python services are up (scripts/dev.sh, or start 8000, 8001,
and 8002 by hand). Only microphone audio and geometry reach the acoustic
service; the synthetic source position is hidden truth used for scoring.

Prints the first estimate that carries crossing predictions, every spoken
alert, and writes the last predictions to --dump for the route-conflict check.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from moving_source import moving_source

try:
    from websockets.asyncio.client import connect
except ImportError:  # websockets < 14
    from websockets import connect  # type: ignore[no-redef]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--acoustic-port", type=int, default=8001)
    parser.add_argument("--user-port", type=int, default=8002)
    parser.add_argument("--speed", type=float, default=20.0, help="acoustic-rail m/s")
    parser.add_argument("--snr", type=float, default=15.0)
    parser.add_argument("--dump", type=Path, help="write the first prediction-bearing event here")
    return parser.parse_args()


async def run(args: argparse.Namespace) -> None:
    simulation_id = "routz-live-demo"
    train = moving_source(simulation_id=simulation_id, speed_mps=args.speed, snr_db=args.snr)
    user_url = f"ws://{args.host}:{args.user_port}/ws/updates"
    acoustic_url = f"ws://{args.host}:{args.acoustic_port}/ws/simulation"
    events: list[dict[str, Any]] = []
    alerts: list[str] = []

    async with connect(user_url) as user_socket, connect(acoustic_url) as acoustic_socket:
        await acoustic_socket.send(json.dumps({"type": "simulation_reset", "simulation_id": simulation_id}))
        await acoustic_socket.recv()

        async def listen() -> None:
            async for raw in user_socket:
                message = json.loads(raw)
                if message.get("type") == "train_state_estimate":
                    events.append(message)
                elif message.get("type") == "route_update":
                    alerts.append(message["alert"]["text"])

        listener = asyncio.create_task(listen())
        for chunk in train.chunks:
            await acoustic_socket.send(chunk.model_dump_json(exclude_none=True))
            await acoustic_socket.recv()
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.5)
        listener.cancel()

    with_map = [event for event in events if event.get("map_state")]
    with_predictions = [event for event in events if event.get("predictions")]
    print(f"user WebSocket events: {len(events)}; with map_state: {len(with_map)}; "
          f"with predictions: {len(with_predictions)}")
    if with_predictions:
        first = with_predictions[0]
        state = first["map_state"]
        print(f"first prediction event: sequence={first['sequence']} status={first['status']} "
              f"map=({state['latitude']:.5f},{state['longitude']:.5f}) "
              f"speed={state['speed_mps']:.1f} m/s dir={state['direction_deg_from_east']:.0f} deg "
              f"length={state['length_m']} provisional={state['provisional_length_m']}")
        for prediction in first["predictions"]:
            print(f"  {prediction['roadName']:<12} {prediction['status']:<12} "
                  f"eta={prediction['etaSeconds']:>4}s clear={prediction['clearSeconds']:>4}s "
                  f"provisional={prediction['lengthProvisional']}")
        if args.dump:
            args.dump.write_text(json.dumps(first, indent=2))
    else:
        print("NO prediction-bearing estimates reached the user WebSocket")
    print("spoken alerts:")
    for text in dict.fromkeys(alerts):
        print(f"  {text}")


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
