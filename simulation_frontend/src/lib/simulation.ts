import type { AudioSensor, ScenePoint, SensorReading, TrainAudioSource, TrainState } from "@/types/simulation";

export const VISUAL_EXAGGERATION = {
  railGaugeM: 18,
  sleeperLengthM: 34,
  sleeperWidthM: 5,
  sleeperSpacingM: 75,
  trainScale: 3.5,
  sensorScale: 9,
} as const;

export const AUDIO_SAMPLE_RATE_HZ = 16_000;
export const AUDIO_CHUNK_DURATION_MS = 250;
export const AUDIO_CHUNK_SAMPLES = 4000;
export const SOUND_SPEED_MPS = 343;
export const VEHICLE_OFFSETS_M = [0, 44, 80, 116, 152, 188] as const;

export function getAudioSensors(routeLengthM: number): AudioSensor[] {
  const firstSensorM = routeLengthM * .34;
  return [
    { id: "sensor-1", streamId: "mic-1", label: "Sensor 01", routeDistanceM: firstSensorM, lateralOffsetM: 58, color: "#7d8d71", phase: 0.3 },
    { id: "sensor-2", streamId: "mic-2", label: "Sensor 02", routeDistanceM: firstSensorM + 100, lateralOffsetM: -64, color: "#a94334", phase: 2.1 },
    { id: "sensor-3", streamId: "mic-3", label: "Sensor 03", routeDistanceM: firstSensorM + 200, lateralOffsetM: 56, color: "#727873", phase: 4.2 },
  ];
}

export function sampleRoute(points: ScenePoint[], distanceM: number) {
  if (points.length < 2) return { position: [0, 0, 0] as ScenePoint, rotationY: 0 };
  let remaining = Math.max(0, distanceM);
  for (let index = 0; index < points.length - 1; index += 1) {
    const first = points[index];
    const second = points[index + 1];
    const dx = second[0] - first[0];
    const dz = second[2] - first[2];
    const length = Math.hypot(dx, dz);
    if (remaining <= length || index === points.length - 2) {
      const ratio = length === 0 ? 0 : Math.min(1, remaining / length);
      return {
        position: [first[0] + dx * ratio, 3, first[2] + dz * ratio] as ScenePoint,
        rotationY: Math.atan2(dx, dz),
      };
    }
    remaining -= length;
  }
  return { position: points.at(-1)!, rotationY: 0 };
}

export function formatDistance(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export function sensorScenePosition(route: ScenePoint[], sensor: AudioSensor): ScenePoint {
  const sample = sampleRoute(route, sensor.routeDistanceM);
  const normalX = Math.cos(sample.rotationY);
  const normalZ = -Math.sin(sample.rotationY);
  return [
    sample.position[0] + normalX * sensor.lateralOffsetM,
    0,
    sample.position[2] + normalZ * sensor.lateralOffsetM,
  ];
}

export function simulateSensorReadings(state: TrainState, sensors: AudioSensor[]): SensorReading[] {
  return sensors.map((sensor) => {
    const distance = Math.min(
      ...state.vehicles.map((vehicle) =>
        Math.hypot(vehicle.distance_m - sensor.routeDistanceM, sensor.lateralOffsetM),
      ),
    );
    const amplitude = Math.min(1, 0.04 + 1 / (1 + distance * 0.018));
    return {
      sensorId: sensor.id,
      amplitude,
      decibels: Math.round(-62 + amplitude * 62),
      distance,
      delaySeconds: distance / SOUND_SPEED_MPS,
      frequency: Math.round(90 + amplitude * 70),
      waveform: Array.from({ length: 40 }, (_, index) =>
        amplitude * Math.sin((index / 40) * Math.PI * 8 + state.simulation_time_s * 5 + sensor.phase),
      ),
    };
  });
}

function sourceSample(source: TrainAudioSource | null, time: number, phase: number) {
  if (source?.samples.length && source.durationSeconds > 0) {
    const wrapped = ((time % source.durationSeconds) + source.durationSeconds) % source.durationSeconds;
    return source.samples[Math.floor(wrapped * source.sampleRateHz) % source.samples.length];
  }
  return Math.sin(time * Math.PI * 2 * 92) * 0.55 + Math.sin(time * Math.PI * 2 * 184 + phase) * 0.22;
}

export function generateMicrophoneSamples(
  sensor: AudioSensor,
  simulationTime: number,
  trainDistanceM: number,
  audioSource: TrainAudioSource | null,
) {
  // Hold the acoustic source fixed for each 1 s analysis window. This mirrors
  // the localizer's documented point-source approximation while the renderer
  // continues to show the physically moving six-vehicle consist.
  const consistCenterM = trainDistanceM - 97 - (simulationTime % 1) * 16;
  const distance = Math.hypot(consistCenterM - sensor.routeDistanceM, sensor.lateralOffsetM);
  const delay = distance / SOUND_SPEED_MPS;
  const attenuation = Math.max(0.035, 1 / (1 + distance * 0.014));
  const samples = new Float32Array(AUDIO_CHUNK_SAMPLES);
  for (let index = 0; index < samples.length; index += 1) {
    const time = simulationTime + index / AUDIO_SAMPLE_RATE_HZ - delay;
    const engine = sourceSample(audioSource, time, sensor.phase);
    const rhythm = 0.72 + 0.28 * Math.sin(time * Math.PI * 2 * 1.1);
    const noise = Math.sin(index * 12.9898 + simulationTime * 78.233 + sensor.phase * 37.719) * 0.012;
    samples[index] = Math.max(-1, Math.min(1, engine * rhythm * attenuation + noise));
  }
  return samples;
}
