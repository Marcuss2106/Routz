"use client";

import {
  ArrowLeftRight,
  Link,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Waves,
} from "lucide-react";

import { useSimulationStore } from "@/stores/simulationStore";

export function SimulationControls() {
  const isRunning = useSimulationStore((state) => state.isRunning);
  const simulationSpeed = useSimulationStore((state) => state.simulationSpeed);
  const trainDirection = useSimulationStore((state) => state.trainDirection);
  const noiseLevel = useSimulationStore((state) => state.noiseLevel);
  const sourceEnabled = useSimulationStore((state) => state.sourceEnabled);
  const streamEnabled = useSimulationStore((state) => state.streamEnabled);
  const socketStatus = useSimulationStore((state) => state.socketStatus);
  const showWaves = useSimulationStore((state) => state.showWaves);
  const showLinks = useSimulationStore((state) => state.showLinks);
  const toggleRunning = useSimulationStore((state) => state.toggleRunning);
  const setSimulationSpeed = useSimulationStore(
    (state) => state.setSimulationSpeed,
  );
  const setTrainDirection = useSimulationStore((state) => state.setTrainDirection);
  const setNoiseLevel = useSimulationStore((state) => state.setNoiseLevel);
  const setSourceEnabled = useSimulationStore((state) => state.setSourceEnabled);
  const setShowWaves = useSimulationStore((state) => state.setShowWaves);
  const setShowLinks = useSimulationStore((state) => state.setShowLinks);
  const setStreamEnabled = useSimulationStore((state) => state.setStreamEnabled);
  const reset = useSimulationStore((state) => state.reset);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2">
      <button
        type="button"
        onClick={toggleRunning}
        className="inline-flex h-9 items-center gap-2 rounded-xl bg-white px-3 text-xs font-semibold text-slate-950 transition hover:bg-cyan-100"
      >
        {isRunning ? <Pause size={14} /> : <Play size={14} />}
        {isRunning ? "Pause" : "Run"}
      </button>
      <label className="flex h-9 items-center gap-2 rounded-xl border border-white/10 px-3 text-xs text-slate-300">
        Speed
        <select
          value={simulationSpeed}
          onChange={(event) => setSimulationSpeed(Number(event.target.value))}
          className="bg-transparent font-semibold text-white outline-none"
          aria-label="Simulation speed"
        >
          <option value={0.5} className="bg-slate-900">
            0.5×
          </option>
          <option value={1} className="bg-slate-900">
            1×
          </option>
          <option value={2} className="bg-slate-900">
            2×
          </option>
        </select>
      </label>
      <button
        type="button"
        onClick={() => setTrainDirection(trainDirection === 1 ? -1 : 1)}
        className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 px-3 text-xs text-slate-300 transition hover:border-white/20 hover:text-white"
        title="Reverse train direction"
      >
        <ArrowLeftRight size={14} />
        {trainDirection === 1 ? "Eastbound" : "Westbound"}
      </button>
      <label className="flex h-9 items-center gap-2 rounded-xl border border-white/10 px-3 text-xs text-slate-300">
        Noise
        <select
          value={noiseLevel}
          onChange={(event) => setNoiseLevel(Number(event.target.value))}
          className="bg-transparent font-semibold text-white outline-none"
          aria-label="Microphone noise level"
        >
          <option value={0} className="bg-slate-900">Off</option>
          <option value={0.06} className="bg-slate-900">Low</option>
          <option value={0.14} className="bg-slate-900">High</option>
        </select>
      </label>
      <button
        type="button"
        onClick={() => setSourceEnabled(!sourceEnabled)}
        className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs transition ${
          sourceEnabled
            ? "border-rose-300/40 bg-rose-300/10 text-rose-100"
            : "border-white/10 text-slate-400"
        }`}
      >
        <Radio size={14} />
        Source {sourceEnabled ? "on" : "off"}
      </button>
      <button
        type="button"
        onClick={() => setShowWaves(!showWaves)}
        className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs transition ${
          showWaves
            ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100"
            : "border-white/10 text-slate-400"
        }`}
      >
        <Waves size={14} />
        Waves
      </button>
      <button
        type="button"
        onClick={() => setShowLinks(!showLinks)}
        className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs transition ${
          showLinks
            ? "border-violet-300/40 bg-violet-300/10 text-violet-100"
            : "border-white/10 text-slate-400"
        }`}
      >
        Links
      </button>
      <button
        type="button"
        onClick={() => setStreamEnabled(!streamEnabled)}
        className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs transition ${
          streamEnabled
            ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-100"
            : "border-white/10 text-slate-400"
        }`}
        title="Send synchronized microphone chunks to the simulation backend"
      >
        <Link size={14} />
        Stream {streamEnabled ? socketStatus : "off"}
      </button>
      <button
        type="button"
        onClick={reset}
        className="ml-auto inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 px-3 text-xs text-slate-400 transition hover:border-white/20 hover:text-white"
        aria-label="Reset simulation"
      >
        <RotateCcw size={14} />
        Reset
      </button>
    </div>
  );
}
