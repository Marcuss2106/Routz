export type ScenePoint = [number, number, number];
export type GroundPosition = [number, number, number];

export interface RailLine {
  id: string;
  type: "ACTIVE" | "SPUR";
  name: string | null;
  points: ScenePoint[];
}

export interface RoadLine {
  id: string;
  name: string | null;
  ref: string | null;
  class: string;
  category: "major" | "medium" | "local";
  ground_level: boolean;
  elevation_m: number;
  points: ScenePoint[];
}

export interface RailCrossing {
  id: string;
  name: string;
  road_class: string;
  position: ScenePoint;
  longitude: number;
  latitude: number;
  rotation_y_rad: number;
  signals: string | null;
  barrier: string | null;
  source: string;
}

export interface RailroadPayload {
  source: { source: string; retrieved: string; source_updated: string; radius_m: number; feature_count: number };
  coordinate_system: {
    source_crs: string;
    movement_crs: string;
    origin: { latitude: number; longitude: number };
    scene_axes: Record<string, string>;
    units: string;
    heading: string;
  };
  topology: { join_tolerance_m: number; policy: string };
  network: RailLine[];
  road_source: { source: string; attribution: string; retrieved: string; radius_m: number; feature_count: number };
  roads: RoadLine[];
  crossings: RailCrossing[];
  route: { id: string; length_m: number; source_edge_ids: string[]; selection: string; points: ScenePoint[] };
}

export interface VehicleState {
  id: string;
  distance_m: number;
  latitude: number;
  longitude: number;
  scene: { x: number; y: number; z: number };
  heading_deg: number;
}

/** Ground truth used only by the renderer and audio synthesizer. */
export interface TrainState {
  type: "train_state";
  train_id: string;
  sequence: number;
  simulation_time_s: number;
  status: "running" | "paused" | "completed";
  route_id: string;
  distance_along_route_m: number;
  speed_mps: number;
  playback_speed: number;
  latitude: number;
  longitude: number;
  scene_position: { x: number; y: number; z: number };
  heading_deg: number;
  train_length_m: number;
  vehicles: VehicleState[];
}

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";
export type CameraMode = "overview" | "top" | "follow";
export type SimulationCommand =
  | { command: "play" | "pause" | "restart" }
  | { command: "set_playback_speed"; value: number };

export type SensorId = "mic-1" | "mic-2" | "mic-3";

export interface AudioSensor {
  id: SensorId;
  streamId: SensorId;
  label: string;
  /** Shared acoustic geometry in the local east/elevation/north scene basis. */
  position: GroundPosition;
  color: string;
  phase: number;
  sensitivity: number;
  baseFrequency: number;
  /** Visual-only placement fields for the live SCDOT route renderer. */
  routeDistanceM: number;
  lateralOffsetM: number;
}

export interface SensorReading {
  sensorId: SensorId;
  amplitude: number;
  decibels: number;
  distance: number;
  delaySeconds: number;
  frequency: number;
  waveform: number[];
}

export interface TrainAudioSource {
  samples: Float32Array;
  sampleRateHz: number;
  durationSeconds: number;
  status: "loading" | "ready" | "fallback" | "error";
}

export interface MicrophoneAudioChunk {
  type: "microphone_audio_chunk";
  simulation_id: string;
  sequence: number;
  simulation_time_s: number;
  sample_rate_hz: number;
  duration_ms: number;
  microphones: Array<{
    id: SensorId;
    x_m: number;
    y_m: number;
    audio_pcm16_base64: string;
  }>;
}

export type EstimateStatus = "detected" | "tracking" | "length_pending" | "cleared" | "unknown";

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

export interface AudioPredictionError {
  type: "ingest_error";
  reason?: string;
  detail?: string;
}

export type AudioPrediction = TrainStateEstimate | AudioPredictionError;
