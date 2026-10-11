"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef } from "react";
import { AudioLines, LoaderCircle } from "lucide-react";
import { SimulationControls } from "@/components/controls/SimulationControls";
import { JunctionPrediction } from "@/components/JunctionPrediction";
import { loadRailroad, SimulationSocket, getMixedContentHint, getSimulationApiUrl, getSimulationWsUrl } from "@/lib/websocket";
import { AudioSimulationSocket, buildAudioChunk, getAudioWsUrl } from "@/lib/audioWebsocket";
import { useTrainAudioSource } from "@/lib/audioSource";
import { acousticSToRouteDistance, getAudioSensors, mapRouteDistanceToAcousticS, simulateSensorReadings } from "@/lib/simulation";
import { buildTrafficCars } from "@/lib/traffic";
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
  const trafficCars = useMemo(
    () => railroad ? buildTrafficCars(railroad.roads ?? [], railroad.route.points) : [],
    [railroad],
  );
  const acousticEstimate = audioPrediction?.type === "train_state_estimate" ? audioPrediction : null;
  const fallbackPositionM = current && railroad
    ? mapRouteDistanceToAcousticS(current.distance_along_route_m, railroad.route.length_m)
    : null;
  const fallbackDirectionDeg = current
    ? ((90 - current.heading_deg) % 360 + 360) % 360
    : null;
  const displayedPositionM = acousticEstimate?.track_position_m ?? fallbackPositionM;
  const displayedSpeedMps = acousticEstimate?.speed_mps ?? current?.speed_mps ?? null;
  const displayedDirectionDeg = acousticEstimate?.direction_deg_from_east ?? fallbackDirectionDeg;
  const positionIsFallback = acousticEstimate?.track_position_m == null && fallbackPositionM != null;
  const motionIsFallback = (
    acousticEstimate?.speed_mps == null || acousticEstimate?.direction_deg_from_east == null
  ) && current != null;
  const displayedRouteDistanceM = railroad && acousticEstimate?.track_position_m != null
    ? acousticSToRouteDistance(acousticEstimate.track_position_m, railroad.route.length_m)
    : current?.distance_along_route_m ?? 0;

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
    store.setSensorReadings(simulateSensorReadings(current, sensors, trafficCars));
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
        trafficCars,
      );
      if (!audioSocketRef.current?.send(chunk)) break;
      sequenceRef.current += 1;
      nextAudioTimeRef.current += .25;
      chunksSent += 1;
    }
  }, [audioSource, current, railroad, sensors, trafficCars]);

  return (
    <main className="app-shell">
      <header className="brand"><div className="brand-mark" aria-hidden="true"><span /><span /></div><div><p>Columbia rail study</p><h1>Routz</h1></div></header>
      <aside className="location-card"><span className="eyebrow">South Carolina · 10 mile radius</span><strong>Downtown Columbia</strong><span>34.0007° N · 81.0348° W</span></aside>
      <aside className="sensor-card">
        <div className="sensor-card-heading"><AudioLines size={15} /><span>Acoustic array</span><em className={audioConnection}>{audioConnection === "connected" ? (audioPrediction?.type === "train_state_estimate" ? (audioPrediction.status === "unknown" ? "warming up" : audioPrediction.status.replaceAll("_", " ")) : audioPrediction?.type === "ingest_error" ? "ingest error" : "warming up") : audioConnection}</em></div>
        {sensors.map((sensor) => {
          const reading = sensorReadings.find((item) => item.sensorId === sensor.id);
          return <div className="sensor-row" key={sensor.id}><i style={{ background: sensor.color }} /><span>{sensor.label}</span><strong>{reading ? `${reading.decibels} dB` : "—"}</strong></div>;
        })}
        {(audioPrediction?.type === "train_state_estimate" || current) && <>
          <div className="sensor-row"><i style={{ background: "#a94334" }} /><span>Position</span><strong>{displayedPositionM == null ? "—" : `${displayedPositionM.toFixed(1)} m${positionIsFallback ? " · simulation" : ""}`}</strong></div>
          <div className="sensor-row"><i style={{ background: "#a94334" }} /><span>Speed / direction</span><strong>{displayedSpeedMps == null || displayedDirectionDeg == null ? "—" : `${displayedSpeedMps.toFixed(1)} m/s · ${displayedDirectionDeg.toFixed(0)}°${motionIsFallback ? " · simulation" : ""}`}</strong></div>
          {audioPrediction?.type === "train_state_estimate" && <>
          <div className="sensor-row"><i style={{ background: "#a94334" }} /><span>Length</span><strong>{audioPrediction.length_m == null ? `${audioPrediction.provisional_length_m?.toFixed(1) ?? "—"} m provisional` : `${audioPrediction.length_m.toFixed(1)} m stable`}</strong></div>
          <div className="sensor-row"><i style={{ background: "#a94334" }} /><span>Confidence / ±position</span><strong>{Math.round(audioPrediction.confidence.position * 100)}% · {audioPrediction.uncertainty.position_m == null ? "—" : `${audioPrediction.uncertainty.position_m.toFixed(1)} m`}</strong></div>
          </>}
        </>}
        {railroad && current && <JunctionPrediction
          railroad={railroad}
          routeDistanceM={displayedRouteDistanceM}
          positionConfidence={acousticEstimate?.confidence.position ?? 0}
          directionConfidence={acousticEstimate?.confidence.direction ?? 0}
          usingSimulationFallback={positionIsFallback || motionIsFallback}
        />}
      </aside>
      {!railroad && !error && <div className="scene-message"><LoaderCircle className="spin" /> Loading SCDOT rail geometry…</div>}
      {error && !railroad && <div className="scene-message error"><strong>Unable to load the network</strong><span>{error}</span><span style={{ fontSize: 12, opacity: 0.85 }}>API {getSimulationApiUrl()} · WS {getSimulationWsUrl()} · Audio {getAudioWsUrl()}</span>{getMixedContentHint() && <span style={{ fontSize: 12 }}>{getMixedContentHint()}</span>}</div>}
      {railroad && <TrainScene trafficCars={trafficCars} />}
      <SimulationControls socketRef={socketRef} />
      <footer className="source-note">SCDOT rail · © OpenStreetMap contributors · Simulation, not for emergency use</footer>
    </main>
  );
}
