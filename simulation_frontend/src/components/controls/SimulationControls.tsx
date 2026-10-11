"use client";

import { AudioLines, Eye, EyeOff, Map, Pause, Play, RotateCcw, Scan, TrainFront, Volume2, VolumeX } from "lucide-react";
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { createPleasantVoice, type PleasantVoice } from "@/lib/pleasantVoice";
import { formatDistance } from "@/lib/simulation";
import type { SimulationSocket } from "@/lib/websocket";
import { useSimulationStore } from "@/stores/simulationStore";

export function SimulationControls({ socketRef }: { socketRef: MutableRefObject<SimulationSocket | null> }) {
  const current = useSimulationStore((state) => state.current?.value);
  const railroad = useSimulationStore((state) => state.railroad);
  const connection = useSimulationStore((state) => state.connection);
  const audioConnection = useSimulationStore((state) => state.audioConnection);
  const cameraMode = useSimulationStore((state) => state.cameraMode);
  const showTruth = useSimulationStore((state) => state.showTruth);
  const audioPrediction = useSimulationStore((state) => state.audioPrediction);
  const [volume, setVolume] = useState(.35);
  const [voiceCues, setVoiceCues] = useState(false);
  const trainAudioRef = useRef<HTMLAudioElement | null>(null);
  const narratorRef = useRef<PleasantVoice | null>(null);
  const lastCueRef = useRef<string | null>(null);
  const running = current?.status === "running";
  const progress = current && railroad ? (current.distance_along_route_m / railroad.route.length_m) * 100 : 0;

  useEffect(() => {
    const narrator = createPleasantVoice();
    narratorRef.current = narrator;
    return () => {
      narrator?.dispose();
      narratorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const trainAudio = new Audio("/api/train-audio");
    trainAudio.loop = true;
    trainAudio.preload = "auto";
    trainAudio.volume = .35;
    trainAudioRef.current = trainAudio;
    return () => {
      trainAudio.pause();
      trainAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const trainAudio = trainAudioRef.current;
    if (!trainAudio) return;
    trainAudio.volume = volume;
    trainAudio.playbackRate = Math.min(2, Math.max(.5, current?.playback_speed ?? 1));
    if (!running) trainAudio.pause();
  }, [current?.playback_speed, running, volume]);

  const toggleSimulation = () => {
    socketRef.current?.send({ command: running ? "pause" : "play" });
    const trainAudio = trainAudioRef.current;
    if (!trainAudio) return;
    if (running) trainAudio.pause();
    else void trainAudio.play().catch(() => undefined);
  };

  const restartSimulation = () => {
    socketRef.current?.send({ command: "restart" });
    lastCueRef.current = null;
    if (trainAudioRef.current) {
      trainAudioRef.current.pause();
      trainAudioRef.current.currentTime = 0;
    }
  };

  const audioStatus = audioPrediction?.type === "train_state_estimate" ? audioPrediction.status : null;
  const audioCue = useMemo(() => {
    if (audioConnection === "connected") {
      if (audioStatus === "detected") return { key: "detected", text: "The acoustic array has detected a train." };
      if (audioStatus === "length_pending") return { key: "length_pending", text: "The train is being tracked. Its length estimate is settling." };
      if (audioStatus === "tracking") return { key: "tracking", text: "Acoustic tracking is stable." };
      if (audioStatus === "cleared") return { key: "cleared", text: "The train has cleared the microphone array." };
      return { key: "connected", text: "The three-microphone acoustic array is connected." };
    }
    if (audioConnection === "offline") return { key: "offline", text: "The acoustic array connection is offline." };
    return null;
  }, [audioConnection, audioStatus]);

  useEffect(() => {
    if (!voiceCues || !audioCue || !narratorRef.current || audioCue.key === lastCueRef.current) return;
    lastCueRef.current = audioCue.key;
    narratorRef.current.speak(audioCue.text);
  }, [audioCue, voiceCues]);

  const toggleVoiceCues = () => {
    const narrator = narratorRef.current;
    if (!narrator) return;
    if (voiceCues) {
      narrator.stop();
      lastCueRef.current = null;
      setVoiceCues(false);
      return;
    }
    // Let the opt-in confirmation finish before the current array state speaks.
    lastCueRef.current = audioCue?.key ?? null;
    setVoiceCues(true);
    narrator.speak("Voice cues are on.");
  };

  return (
    <section className="control-panel" aria-label="Train simulation controls">
      <div className="status-row"><span className={`connection-dot ${connection}`} /><span>{connection === "connected" ? "Live simulation" : connection}</span><span className="status-pill">{current?.status ?? "loading"}</span></div>
      <div className="train-readout">
        <span className="icon-box"><TrainFront size={19} /></span>
        <div><small>Train 001</small><strong>{current ? formatDistance(current.distance_along_route_m) : "—"}</strong></div>
        <div className="coordinates"><small>WGS84</small><span>{current ? `${current.latitude.toFixed(5)}, ${current.longitude.toFixed(5)}` : "Waiting for state"}</span></div>
      </div>
      <div className="progress-track"><span style={{ width: `${Math.min(100, progress)}%` }} /></div>
      <div className="button-row">
        <button className="primary-button" onClick={toggleSimulation} disabled={!current || connection !== "connected" || current.status === "completed"}>
          {running ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />} {running ? "Pause" : current?.status === "completed" ? "Completed" : "Play"}
        </button>
        <button className="icon-button" aria-label="Restart simulation" title="Restart" onClick={restartSimulation}><RotateCcw size={18} /></button>
        <button className={`camera-button ${cameraMode === "top" ? "active" : ""}`} aria-label="Top view" onClick={() => useSimulationStore.getState().setCameraMode("top")}><Map size={17} /> Top view</button>
        <button className={`camera-button ${cameraMode === "follow" ? "active" : ""}`} aria-label="Follow train from an isometric view" onClick={() => useSimulationStore.getState().setCameraMode("follow")}><Scan size={18} /> Follow</button>
        <button className={`camera-button ${showTruth ? "active" : ""}`} aria-label="Toggle simulator truth" onClick={() => useSimulationStore.getState().setShowTruth(!showTruth)}>{showTruth ? <EyeOff size={16} /> : <Eye size={16} />} {showTruth ? "Hide truth" : "Show truth"}</button>
        <button className={`camera-button ${voiceCues ? "active" : ""}`} aria-label="Toggle pleasant voice cues" aria-pressed={voiceCues} onClick={toggleVoiceCues}><AudioLines size={16} /> {voiceCues ? "Voice on" : "Voice cues"}</button>
        <button className="text-button" onClick={() => useSimulationStore.getState().resetCamera()}>Overview</button>
      </div>
      <div className="estimate-note">
        {audioPrediction?.type === "train_state_estimate" && audioPrediction.status !== "unknown" && audioPrediction.track_position_m != null
          ? `Visible train: acoustic estimate · ${audioPrediction.status.replaceAll("_", " ")}`
          : current
            ? `Visible train: live simulation fallback · ${audioPrediction?.type === "ingest_error" ? "acoustic ingest error" : "acoustic warming up"}`
            : "Visible train: waiting for simulation state"}
      </div>
      <div className="control-settings">
        <label className="volume-control">
          {volume > 0 ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span>Train audio</span>
          <input aria-label="Train audio volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
        </label>
        <label className="speed-control"><span>Playback speed</span><select value={current?.playback_speed ?? 1} onChange={(event) => socketRef.current?.send({ command: "set_playback_speed", value: Number(event.target.value) })}>{[0.5, 1, 2, 4, 8].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
      </div>
    </section>
  );
}
