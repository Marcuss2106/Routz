import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .coordinates import CoordinateSystem
from .rail_network import RailNetwork
from .simulation import TrainSimulation


coordinates = CoordinateSystem(settings.center_lat, settings.center_lon)
network = RailNetwork(settings.data_path, coordinates)
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
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "data_loaded": True, "route_length_m": network.route_length_m}


@app.get("/api/railroad")
async def railroad() -> dict:
    return network.payload()


@app.get("/api/train")
async def train() -> dict:
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
