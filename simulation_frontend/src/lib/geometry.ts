import geometryConfig from "../../../shared/simulation_geometry.json";

import type { AudioSensor, GroundPosition, SensorId } from "@/types/simulation";

export interface TrackPoint {
  x_m: number;
  y_m: number;
}

export interface SharedGeometryConfig {
  track_id: string;
  origin: { latitude: number; longitude: number };
  track: TrackPoint[];
  microphones: Array<{ id: string; x_m: number; y_m: number }>;
  crossings: Array<{ id: string; s_m: number; name: string }>;
}

export const SHARED_GEOMETRY = geometryConfig as SharedGeometryConfig;
export const TRACK_ID = SHARED_GEOMETRY.track_id;
export const SOUND_SPEED_MPS = 343;
export const AUDIO_SAMPLE_RATE_HZ = 16_000;
export const AUDIO_CHUNK_DURATION_MS = 250;
export const AUDIO_CHUNK_DURATION_S = AUDIO_CHUNK_DURATION_MS / 1_000;
export const AUDIO_CHUNK_SAMPLES =
  AUDIO_SAMPLE_RATE_HZ * AUDIO_CHUNK_DURATION_MS / 1_000;
export const TRAIN_LENGTH_DEFAULT_M = 142;
export const SIMULATION_START_MARGIN_M = 180;
export const SCENE_SCALE = 0.05;

const sensorStyle: Record<string, { color: string; phase: number; sensitivity: number; baseFrequency: number }> = {
  "mic-1": { color: "#73e0ff", phase: 0.2, sensitivity: 1, baseFrequency: 420 },
  "mic-2": { color: "#ffbe6b", phase: 2.1, sensitivity: 0.92, baseFrequency: 510 },
  "mic-3": { color: "#d7a7ff", phase: 4.2, sensitivity: 1.08, baseFrequency: 365 },
};

export const SENSOR_DEFINITIONS: readonly AudioSensor[] =
  SHARED_GEOMETRY.microphones.map((microphone) => {
    const style = sensorStyle[microphone.id] ?? {
      color: "#73e0ff",
      phase: 0,
      sensitivity: 1,
      baseFrequency: 420,
    };
    return {
      id: microphone.id as SensorId,
      streamId: microphone.id,
      label: `Microphone ${microphone.id.replace("mic-", "")}`,
      shortLabel: microphone.id.toUpperCase(),
      // Shared config uses x=east and y=north. The 3D scene uses x=east,
      // y=elevation, z=north.
      position: [microphone.x_m, 0, microphone.y_m],
      color: style.color,
      phase: style.phase,
      sensitivity: style.sensitivity,
      baseFrequency: style.baseFrequency,
    };
  });

const segmentLengths = SHARED_GEOMETRY.track.slice(1).map((point, index) =>
  Math.hypot(
    point.x_m - SHARED_GEOMETRY.track[index].x_m,
    point.y_m - SHARED_GEOMETRY.track[index].y_m,
  ),
);
const cumulativeS = [0];
for (const length of segmentLengths) {
  cumulativeS.push(cumulativeS[cumulativeS.length - 1] + length);
}

export const TRACK_LENGTH_M = cumulativeS[cumulativeS.length - 1];

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function wrapRailPosition(sM: number) {
  const routeLength = TRACK_LENGTH_M + SIMULATION_START_MARGIN_M * 2;
  const wrapped = (sM + SIMULATION_START_MARGIN_M) % routeLength;
  return wrapped < 0 ? wrapped + routeLength - SIMULATION_START_MARGIN_M : wrapped - SIMULATION_START_MARGIN_M;
}

/** Return an east/north point. Positions outside the endpoints extrapolate. */
export function railPointAtS(sM: number): { x_m: number; y_m: number } {
  if (sM <= 0) {
    const first = SHARED_GEOMETRY.track[0];
    const second = SHARED_GEOMETRY.track[1];
    const length = segmentLengths[0];
    const ratio = sM / length;
    return {
      x_m: first.x_m + (second.x_m - first.x_m) * ratio,
      y_m: first.y_m + (second.y_m - first.y_m) * ratio,
    };
  }
  if (sM >= TRACK_LENGTH_M) {
    const lastIndex = SHARED_GEOMETRY.track.length - 1;
    const previous = SHARED_GEOMETRY.track[lastIndex - 1];
    const last = SHARED_GEOMETRY.track[lastIndex];
    const length = segmentLengths[lastIndex - 1];
    const ratio = (sM - TRACK_LENGTH_M) / length;
    return {
      x_m: last.x_m + (last.x_m - previous.x_m) * ratio,
      y_m: last.y_m + (last.y_m - previous.y_m) * ratio,
    };
  }
  const segmentIndex = segmentLengths.findIndex(
    (_length, index) => sM <= cumulativeS[index + 1],
  );
  const start = SHARED_GEOMETRY.track[segmentIndex];
  const end = SHARED_GEOMETRY.track[segmentIndex + 1];
  const ratio = (sM - cumulativeS[segmentIndex]) / segmentLengths[segmentIndex];
  return {
    x_m: start.x_m + (end.x_m - start.x_m) * ratio,
    y_m: start.y_m + (end.y_m - start.y_m) * ratio,
  };
}

export function railTangentAtS(sM: number): { east: number; north: number } {
  const clampedS = clamp(sM, 0, TRACK_LENGTH_M - Number.EPSILON);
  const segmentIndex = segmentLengths.findIndex(
    (_length, index) => clampedS <= cumulativeS[index + 1],
  );
  const start = SHARED_GEOMETRY.track[segmentIndex];
  const end = SHARED_GEOMETRY.track[segmentIndex + 1];
  const length = segmentLengths[segmentIndex];
  return {
    east: (end.x_m - start.x_m) / length,
    north: (end.y_m - start.y_m) / length,
  };
}

export function railPositionToGround(sM: number, elevationM = 0): GroundPosition {
  const point = railPointAtS(sM);
  return [point.x_m, elevationM, point.y_m];
}

export function railHeadingRadians(sM: number, direction: 1 | -1 = 1) {
  const tangent = railTangentAtS(sM);
  const heading = Math.atan2(tangent.north, tangent.east);
  return direction === 1 ? heading : heading + Math.PI;
}

export function distanceOnGround(first: GroundPosition, second: GroundPosition) {
  return Math.hypot(first[0] - second[0], first[2] - second[2]);
}

export function sensorById(id: string) {
  return SENSOR_DEFINITIONS.find((sensor) => sensor.id === id);
}
