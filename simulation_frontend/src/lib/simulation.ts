import {
  AUDIO_CHUNK_SAMPLES,
  AUDIO_SAMPLE_RATE_HZ,
  SENSOR_DEFINITIONS,
  SIMULATION_START_MARGIN_M,
  SOUND_SPEED_MPS,
  TRACK_LENGTH_M,
  clamp,
  distanceOnGround,
  railHeadingRadians,
  railPositionToGround,
  wrapRailPosition,
} from "@/lib/geometry";
import type {
  AudioSensor,
  GroundPosition,
  SensorReading,
  TrainAudioSource,
  TrainState,
} from "@/types/simulation";

export {
  AUDIO_CHUNK_DURATION_MS,
  AUDIO_CHUNK_DURATION_S,
  AUDIO_CHUNK_SAMPLES,
  AUDIO_SAMPLE_RATE_HZ,
  SENSOR_DEFINITIONS,
  SOUND_SPEED_MPS,
  TRACK_LENGTH_M,
} from "@/lib/geometry";

const BASE_SPEED_MPS = 8.4;
const TRAIN_LENGTH_M = 142;
const AUDIO_SEGMENT_COUNT = 8;

export function getTrainState(
  time: number,
  speedMultiplier = 1,
  direction: 1 | -1 = 1,
): TrainState {
  const speedMps = BASE_SPEED_MPS * speedMultiplier;
  const routeLength = TRACK_LENGTH_M + SIMULATION_START_MARGIN_M * 2;
  const travelM = (time * speedMps) % routeLength;
  const railPositionM = direction === 1
    ? -SIMULATION_START_MARGIN_M + travelM
    : TRACK_LENGTH_M + SIMULATION_START_MARGIN_M - travelM;
  const signedSpeedMps = direction * speedMps;

  return {
    position: railPositionToGround(railPositionM, 0.48),
    railPositionM,
    headingRadians: railHeadingRadians(railPositionM, direction),
    direction,
    speedMps,
    signedSpeedMps,
    lengthM: TRAIN_LENGTH_M,
    progressM: wrapRailPosition(railPositionM),
  };
}

export function getSourcePosition(
  time: number,
  speedMultiplier = 1,
  direction: 1 | -1 = 1,
): GroundPosition {
  return getTrainState(time, speedMultiplier, direction).position;
}

export function simulateSensorReading(
  sensor: AudioSensor,
  time: number,
  trainState: TrainState,
  sourceEnabled: boolean,
  noiseLevel: number,
): SensorReading {
  const distance = distanceOnGround(sensor.position, trainState.position);
  const proximity = 1 / (1 + distance * 0.025);
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

function wrappedAudioSample(
  audioSource: TrainAudioSource | null | undefined,
  timeS: number,
  phaseOffsetS: number,
  sensorPhase: number,
) {
  const sourceTime = timeS + phaseOffsetS;
  if (audioSource?.samples.length && audioSource.durationSeconds > 0) {
    const wrappedTime = ((sourceTime % audioSource.durationSeconds) + audioSource.durationSeconds) % audioSource.durationSeconds;
    const index = Math.floor(wrappedTime * audioSource.sampleRateHz) % audioSource.samples.length;
    return audioSource.samples[index];
  }
  return (
    Math.sin(sourceTime * Math.PI * 2 * 92 + sensorPhase) * 0.52 +
    Math.sin(sourceTime * Math.PI * 2 * 184 + sensorPhase * 0.6) * 0.22 +
    Math.sin(sourceTime * Math.PI * 2 * 37) * 0.16
  );
}

/**
 * Generate one distinct microphone stream from a moving extended source.
 * The backend receives only these signals and the microphone geometry; all
 * train position and length values remain local to this renderer.
 */
export function generateMicrophoneSamples(
  sensor: AudioSensor,
  simulationTime: number,
  trainState: TrainState,
  sourceEnabled: boolean,
  noiseLevel: number,
  audioSource?: TrainAudioSource | null,
): Float32Array {
  const samples = new Float32Array(AUDIO_CHUNK_SAMPLES);

  for (let index = 0; index < samples.length; index += 1) {
    const receiveTime = simulationTime + index / AUDIO_SAMPLE_RATE_HZ;
    let signal = 0;

    if (sourceEnabled) {
      for (let segmentIndex = 0; segmentIndex < AUDIO_SEGMENT_COUNT; segmentIndex += 1) {
        const fraction = segmentIndex / (AUDIO_SEGMENT_COUNT - 1) - 0.5;
        const segmentOffsetM = fraction * trainState.lengthM * trainState.direction;
        const approximateSourceS = trainState.railPositionM + segmentOffsetM;
        const approximatePosition = railPositionToGround(approximateSourceS);
        const approximateDistance = Math.hypot(
          sensor.position[0] - approximatePosition[0],
          sensor.position[2] - approximatePosition[2],
        );
        const emissionTime = receiveTime - approximateDistance / SOUND_SPEED_MPS;
        const movingSourceS =
          trainState.railPositionM +
          trainState.signedSpeedMps * (emissionTime - simulationTime) +
          segmentOffsetM;
        const sourcePosition = railPositionToGround(movingSourceS);
        const distance = Math.hypot(
          sensor.position[0] - sourcePosition[0],
          sensor.position[2] - sourcePosition[2],
        );
        const attenuation = 1 / (1 + distance * 0.035);
        const locomotiveGain = segmentIndex === AUDIO_SEGMENT_COUNT - 1 ? 1.45 : 0.62;
        const carVariation = 0.86 + 0.08 * Math.sin(segmentIndex * 1.7 + sensor.phase);
        const segmentPhase = segmentIndex * 0.037 + sensor.phase * 0.01;
        signal +=
          wrappedAudioSample(audioSource, emissionTime, segmentPhase, sensor.phase) *
          attenuation *
          locomotiveGain *
          carVariation;
      }
      signal /= AUDIO_SEGMENT_COUNT;
      signal *= 0.9 + 0.1 * Math.sin(simulationTime * 2.3 + sensor.phase);
    }

    const noise = deterministicNoise(index, simulationTime, sensor.phase);
    samples[index] = clamp(signal * 0.78 + noise * noiseLevel * 0.16, -1, 1);
  }

  return samples;
}
