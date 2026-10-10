"use client";

import { create } from "zustand";

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
  selectedSensorId: "north" | "east" | "west";
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
  selectedSensorId: "north" as const,
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
  reset: () => set(initialState),
}));
