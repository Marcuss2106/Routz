import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .coordinates import CoordinateSystem
from .geographic_layers import GeographicLayers
from .rail_network import RailNetwork
from .simulation import TrainSimulation


coordinates = CoordinateSystem(settings.center_lat, settings.center_lon)
network = RailNetwork(settings.data_path, coordinates)
geographic_layers = GeographicLayers(settings.road_data_path, coordinates, network)
simulation = TrainSimulation(network, settings.base_speed_mps)


async def ticker() -> None:
    while True:
        await simulation.tick()
        await asyncio.sleep(0.1)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(ticker())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="Routez Railroad Simulation", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "data_loaded": True,
        "route_length_m": network.route_length_m,
        "road_count": len(geographic_layers.roads),
        "road_radius_m": geographic_layers.source_metadata.get("radius_m"),
        "road_source": geographic_layers.source_metadata.get("source"),
        "ground_crossing_count": len(geographic_layers.crossings),
    }


@app.get("/api/railroad")
async def railroad() -> dict:
    return {**network.payload(), **geographic_layers.payload()}


@app.get("/api/train")
async def train() -> dict:
    return await simulation.snapshot()


@app.post("/api/command")
async def command(message: dict) -> dict:
    """REST fallback for the WebSocket play/pause/restart commands.

    Lets the simulation frontend drive the shared clock over plain HTTPS when
    the browser blocks the wss:// upgrade (content blocker, proxy, or stalled
    TLS). Returns the fresh snapshot so polling clients stay in sync.
    """
    try:
        await simulation.command(message)
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return await simulation.snapshot()


@app.websocket("/ws/simulation")
async def websocket_simulation(socket: WebSocket) -> None:
    await socket.accept()
    try:
        while True:
            await socket.send_json(await simulation.snapshot())
            try:
                message = await asyncio.wait_for(socket.receive_json(), timeout=0.1)
                try:
                    await simulation.command(message)
                except (ValueError, TypeError) as error:
                    await socket.send_json({"type": "command_error", "message": str(error)})
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        return


def run() -> None:
    import uvicorn

    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
