import {
  AUDIO_CHUNK_DURATION_MS,
  AUDIO_SAMPLE_RATE_HZ,
  generateMicrophoneSamples,
  SENSOR_DEFINITIONS,
} from "@/lib/simulation";
import type {
  MicrophoneAudioChunk,
  TrainAudioSource,
  TrainState,
} from "@/types/simulation";

export type SimulationSocketStatus = "offline" | "connecting" | "open" | "error";

interface SimulationSocketOptions {
  url?: string;
  onStatus?: (status: SimulationSocketStatus) => void;
  onOpen?: () => void;
  onMessage?: (message: unknown) => void;
}

export interface SimulationSocket {
  sendChunk: (chunk: MicrophoneAudioChunk) => boolean;
  sendJson: (message: unknown) => boolean;
  close: () => void;
}

export const DEFAULT_SIMULATION_ID = "routz-demo-001";

function encodePcm16Base64(samples: Float32Array) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  samples.forEach((sample, index) => {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  });

  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function buildMicrophoneAudioChunk({
  sequence,
  simulationTime,
  trainState,
  sourceEnabled,
  noiseLevel,
  audioSource,
}: {
  sequence: number;
  simulationTime: number;
  trainState: TrainState;
  sourceEnabled: boolean;
  noiseLevel: number;
  audioSource?: TrainAudioSource | null;
}): MicrophoneAudioChunk {
  return {
    type: "microphone_audio_chunk",
    simulation_id: DEFAULT_SIMULATION_ID,
    sequence,
    simulation_time_s: Number(simulationTime.toFixed(3)),
    sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
    duration_ms: AUDIO_CHUNK_DURATION_MS,
    source_file: "train.wav",
    microphones: SENSOR_DEFINITIONS.map((sensor) => ({
      id: sensor.streamId,
      x_m: sensor.position[0],
      y_m: sensor.position[1],
      z_m: sensor.position[2],
      audio_pcm16_base64: encodePcm16Base64(
        generateMicrophoneSamples(
          sensor,
          simulationTime,
          trainState,
          sourceEnabled,
          noiseLevel,
          audioSource,
        ),
      ),
    })),
  };
}

export function createSimulationSocket({
  url = process.env.NEXT_PUBLIC_SIMULATION_WS_URL ?? "ws://localhost:8000/ws/simulation",
  onStatus,
  onOpen,
  onMessage,
}: SimulationSocketOptions = {}): SimulationSocket {
  let socket: WebSocket | null = null;
  let closed = false;

  const sendJson = (message: unknown) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  if (typeof window === "undefined" || typeof WebSocket === "undefined") {
    onStatus?.("error");
    return {
      sendChunk: () => false,
      sendJson: () => false,
      close: () => undefined,
    };
  }

  onStatus?.("connecting");
  socket = new WebSocket(url);
  socket.onopen = () => {
    onStatus?.("open");
    onOpen?.();
  };
  socket.onerror = () => onStatus?.("error");
  socket.onclose = () => {
    if (!closed) onStatus?.("error");
    else onStatus?.("offline");
  };
  socket.onmessage = (event) => {
    try {
      onMessage?.(JSON.parse(event.data));
    } catch {
      onMessage?.(event.data);
    }
  };

  return {
    sendChunk: (chunk) => sendJson(chunk),
    sendJson,
    close: () => {
      closed = true;
      socket?.close();
      socket = null;
      onStatus?.("offline");
    },
  };
}
