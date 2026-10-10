import {
  AUDIO_CHUNK_SAMPLES,
  AUDIO_SAMPLE_RATE_HZ,
  SCENE_SCALE,
  SENSOR_DEFINITIONS,
  SIMULATION_START_MARGIN_M,
  SOUND_SPEED_MPS,
  TRACK_LENGTH_M,
  clamp,
  distanceOnGround,
  railPositionToGround,
} from "@/lib/geometry";
import type { AudioSensor, ScenePoint, SensorReading, TrainAudioSource, TrainState } from "@/types/simulation";

export {
  AUDIO_CHUNK_DURATION_MS,
  AUDIO_CHUNK_SAMPLES,
  AUDIO_SAMPLE_RATE_HZ,
  SENSOR_DEFINITIONS,
  SOUND_SPEED_MPS,
  TRACK_LENGTH_M,
} from "@/lib/geometry";

export const VISUAL_EXAGGERATION = {
  railGaugeM: 18,
  sleeperLengthM: 34,
  sleeperWidthM: 5,
  sleeperSpacingM: 75,
  trainScale: 3.5,
  sensorScale: 9,
} as const;

export const VEHICLE_OFFSETS_M = [0, 44, 80, 116, 152, 188] as const;

/**
 * Keep the SCDOT scene from GitHub while placing the displayed microphones in
 * the same relative array order as the shared acoustic geometry. Their actual
 * x/y coordinates are always taken from shared/simulation_geometry.json when
 * an audio chunk is built.
 */
export function getAudioSensors(routeLengthM: number): AudioSensor[] {
  const arrayStartM = routeLengthM * 0.34;
  const visualArrayLengthM = Math.min(1000, routeLengthM * 0.2);
  return SENSOR_DEFINITIONS.map((sensor) => ({
    ...sensor,
    routeDistanceM: arrayStartM + (sensor.position[0] / TRACK_LENGTH_M) * visualArrayLengthM,
    lateralOffsetM: sensor.position[2],
  }));
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
      frequency: Math.round(sensor.baseFrequency + amplitude * 70),
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

function deterministicNoise(index: number, time: number, phase: number) {
  return Math.sin(index * 12.9898 + time * 78.233 + phase * 37.719) * 2 - 1;
}

/**
 * Generate microphone-only observations from a moving extended source. The
 * train state and length arguments are renderer truth and never enter the wire
 * payload; they are used only to create the audio samples.
 */
export function generateMicrophoneSamples(
  sensor: AudioSensor,
  simulationTime: number,
  trainPositionM: number,
  trainLengthM: number,
  audioSource: TrainAudioSource | null,
  signedSpeedMps = 16,
  noiseLevel = 0.035,
): Float32Array {
  const samples = new Float32Array(AUDIO_CHUNK_SAMPLES);
  const segmentCount = 8;
  for (let index = 0; index < samples.length; index += 1) {
    const receiveTime = simulationTime + index / AUDIO_SAMPLE_RATE_HZ;
    let signal = 0;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const fraction = segmentIndex / (segmentCount - 1) - 0.5;
      const segmentOffsetM = fraction * trainLengthM;
      const approximateSourceS = trainPositionM + segmentOffsetM;
      const approximatePosition = railPositionToGround(approximateSourceS);
      const approximateDistance = distanceOnGround(sensor.position, approximatePosition);
      const emissionTime = receiveTime - approximateDistance / SOUND_SPEED_MPS;
      const movingSourceS = trainPositionM + signedSpeedMps * (emissionTime - simulationTime) + segmentOffsetM;
      const sourcePosition = railPositionToGround(movingSourceS);
      const distance = distanceOnGround(sensor.position, sourcePosition);
      const attenuation = 1 / (1 + distance * 0.035);
      const locomotiveGain = segmentIndex === segmentCount - 1 ? 1.45 : 0.62;
      const carVariation = 0.86 + 0.08 * Math.sin(segmentIndex * 1.7 + sensor.phase);
      signal += sourceSample(audioSource, emissionTime, sensor.phase + segmentIndex * 0.037) * attenuation * locomotiveGain * carVariation;
    }
    signal /= segmentCount;
    const noise = deterministicNoise(index, simulationTime, sensor.phase);
    samples[index] = clamp(signal * 0.78 + noise * noiseLevel * 0.16, -1, 1);
  }
  return samples;
}

export function mapRouteDistanceToAcousticS(distanceM: number, routeLengthM: number) {
  const normalized = routeLengthM > 0 ? distanceM / routeLengthM : 0;
  return clamp(normalized * (TRACK_LENGTH_M + SIMULATION_START_MARGIN_M * 2) - SIMULATION_START_MARGIN_M, -SIMULATION_START_MARGIN_M, TRACK_LENGTH_M + SIMULATION_START_MARGIN_M);
}

export { SCENE_SCALE };
