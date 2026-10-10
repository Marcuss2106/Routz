import { create } from "zustand";
import type { AudioPrediction, CameraMode, ConnectionState, RailroadPayload, SensorReading, TrainState } from "@/types/simulation";

interface Snapshot { value: TrainState; receivedAt: number }

interface SimulationStore {
  railroad: RailroadPayload | null;
  current: Snapshot | null;
  previous: Snapshot | null;
  connection: ConnectionState;
  error: string | null;
  cameraMode: CameraMode;
  cameraReset: number;
  audioConnection: ConnectionState;
  audioPrediction: AudioPrediction | null;
  sensorReadings: SensorReading[];
  setRailroad: (railroad: RailroadPayload) => void;
  pushState: (state: TrainState) => void;
  setConnection: (connection: ConnectionState) => void;
  setError: (error: string | null) => void;
  setCameraMode: (mode: CameraMode) => void;
  setAudioConnection: (connection: ConnectionState) => void;
  setAudioPrediction: (prediction: AudioPrediction | null) => void;
  setSensorReadings: (readings: SensorReading[]) => void;
  resetCamera: () => void;
}

export const useSimulationStore = create<SimulationStore>((set) => ({
  railroad: null,
  current: null,
  previous: null,
  connection: "connecting",
  error: null,
  cameraMode: "overview",
  cameraReset: 0,
  audioConnection: "connecting",
  audioPrediction: null,
  sensorReadings: [],
  setRailroad: (railroad) => set({ railroad }),
  pushState: (value) => set((store) => ({ previous: store.current, current: { value, receivedAt: performance.now() } })),
  setConnection: (connection) => set({ connection }),
  setError: (error) => set({ error }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setAudioConnection: (audioConnection) => set({ audioConnection }),
  setAudioPrediction: (audioPrediction) => set({ audioPrediction }),
  setSensorReadings: (sensorReadings) => set({ sensorReadings }),
  resetCamera: () => set((store) => ({ cameraReset: store.cameraReset + 1, cameraMode: "overview" })),
}));
