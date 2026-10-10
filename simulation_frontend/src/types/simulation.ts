export type GroundPosition = [number, number, number];

export type SensorId = "mic-1" | "mic-2" | "mic-3";

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
  railPositionM: number;
  headingRadians: number;
  direction: 1 | -1;
  speedMps: number;
  signedSpeedMps: number;
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
  microphones: Array<{
    id: string;
    x_m: number;
    y_m: number;
    audio_pcm16_base64: string;
  }>;
}

export type EstimateStatus =
  | "detected"
  | "tracking"
  | "length_pending"
  | "cleared"
  | "unknown";

export interface EstimateConfidence {
  position: number;
  speed: number;
  length: number;
  direction: number;
}

export interface EstimateUncertainty {
  position_m: number | null;
  speed_mps: number | null;
  length_m: number | null;
  direction_deg: number | null;
}

export interface TrainStateEstimate {
  type: "train_state_estimate";
  simulation_id: string;
  sequence: number;
  simulation_time_s: number;
  train_id: string;
  track_id: string;
  latitude: number | null;
  longitude: number | null;
  speed_mps: number | null;
  length_m: number | null;
  direction_deg_from_east: number | null;
  status: EstimateStatus;
  confidence: EstimateConfidence;
  uncertainty: EstimateUncertainty;
  source: "acoustic_array";
  label: "simulated_acoustic_estimate";
  track_position_m?: number | null;
  crossings?: Array<{
    crossing_id: string;
    eta_seconds: number | null;
    estimated_blockage_seconds: number | null;
    status: "approaching" | "blocking" | "clear" | "unknown";
  }>;
}

export interface TrainAudioSource {
  samples: Float32Array;
  sampleRateHz: number;
  durationSeconds: number;
  status: "loading" | "ready" | "fallback" | "error";
}
