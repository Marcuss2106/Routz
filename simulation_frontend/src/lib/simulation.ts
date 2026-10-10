import type {
  AudioSensor,
  GroundPosition,
  SensorReading,
  TrainAudioSource,
  TrainState,
} from "@/types/simulation";

export const TRACK_HALF_LENGTH_M = 7.2;
export const TRACK_LENGTH_M = TRACK_HALF_LENGTH_M * 2;
export const SOUND_SPEED_MPS = 343;
export const AUDIO_SAMPLE_RATE_HZ = 16_000;
export const AUDIO_CHUNK_DURATION_MS = 250;
export const AUDIO_CHUNK_SAMPLES =
  (AUDIO_SAMPLE_RATE_HZ * AUDIO_CHUNK_DURATION_MS) / 1_000;

export const SENSOR_DEFINITIONS: readonly AudioSensor[] = [
  {
    id: "north",
    streamId: "mic-1",
    label: "North microphone",
    shortLabel: "MIC 01",
    position: [-4.5, 0, -2.2],
    color: "#73e0ff",
    phase: 0.2,
    sensitivity: 1,
    baseFrequency: 420,
  },
  {
    id: "east",
    streamId: "mic-2",
    label: "East microphone",
    shortLabel: "MIC 02",
    position: [0, 0, 2.6],
    color: "#ffbe6b",
    phase: 2.1,
    sensitivity: 0.92,
    baseFrequency: 510,
  },
  {
    id: "west",
    streamId: "mic-3",
    label: "West microphone",
    shortLabel: "MIC 03",
    position: [4.5, 0, -2.2],
    color: "#d7a7ff",
    phase: 4.2,
    sensitivity: 1.08,
    baseFrequency: 365,
  },
];

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function getTrainState(
  time: number,
  speedMultiplier = 1,
  direction: 1 | -1 = 1,
): TrainState {
  const speedMps = 1.45 * speedMultiplier;
  const progressM = ((time * speedMps) % TRACK_LENGTH_M + TRACK_LENGTH_M) % TRACK_LENGTH_M;
  const x = direction === 1
    ? -TRACK_HALF_LENGTH_M + progressM
    : TRACK_HALF_LENGTH_M - progressM;

  return {
    position: [x, 0.48, 0],
    direction,
    speedMps,
    lengthM: 4.8,
    progressM,
  };
}

export function getSourcePosition(
  time: number,
  speedMultiplier = 1,
  direction: 1 | -1 = 1,
): GroundPosition {
  return getTrainState(time, speedMultiplier, direction).position;
}

function distanceOnGround(first: GroundPosition, second: GroundPosition) {
  return Math.hypot(first[0] - second[0], first[2] - second[2]);
}

export function simulateSensorReading(
  sensor: AudioSensor,
  time: number,
  trainState: TrainState,
  sourceEnabled: boolean,
  noiseLevel: number,
): SensorReading {
  const sourcePosition = trainState.position;
  const distance = distanceOnGround(sensor.position, sourcePosition);
  const proximity = 1 / (1 + distance * 0.28);
  const delaySeconds = distance / SOUND_SPEED_MPS;
  const carrier = 0.5 + 0.5 * Math.sin(time * 5.4 + sensor.phase - delaySeconds * 4);
  const pulse = 0.5 + 0.5 * Math.sin(time * 1.15 + sensor.phase * 0.7);
  const signal = sourceEnabled
    ? proximity * sensor.sensitivity * (0.22 + carrier * 0.38 + pulse * 0.4)
    : 0.02;
  const amplitude = clamp(0.04 + signal + noiseLevel * 0.12, 0.04, 1);
  const peak = clamp(amplitude * (0.82 + carrier * 0.2), 0, 1);
  const waveform = Array.from({ length: 40 }, (_, index) => {
    const phase = index / 40;
    const detail = Math.sin(phase * Math.PI * 10 + time * 8 + sensor.phase);
    return clamp(amplitude * (0.36 + Math.abs(detail) * 0.64), 0, 1);
  });

  return {
    sensorId: sensor.id,
    amplitude,
    peak,
    decibels: Math.round(-54 + amplitude * 54),
    frequency: Math.round(sensor.baseFrequency + carrier * 24),
    distance,
    delaySeconds,
    noiseFloor: noiseLevel,
    waveform,
  };
}

export function simulateSensorReadings(
  time: number,
  sourceEnabled: boolean,
  trainState = getTrainState(time),
  noiseLevel = 0.06,
) {
  return SENSOR_DEFINITIONS.map((sensor) =>
    simulateSensorReading(sensor, time, trainState, sourceEnabled, noiseLevel),
  );
}

function deterministicNoise(index: number, time: number, phase: number) {
  return Math.sin(index * 12.9898 + time * 78.233 + phase * 37.719) * 2 - 1;
}

/**
 * Generate one distinct, delayed PCM stream per virtual microphone.
 * The signal is deliberately synthetic until train.wav is connected to the
 * browser/backend asset pipeline; its timing and attenuation model match the
 * same microphone contract used for the eventual prerecorded source.
 */
export function generateMicrophoneSamples(
  sensor: AudioSensor,
  simulationTime: number,
  trainState: TrainState,
  sourceEnabled: boolean,
  noiseLevel: number,
  audioSource?: TrainAudioSource | null,
): Float32Array {
  const reading = simulateSensorReading(
    sensor,
    simulationTime,
    trainState,
    sourceEnabled,
    noiseLevel,
  );
  const samples = new Float32Array(AUDIO_CHUNK_SAMPLES);
  const delayedStart = simulationTime - reading.delaySeconds;
  const attenuation = clamp(1 / (1 + reading.distance * 0.22), 0.08, 1);

  for (let index = 0; index < samples.length; index += 1) {
    const sourceTime = delayedStart + index / AUDIO_SAMPLE_RATE_HZ;
    const engine = audioSource?.samples.length
      ? audioSource.samples[
          Math.floor(
            (((sourceTime % audioSource.durationSeconds) +
              audioSource.durationSeconds) %
              audioSource.durationSeconds) * audioSource.sampleRateHz,
          ) % audioSource.samples.length
        ]
      : Math.sin(sourceTime * Math.PI * 2 * 92) * 0.52 +
        Math.sin(sourceTime * Math.PI * 2 * 184 + sensor.phase) * 0.22 +
        Math.sin(sourceTime * Math.PI * 2 * 37) * 0.16;
    const envelope = 0.72 + 0.28 * Math.sin(sourceTime * Math.PI * 2 * 1.15);
    const noise = deterministicNoise(index, simulationTime, sensor.phase);
    const signal = sourceEnabled ? engine * envelope * attenuation : 0;
    samples[index] = clamp(signal * 0.7 + noise * noiseLevel * 0.16, -1, 1);
  }

  return samples;
}
