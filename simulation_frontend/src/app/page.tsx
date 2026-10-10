"use client";

import { useEffect, useMemo, useRef } from "react";

import { AudioWaveform } from "@/components/charts/AudioWaveform";
import { SimulationControls } from "@/components/controls/SimulationControls";
import { TrainScene } from "@/components/simulation/TrainScene";
import {
  SENSOR_DEFINITIONS,
  TRACK_LENGTH_M,
  getTrainState,
  simulateSensorReadings,
} from "@/lib/simulation";
import { useTrainAudioSource } from "@/lib/audioSource";
import {
  DEFAULT_SIMULATION_ID,
  buildMicrophoneAudioChunk,
  createSimulationSocket,
  type SimulationSocket,
} from "@/lib/websocket";
import { useSimulationStore } from "@/stores/simulationStore";
import type { TrainStateEstimate } from "@/types/simulation";

export default function Home() {
  const simulationTime = useSimulationStore((state) => state.simulationTime);
  const simulationSpeed = useSimulationStore((state) => state.simulationSpeed);
  const trainDirection = useSimulationStore((state) => state.trainDirection);
  const noiseLevel = useSimulationStore((state) => state.noiseLevel);
  const isRunning = useSimulationStore((state) => state.isRunning);
  const sourceEnabled = useSimulationStore((state) => state.sourceEnabled);
  const streamEnabled = useSimulationStore((state) => state.streamEnabled);
  const resetEpoch = useSimulationStore((state) => state.resetEpoch);
  const socketStatus = useSimulationStore((state) => state.socketStatus);
  const latestEstimate = useSimulationStore((state) => state.latestEstimate);
  const setSocketStatus = useSimulationStore((state) => state.setSocketStatus);
  const setLatestEstimate = useSimulationStore((state) => state.setLatestEstimate);
  const selectedSensorId = useSimulationStore((state) => state.selectedSensorId);
  const setSelectedSensorId = useSimulationStore(
    (state) => state.setSelectedSensorId,
  );
  const trainState = useMemo(
    () => getTrainState(simulationTime, simulationSpeed, trainDirection),
    [simulationTime, simulationSpeed, trainDirection],
  );
  const sourcePosition = trainState.position;
  const readings = useMemo(
    () => simulateSensorReadings(simulationTime, sourceEnabled, trainState, noiseLevel),
    [simulationTime, sourceEnabled, trainState, noiseLevel],
  );
  const selectedReading =
    readings.find((reading) => reading.sensorId === selectedSensorId) ?? readings[0];
  const audioSource = useTrainAudioSource();
  const socketRef = useRef<SimulationSocket | null>(null);
  const sequenceRef = useRef(0);
  const lastChunkTimeRef = useRef(-Infinity);

  useEffect(() => {
    if (!streamEnabled) {
      socketRef.current?.close();
      socketRef.current = null;
      return;
    }

    sequenceRef.current = 0;
    lastChunkTimeRef.current = -Infinity;
    const socket = createSimulationSocket({
      onStatus: setSocketStatus,
      onOpen: () => {
        sequenceRef.current = 0;
        lastChunkTimeRef.current = -Infinity;
        socketRef.current?.sendJson({
          type: "simulation_reset",
          simulation_id: DEFAULT_SIMULATION_ID,
        });
      },
      onMessage: (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "train_state_estimate"
        ) {
          setLatestEstimate(message as TrainStateEstimate);
        }
      },
    });
    socketRef.current = socket;
    return () => {
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [setLatestEstimate, setSocketStatus, streamEnabled]);

  useEffect(() => {
    sequenceRef.current = 0;
    lastChunkTimeRef.current = -Infinity;
    socketRef.current?.sendJson({
      type: "simulation_reset",
      simulation_id: DEFAULT_SIMULATION_ID,
    });
  }, [resetEpoch]);

  useEffect(() => {
    if (!streamEnabled || !isRunning || simulationTime - lastChunkTimeRef.current < 0.25) {
      return;
    }

    lastChunkTimeRef.current = simulationTime;
    const chunk = buildMicrophoneAudioChunk({
      sequence: sequenceRef.current,
      simulationTime,
      trainState,
      sourceEnabled,
      noiseLevel,
      audioSource,
    });
    if (socketRef.current?.sendChunk(chunk)) {
      sequenceRef.current += 1;
    }
  }, [
    isRunning,
    noiseLevel,
    simulationTime,
    sourceEnabled,
    streamEnabled,
    trainState,
    audioSource,
  ]);

  return (
    <main className="min-h-screen bg-[#050914] px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="mb-5 flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-cyan-300">
              <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_14px_#73e0ff]" />
              Routz / spatial audio lab
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              Three-sensor ground simulation
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              A moving train is sampled by three virtual microphones positioned on a
              simulated 2D ground plane. Orbit the scene to inspect the 3D layout.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-right text-xs">
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
              <div className="text-slate-500">Sensors</div>
              <div className="mt-1 text-lg font-semibold text-white">03</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
              <div className="text-slate-500">Dimensions</div>
              <div className="mt-1 text-lg font-semibold text-white">X / Y / Z</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
              <div className="text-slate-500">Clock</div>
              <div className="mt-1 text-lg font-semibold text-cyan-200">
                {simulationTime.toFixed(1)}s
              </div>
            </div>
          </div>
        </header>

        <SimulationControls />

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="relative h-[560px] overflow-hidden rounded-3xl border border-white/10 bg-[#07101e] shadow-2xl shadow-black/30 xl:h-[700px]">
            <div className="pointer-events-none absolute left-5 top-5 z-10 rounded-xl border border-white/10 bg-[#050914]/75 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-400 backdrop-blur">
              <div>Shared rail / {TRACK_LENGTH_M.toFixed(1)} m</div>
              <div className="mt-1 text-slate-600">x = east · z = north · y = elevation</div>
            </div>
            <TrainScene
              readings={readings}
              sourcePosition={sourcePosition}
              trainState={trainState}
            />
          </section>

          <aside className="space-y-4">
            <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-white">Sensor array</h2>
                  <p className="mt-1 text-xs text-slate-500">Select a node for telemetry</p>
                </div>
                <div className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-emerald-200">
                  Live
                </div>
              </div>
              <div className="space-y-2">
                {SENSOR_DEFINITIONS.map((sensor) => {
                  const reading = readings.find((item) => item.sensorId === sensor.id);
                  if (!reading) return null;
                  const isSelected = sensor.id === selectedSensorId;
                  return (
                    <button
                      type="button"
                      key={sensor.id}
                      onClick={() => setSelectedSensorId(sensor.id)}
                      className={`w-full rounded-2xl border p-3 text-left transition ${
                        isSelected
                          ? "border-white/20 bg-white/[0.09]"
                          : "border-white/5 bg-black/10 hover:border-white/15"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{
                              backgroundColor: sensor.color,
                              boxShadow: `0 0 12px ${sensor.color}`,
                            }}
                          />
                          <span className="text-xs font-semibold text-slate-200">{sensor.label}</span>
                        </div>
                        <span className="font-mono text-xs text-slate-400">{reading.decibels} dB</span>
                      </div>
                      <div className="mt-3 flex items-end justify-between">
                        <div className="font-mono text-[10px] text-slate-500">
                          x {sensor.position[0].toFixed(1)} · z {sensor.position[2].toFixed(1)}
                        </div>
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${reading.amplitude * 100}%`,
                              backgroundColor: sensor.color,
                            }}
                          />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {selectedReading && <AudioWaveform reading={selectedReading} />}

            <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4 text-xs">
              <div className="mb-3 text-[10px] uppercase tracking-[0.18em] text-slate-500">Spatial telemetry</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-slate-500">Source x</div>
                  <div className="mt-1 font-mono text-slate-200">{sourcePosition[0].toFixed(2)} m</div>
                </div>
                <div>
                  <div className="text-slate-500">Source z</div>
                  <div className="mt-1 font-mono text-slate-200">{sourcePosition[2].toFixed(2)} m</div>
                </div>
                <div>
                  <div className="text-slate-500">Train speed</div>
                  <div className="mt-1 font-mono text-slate-200">{trainState.speedMps.toFixed(2)} m/s</div>
                </div>
                <div>
                  <div className="text-slate-500">Selected range</div>
                  <div className="mt-1 font-mono text-slate-200">{selectedReading?.distance.toFixed(2)} m</div>
                </div>
                <div>
                  <div className="text-slate-500">Peak amplitude</div>
                  <div className="mt-1 font-mono text-slate-200">{selectedReading?.peak.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-slate-500">Stream</div>
                  <div className="mt-1 font-mono text-slate-200">{streamEnabled ? "enabled" : "local only"}</div>
                </div>
              </div>
              <div className="mt-3 border-t border-white/10 pt-3 text-[10px] text-slate-500">
                WebSocket: <span className="text-slate-300">{socketStatus}</span> · source: <span className="text-slate-300">{audioSource.status}</span>
              </div>
            </section>

            <section className="rounded-3xl border border-cyan-300/10 bg-cyan-300/[0.04] p-4 text-xs">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">Acoustic estimate</div>
                  <div className="mt-1 text-slate-500">Backend inference only</div>
                </div>
                <div className="font-mono text-[10px] text-cyan-200">
                  {latestEstimate?.status ?? "waiting"}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-slate-500">Speed</div>
                  <div className="mt-1 font-mono text-slate-200">
                    {latestEstimate?.speed_mps == null ? "—" : `${latestEstimate.speed_mps.toFixed(1)} m/s`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Length</div>
                  <div className="mt-1 font-mono text-slate-200">
                    {latestEstimate?.length_m == null ? "pending" : `${latestEstimate.length_m.toFixed(1)} m`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Direction</div>
                  <div className="mt-1 font-mono text-slate-200">
                    {latestEstimate?.direction_deg_from_east == null ? "—" : `${latestEstimate.direction_deg_from_east.toFixed(1)}°`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Position confidence</div>
                  <div className="mt-1 font-mono text-slate-200">
                    {latestEstimate == null ? "—" : `${Math.round(latestEstimate.confidence.position * 100)}%`}
                  </div>
                </div>
              </div>
              <div className="mt-3 border-t border-white/10 pt-3 text-[10px] text-slate-500">
                source: <span className="text-cyan-200">acoustic_array</span> · estimates are simulated
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
