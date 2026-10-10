"use client";

import { create } from "zustand";

import type { TrainStateEstimate } from "@/types/simulation";

interface SimulationState {
  isRunning: boolean;
  simulationTime: number;
  simulationSpeed: number;
  trainDirection: 1 | -1;
  noiseLevel: number;
  sourceEnabled: boolean;
  showWaves: boolean;
  showLinks: boolean;
  streamEnabled: boolean;
  socketStatus: "offline" | "connecting" | "open" | "error";
  selectedSensorId: "mic-1" | "mic-2" | "mic-3";
  latestEstimate: TrainStateEstimate | null;
  toggleRunning: () => void;
  advanceTime: (delta: number) => void;
  setSimulationSpeed: (speed: number) => void;
  setTrainDirection: (direction: 1 | -1) => void;
  setNoiseLevel: (level: number) => void;
  setSourceEnabled: (enabled: boolean) => void;
  setShowWaves: (visible: boolean) => void;
  setShowLinks: (visible: boolean) => void;
  setStreamEnabled: (enabled: boolean) => void;
  setSocketStatus: (status: SimulationState["socketStatus"]) => void;
  setSelectedSensorId: (sensorId: SimulationState["selectedSensorId"]) => void;
  setLatestEstimate: (estimate: TrainStateEstimate | null) => void;
  resetEpoch: number;
  reset: () => void;
}

const initialState = {
  isRunning: true,
  simulationTime: 0,
  simulationSpeed: 1,
  trainDirection: 1 as const,
  noiseLevel: 0.06,
  sourceEnabled: true,
  showWaves: true,
  showLinks: true,
  streamEnabled: false,
  socketStatus: "offline" as const,
  selectedSensorId: "mic-1" as const,
  latestEstimate: null,
};

export const useSimulationStore = create<SimulationState>((set) => ({
  ...initialState,
  toggleRunning: () => set((state) => ({ isRunning: !state.isRunning })),
  advanceTime: (delta) =>
    set((state) => ({ simulationTime: state.simulationTime + delta })),
  setSimulationSpeed: (simulationSpeed) => set({ simulationSpeed }),
  setTrainDirection: (trainDirection) => set({ trainDirection }),
  setNoiseLevel: (noiseLevel) => set({ noiseLevel }),
  setSourceEnabled: (sourceEnabled) => set({ sourceEnabled }),
  setShowWaves: (showWaves) => set({ showWaves }),
  setShowLinks: (showLinks) => set({ showLinks }),
  setStreamEnabled: (streamEnabled) => set({ streamEnabled }),
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  setSelectedSensorId: (selectedSensorId) => set({ selectedSensorId }),
  setLatestEstimate: (latestEstimate) => set({ latestEstimate }),
  resetEpoch: 0,
  reset: () =>
    set((state) => ({
      ...initialState,
      resetEpoch: state.resetEpoch + 1,
    })),
}));
