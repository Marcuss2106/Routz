"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { useRef, type MutableRefObject } from "react";
import * as THREE from "three";

import { SCENE_SCALE, SENSOR_DEFINITIONS, TRACK_LENGTH_M } from "@/lib/geometry";
import { useSimulationStore } from "@/stores/simulationStore";
import { Microphone } from "@/components/simulation/Microphone";
import { Railroad } from "@/components/simulation/Railroad";
import { Train } from "@/components/simulation/Train";
import type {
  AudioSensor,
  GroundPosition,
  SensorReading,
  TrainState,
} from "@/types/simulation";

interface TrainSceneProps {
  readings: SensorReading[];
  sourcePosition: GroundPosition;
  trainState: TrainState;
}

interface SensorMarkerProps {
  sensor: AudioSensor;
  reading: SensorReading;
  selected: boolean;
  showWaves: boolean;
  onSelect: () => void;
}

function SignalRing({
  position,
  color,
  amplitude,
  delay,
}: {
  position: GroundPosition;
  color: string;
  amplitude: number;
  delay: number;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    const cycle = (clock.elapsedTime * 0.72 + delay) % 1;
    const scale = 0.42 + cycle * (1.15 + amplitude * 0.85);

    if (ringRef.current) {
      ringRef.current.scale.setScalar(scale);
    }
    if (materialRef.current) {
      materialRef.current.opacity = (1 - cycle) * (0.12 + amplitude * 0.5);
    }
  });

  return (
    <mesh
      ref={ringRef}
      position={[position[0], 0.045, position[2]]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <ringGeometry args={[0.82, 0.86, 64]} />
      <meshBasicMaterial
        ref={materialRef}
        color={color}
        transparent
        opacity={0.35}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function SensorMarker({
  sensor,
  reading,
  selected,
  showWaves,
  onSelect,
}: SensorMarkerProps) {
  return (
    <>
      {showWaves &&
        [0, 1, 2].map((delay) => (
          <SignalRing
            key={`${sensor.id}-wave-${delay}`}
            position={sensor.position}
            color={sensor.color}
            amplitude={reading.amplitude}
            delay={delay / 3}
          />
        ))}
      <group
        position={[sensor.position[0], 0, sensor.position[2]]}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onPointerOver={() => {
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "default";
        }}
      >
        <Microphone sensor={sensor} reading={reading} selected={selected} />
        <Html
          position={[0, 1.55, 0]}
          center
          distanceFactor={8}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              border: `1px solid ${sensor.color}55`,
              background: "rgba(5, 10, 22, 0.88)",
              borderRadius: 8,
              color: "#eef5ff",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              letterSpacing: "0.08em",
              padding: "5px 8px",
              textAlign: "center",
              whiteSpace: "nowrap",
            }}
          >
            <div style={{ color: sensor.color }}>{sensor.shortLabel}</div>
            <div style={{ color: "#9badc7", fontSize: 9 }}>
              {reading.decibels} dB
            </div>
          </div>
        </Html>
      </group>
    </>
  );
}

function SourceEmitter({ position }: { position: GroundPosition }) {
  const sourceRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (sourceRef.current) {
      sourceRef.current.position.y = 0.3 + Math.sin(clock.elapsedTime * 3) * 0.05;
    }
  });

  return (
    <group ref={sourceRef} position={[position[0], 0.3, position[2]]}>
      <mesh castShadow>
        <sphereGeometry args={[0.28, 24, 24]} />
        <meshStandardMaterial
          color="#ff5d82"
          emissive="#ff315f"
          emissiveIntensity={2.2}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.25, 0]}>
        <ringGeometry args={[0.44, 0.47, 48]} />
        <meshBasicMaterial color="#ff5d82" transparent opacity={0.7} />
      </mesh>
      <pointLight color="#ff416d" intensity={2} distance={3.5} />
      <Html
        position={[0, 0.75, 0]}
        center
        distanceFactor={8}
        style={{ pointerEvents: "none" }}
      >
        <div
          style={{
            color: "#ff9fb5",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 10,
            letterSpacing: "0.08em",
            whiteSpace: "nowrap",
          }}
        >
          TRAIN AUDIO
        </div>
      </Html>
    </group>
  );
}

