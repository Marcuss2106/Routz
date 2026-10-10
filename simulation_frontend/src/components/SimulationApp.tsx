"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef } from "react";
import { AudioLines, LoaderCircle } from "lucide-react";
import { SimulationControls } from "@/components/controls/SimulationControls";
import { loadRailroad, SimulationSocket } from "@/lib/websocket";
import { AudioSimulationSocket, buildAudioChunk } from "@/lib/audioWebsocket";
import { useTrainAudioSource } from "@/lib/audioSource";
import { getAudioSensors, simulateSensorReadings } from "@/lib/simulation";
import { useSimulationStore } from "@/stores/simulationStore";

const TrainScene = dynamic(() => import("@/components/simulation/TrainScene"), {
  ssr: false,
  loading: () => <div className="scene-message"><LoaderCircle className="spin" /> Preparing 3D renderer…</div>,
});

export default function SimulationApp() {
  const railroad = useSimulationStore((state) => state.railroad);
  const error = useSimulationStore((state) => state.error);
  const current = useSimulationStore((state) => state.current?.value);
  const audioConnection = useSimulationStore((state) => state.audioConnection);
  const sensorReadings = useSimulationStore((state) => state.sensorReadings);
  const audioPrediction = useSimulationStore((state) => state.audioPrediction);
  const socketRef = useRef<SimulationSocket | null>(null);
  const audioSocketRef = useRef<AudioSimulationSocket | null>(null);
  const sequenceRef = useRef(0);
  const nextAudioTimeRef = useRef(0);
  const audioSource = useTrainAudioSource();
  const sensors = useMemo(
    () => getAudioSensors(railroad?.route.length_m ?? 800),
    [railroad?.route.length_m],
  );

  useEffect(() => {
    const controller = new AbortController();
    const store = useSimulationStore.getState();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const loadWithRetry = () => {
      loadRailroad(controller.signal)
        .then((payload) => {
          store.setRailroad(payload);
          store.setError(null);
        })
        .catch((cause: Error) => {
          if (cause.name === "AbortError") return;
          store.setError(cause.message);
          retryTimer = setTimeout(loadWithRetry, 2000);
        });
    };
    loadWithRetry();
    const socket = new SimulationSocket({
      onState: store.pushState,
      onConnection: (connection) => {
        store.setConnection(connection);
        if (connection === "connected") store.setError(null);
      },
      onError: store.setError,
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      socket.close();
    };
  }, []);

  useEffect(() => {
    const store = useSimulationStore.getState();
    const socket = new AudioSimulationSocket(store.setAudioConnection, store.setAudioPrediction);
    audioSocketRef.current = socket;
    socket.connect();
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (!current || !railroad) return;
    const store = useSimulationStore.getState();
    store.setSensorReadings(simulateSensorReadings(current, sensors));
    if (current.simulation_time_s + .001 < nextAudioTimeRef.current - .25) {
      sequenceRef.current = 0;
      nextAudioTimeRef.current = 0;
      audioSocketRef.current?.reset();
    }
    if (current.status !== "running") return;
    let chunksSent = 0;
    while (nextAudioTimeRef.current <= current.simulation_time_s + .001 && chunksSent < 8) {
      const sampleTime = nextAudioTimeRef.current;
      const sampledState = {
        ...current,
        simulation_time_s: sampleTime,
        distance_along_route_m: Math.max(
          current.train_length_m,
          current.distance_along_route_m - current.speed_mps * (current.simulation_time_s - sampleTime),
        ),
      };
      const chunk = buildAudioChunk(
        sequenceRef.current,
        sampledState,
        sensors,
        audioSource,
        railroad.route.length_m,
      );
      if (!audioSocketRef.current?.send(chunk)) break;
      sequenceRef.current += 1;
      nextAudioTimeRef.current += .25;
      chunksSent += 1;
    }
  }, [audioSource, current, railroad, sensors]);

  return (
    <main className="app-shell">
      <header className="brand"><div className="brand-mark" aria-hidden="true"><span /><span /></div><div><p>Columbia rail study</p><h1>Routz</h1></div></header>
      <aside className="location-card"><span className="eyebrow">South Carolina · 10 mile radius</span><strong>Downtown Columbia</strong><span>34.0007° N · 81.0348° W</span></aside>
      <aside className="sensor-card">
        <div className="sensor-card-heading"><AudioLines size={15} /><span>Acoustic array</span><em className={audioConnection}>{audioConnection === "connected" ? (audioPrediction?.type === "train_state_estimate" ? audioPrediction.status : audioPrediction?.type === "ingest_error" ? "ingest error" : "warming up") : audioConnection}</em></div>
        {sensors.map((sensor) => {
          const reading = sensorReadings.find((item) => item.sensorId === sensor.id);
          return <div className="sensor-row" key={sensor.id}><i style={{ background: sensor.color }} /><span>{sensor.label}</span><strong>{reading ? `${reading.decibels} dB` : "—"}</strong></div>;
        })}
        {audioPrediction?.type === "train_state_estimate" && <>
          <div className="sensor-row"><i style={{ background: "#a94334" }} /><span>Position</span><strong>{audioPrediction.track_position_m == null ? "—" : `${audioPrediction.track_position_m.toFixed(1)} m`}</strong></div>
          <div className="sensor-row"><i style={{ background: "#a94334" }} /><span>Speed / direction</span><strong>{audioPrediction.speed_mps == null ? "—" : `${audioPrediction.speed_mps.toFixed(1)} m/s · ${audioPrediction.direction_deg_from_east?.toFixed(0) ?? "—"}°`}</strong></div>
          <div className="sensor-row"><i style={{ background: "#a94334" }} /><span>Length</span><strong>{audioPrediction.length_m == null ? "pending" : `${audioPrediction.length_m.toFixed(1)} m`}</strong></div>
        </>}
      </aside>
      {!railroad && !error && <div className="scene-message"><LoaderCircle className="spin" /> Loading SCDOT rail geometry…</div>}
      {error && !railroad && <div className="scene-message error"><strong>Unable to load the network</strong><span>{error}</span></div>}
      {railroad && <TrainScene />}
      <SimulationControls socketRef={socketRef} />
      <footer className="source-note">Real SCDOT geometry · Simulation, not for emergency use</footer>
    </main>
  );
}
