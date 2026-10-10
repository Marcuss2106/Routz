export type ScenePoint = [number, number, number];

export interface RailLine {
  id: string;
  type: "ACTIVE" | "SPUR";
  name: string | null;
  points: ScenePoint[];
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

export type SensorId = "sensor-1" | "sensor-2" | "sensor-3";

export interface AudioSensor {
  id: SensorId;
  streamId: "mic-1" | "mic-2" | "mic-3";
  label: string;
  routeDistanceM: number;
  lateralOffsetM: number;
  color: string;
  phase: number;
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
  source_file: string;
  microphones: Array<{
    id: string;
    x_m: number;
    y_m: number;
    z_m: number;
    audio_pcm16_base64: string;
  }>;
}

export interface AudioPrediction {
  type: "crossing_prediction" | "ingest_error";
  status?: "tracking" | "unknown";
  estimated_position_m?: number | null;
  estimated_speed_mps?: number | null;
  sequence?: number;
  reason?: string;
}
