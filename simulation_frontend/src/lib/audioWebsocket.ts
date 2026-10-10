import {
  AUDIO_CHUNK_DURATION_MS,
  AUDIO_SAMPLE_RATE_HZ,
  generateMicrophoneSamples,
  mapRouteDistanceToAcousticS,
} from "@/lib/simulation";
import type {
  AudioPrediction,
  AudioSensor,
  ConnectionState,
  MicrophoneAudioChunk,
  TrainAudioSource,
  TrainState,
} from "@/types/simulation";

const audioWsUrl = process.env.NEXT_PUBLIC_AUDIO_WS_URL ?? "ws://localhost:8001/ws/simulation";
export const AUDIO_SIMULATION_ID = "routz-columbia-audio-001";

function encodePcm16Base64(samples: Float32Array) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  });
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function buildAudioChunk(
  sequence: number,
  state: TrainState,
  sensors: AudioSensor[],
  audioSource: TrainAudioSource | null,
  routeLengthM: number,
): MicrophoneAudioChunk {
  const trainPositionM = mapRouteDistanceToAcousticS(state.distance_along_route_m, routeLengthM);
  return {
    type: "microphone_audio_chunk",
    simulation_id: AUDIO_SIMULATION_ID,
    sequence,
    simulation_time_s: Number(state.simulation_time_s.toFixed(3)),
    sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
    duration_ms: AUDIO_CHUNK_DURATION_MS,
    microphones: sensors.map((sensor) => ({
      id: sensor.streamId,
      x_m: sensor.position[0],
      y_m: sensor.position[2],
      audio_pcm16_base64: encodePcm16Base64(
        generateMicrophoneSamples(
          sensor,
          state.simulation_time_s,
          trainPositionM,
          state.train_length_m,
          audioSource,
          state.speed_mps,
        ),
      ),
    })),
  };
}

export class AudioSimulationSocket {
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private onConnection: (state: ConnectionState) => void,
    private onPrediction: (prediction: AudioPrediction) => void,
  ) {}

  connect() {
    this.stopped = false;
    this.onConnection("connecting");
    this.socket = new WebSocket(audioWsUrl);
    this.socket.onopen = () => {
      this.onConnection("connected");
      this.send({ type: "simulation_reset", simulation_id: AUDIO_SIMULATION_ID });
    };
    this.socket.onmessage = (event) => this.onPrediction(JSON.parse(event.data) as AudioPrediction);
    this.socket.onerror = () => this.onConnection("reconnecting");
    this.socket.onclose = () => {
      if (this.stopped) return;
      this.onConnection("reconnecting");
      this.retry = setTimeout(() => this.connect(), 2000);
    };
  }

  send(message: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  reset() {
    return this.send({ type: "simulation_reset", simulation_id: AUDIO_SIMULATION_ID });
  }

  close() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close();
    this.onConnection("offline");
  }
}