function Ground({
  sourcePosition,
  showLinks,
  readings,
}: Pick<TrainSceneProps, "readings" | "sourcePosition"> & { showLinks: boolean }) {
  return (
    <>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.08, 0]}
        receiveShadow
      >
        <planeGeometry args={[TRACK_LENGTH_M + 400, 800]} />
        <meshStandardMaterial
          color="#0b1424"
          roughness={0.92}
          metalness={0.05}
        />
      </mesh>
      <Grid
        args={[TRACK_LENGTH_M + 400, 800]}
        position={[0, -0.01, 0]}
        cellSize={50}
        cellThickness={0.5}
        cellColor="#1b3552"
        sectionSize={250}
        sectionThickness={0.9}
        sectionColor="#2a4a6b"
        fadeDistance={TRACK_LENGTH_M + 400}
        fadeStrength={1.2}
        infiniteGrid={false}
      />
      <Railroad />
      {showLinks &&
        readings.map((reading) => {
          const sensor = SENSOR_DEFINITIONS.find(
            (item) => item.id === reading.sensorId,
          );
          if (!sensor) return null;
          const start: GroundPosition = [
            sourcePosition[0],
            0.06,
            sourcePosition[2],
          ];
          const end: GroundPosition = [sensor.position[0], 0.06, sensor.position[2]];
          return (
            <Line
              key={`${reading.sensorId}-link`}
              points={[start, end]}
              color={sensor.color}
              transparent
              opacity={0.2 + reading.amplitude * 0.3}
              lineWidth={1}
            />
          );
        })}
    </>
  );
}

function SceneContents({ readings, sourcePosition, trainState }: TrainSceneProps) {
  const showWaves = useSimulationStore((state) => state.showWaves);
  const showLinks = useSimulationStore((state) => state.showLinks);
  const sourceEnabled = useSimulationStore((state) => state.sourceEnabled);
  const selectedSensorId = useSimulationStore((state) => state.selectedSensorId);
  const setSelectedSensorId = useSimulationStore(
    (state) => state.setSelectedSensorId,
  );

  return (
    <>
      <color attach="background" args={["#050914"]} />
      <fog attach="fog" args={["#050914", 12, 25]} />
      <ambientLight intensity={0.75} />
      <directionalLight
        castShadow
        position={[-5, 9, 4]}
        intensity={2.3}
        color="#d7e8ff"
        shadow-mapSize={[1024, 1024]}
      />
      <group scale={SCENE_SCALE}>
        <Ground
          readings={readings}
          sourcePosition={sourcePosition}
          showLinks={showLinks && sourceEnabled}
        />
        <Train trainState={trainState} />
        {SENSOR_DEFINITIONS.map((sensor) => {
          const reading = readings.find((item) => item.sensorId === sensor.id);
          if (!reading) return null;
          return (
            <SensorMarker
              key={sensor.id}
              sensor={sensor}
              reading={reading}
              selected={selectedSensorId === sensor.id}
              showWaves={showWaves && sourceEnabled}
              onSelect={() => setSelectedSensorId(sensor.id)}
            />
          );
        })}
        {sourceEnabled && <SourceEmitter position={sourcePosition} />}
      </group>
    </>
  );
}

export function TrainScene({ readings, sourcePosition, trainState }: TrainSceneProps) {
  const advanceTime = useSimulationStore((state) => state.advanceTime);
  const isRunning = useSimulationStore((state) => state.isRunning);
  const simulationSpeed = useSimulationStore((state) => state.simulationSpeed);
  const frameAccumulatorRef = useRef(0);

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [22, 42, 58], fov: 42, near: 0.1, far: 220 }}
      onCreated={({ gl }) => {
        gl.setClearColor("#050914");
      }}
    >
      <SimulationClock
        advanceTime={advanceTime}
        frameAccumulatorRef={frameAccumulatorRef}
        isRunning={isRunning}
        simulationSpeed={simulationSpeed}
      />
      <SceneContents
        readings={readings}
        sourcePosition={sourcePosition}
        trainState={trainState}
      />
      <OrbitControls
        makeDefault
        target={[22, 0, 12]}
        minDistance={5}
        maxDistance={130}
        maxPolarAngle={Math.PI / 2.08}
        minPolarAngle={0.32}
        enableDamping
      />
    </Canvas>
  );
}

function SimulationClock({
  advanceTime,
  frameAccumulatorRef,
  isRunning,
  simulationSpeed,
}: {
  advanceTime: (delta: number) => void;
  frameAccumulatorRef: MutableRefObject<number>;
  isRunning: boolean;
  simulationSpeed: number;
}) {
  useFrame((_, delta) => {
    if (!isRunning) return;
    frameAccumulatorRef.current += delta;
    if (frameAccumulatorRef.current >= 0.05) {
      advanceTime(frameAccumulatorRef.current * simulationSpeed);
      frameAccumulatorRef.current = 0;
    }
  });

  return null;
}
