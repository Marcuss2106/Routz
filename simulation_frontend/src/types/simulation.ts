export type GroundPosition = [number, number, number];

export type SensorId = "north" | "east" | "west";

export interface AudioSensor {
  id: SensorId;
  streamId: string;
  label: string;
  shortLabel: string;
  position: GroundPosition;
  color: string;
  phase: number;
  sensitivity: number;
  baseFrequency: number;
}

export interface TrainState {
  position: GroundPosition;
  direction: 1 | -1;
  speedMps: number;
  lengthM: number;
  progressM: number;
}

export interface SensorReading {
  sensorId: SensorId;
  amplitude: number;
  peak: number;
  decibels: number;
  frequency: number;
  distance: number;
  delaySeconds: number;
  noiseFloor: number;
  waveform: number[];
}

export interface MicrophoneAudioChunk {
  type: "microphone_audio_chunk";
  simulation_id: string;
  sequence: number;
  simulation_time_s: number;
  sample_rate_hz: number;
  duration_ms: number;
  source_file: string;
  microphones: Array<{
    id: string;
    x_m: number;
    y_m: number;
    z_m: number;
    audio_pcm16_base64: string;
  }>;
}

export interface TrainAudioSource {
  samples: Float32Array;
  sampleRateHz: number;
  durationSeconds: number;
  status: "loading" | "ready" | "fallback" | "error";
}
