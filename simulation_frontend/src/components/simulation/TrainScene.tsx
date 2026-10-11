"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Html, OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { Railroad } from "./Railroad";
import { Train } from "./Train";
import { Microphone } from "./Microphone";
import { SoundWaves } from "./SoundWaves";
import { CrossingMarkers, RoadLayer } from "./Roads";
import { BuildingLayer } from "./Buildings";
import { getAudioSensors, sensorScenePosition, VISUAL_EXAGGERATION } from "@/lib/simulation";
import { useSimulationStore } from "@/stores/simulationStore";

const INITIAL_CAMERA_POSITION = new THREE.Vector3(2400, 2200, 2400);

function cameraOffset(mode: "overview" | "top" | "follow", routeLength: number) {
  if (mode === "top") return new THREE.Vector3(0, Math.min(1500, Math.max(950, routeLength * 1.35)), 1);
  if (mode === "follow") return new THREE.Vector3(720, 620, 720);
  return new THREE.Vector3(2400, 2200, 2400);
}

function CameraRig({ routeLength }: { routeLength: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((state) => state.camera);
  const resetToken = useSimulationStore((state) => state.cameraReset);
  const cameraMode = useSimulationStore((state) => state.cameraMode);
  const initialized = useRef(false);
  const transition = useRef<{
    startedAt: number;
    fromPosition: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPosition: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null>(null);

  useEffect(() => {
    const current = useSimulationStore.getState().current;
    if (!current || !controls.current || !initialized.current) return;
    const position = current.value.scene_position;
    const target = new THREE.Vector3(position.x, 0, position.z);
    transition.current = {
      startedAt: performance.now(),
      fromPosition: camera.position.clone(),
      fromTarget: controls.current.target.clone(),
      toPosition: target.clone().add(cameraOffset(cameraMode, routeLength)),
      toTarget: target,
    };
  }, [camera, cameraMode, resetToken, routeLength]);

  useFrame(() => {
    const { cameraMode: mode, current } = useSimulationStore.getState();
    if (!current || !controls.current) return;
    const position = current.value.scene_position;
    const target = new THREE.Vector3(position.x, 0, position.z);

    if (!initialized.current) {
      initialized.current = true;
      controls.current.target.copy(target);
      camera.position.copy(target.clone().add(cameraOffset("overview", routeLength)));
      controls.current.update();
      return;
    }

    if (transition.current) {
      const movement = transition.current;
      const progress = Math.min(1, (performance.now() - movement.startedAt) / 1200);
      const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      camera.position.lerpVectors(movement.fromPosition, movement.toPosition, eased);
      controls.current.target.lerpVectors(movement.fromTarget, movement.toTarget, eased);
      controls.current.update();
      if (progress >= 1) transition.current = null;
      return;
    }

    if (mode === "overview") return;
    controls.current.target.lerp(target, 0.12);
    camera.position.lerp(target.clone().add(cameraOffset(mode, routeLength)), 0.08);
    controls.current.update();
  });
  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} minDistance={180} maxDistance={55000} maxPolarAngle={Math.PI / 2.08} />;
}

export default function TrainScene() {
  const railroad = useSimulationStore((state) => state.railroad)!;
  const sensorReadings = useSimulationStore((state) => state.sensorReadings);
  const sensors = useMemo(
    () => getAudioSensors(railroad.route.length_m, railroad.audio_trackers ?? []),
    [railroad.audio_trackers, railroad.route.length_m],
  );
  return (
    <div className="canvas-wrap">
      <Canvas
        shadows
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        camera={{ position: INITIAL_CAMERA_POSITION.toArray(), fov: 38, near: 5, far: 60000 }}
        dpr={[1, 2]}
      >
        <color attach="background" args={["#d8d7c7"]} />
        <fog attach="fog" args={["#d8d7c7", 22000, 48000]} />
        <ambientLight intensity={1.25} />
        <directionalLight castShadow position={[-9000, 16000, 7000]} intensity={2.2} color="#fff5d8" shadow-mapSize={[2048, 2048]} shadow-camera-far={45000} shadow-camera-left={-18000} shadow-camera-right={18000} shadow-camera-top={18000} shadow-camera-bottom={-18000} />
        <mesh rotation-x={-Math.PI / 2} receiveShadow position-y={-1}><circleGeometry args={[17400, 96]} /><meshStandardMaterial color="#b9c0a5" roughness={1} /></mesh>
        <RoadLayer roads={railroad.roads ?? []} />
        <BuildingLayer landmarks={railroad.landmarks ?? []} />
        <Railroad lines={railroad.network} route={railroad.route.points} />
        <CrossingMarkers crossings={railroad.crossings ?? []} />
        <SoundWaves route={railroad.route.points} />
        <Train route={railroad.route.points} />
        {sensors.map((sensor, index) => {
          const reading = sensorReadings.find((item) => item.sensorId === sensor.id) ?? { sensorId: sensor.id, amplitude: 0.04, decibels: -60, distance: 0, delaySeconds: 0, frequency: 90, waveform: [] };
          const position = sensorScenePosition(railroad.route.points, sensor);
          return (
            <group key={sensor.id} position={position} scale={VISUAL_EXAGGERATION.sensorScale}>
              <Microphone sensor={sensor} reading={reading} selected={reading.amplitude > 0.45} />
              <Html
                position={[index === 0 ? -1.1 : index === 1 ? 1.1 : 0, 4.05 + index * 0.18, 0]}
                center
                distanceFactor={950}
                zIndexRange={[3, 0]}
                style={{ pointerEvents: "none" }}
              >
                <div className="scene-sensor-label"><strong>{sensor.label}</strong><span>{reading.decibels} dB</span></div>
              </Html>
            </group>
          );
        })}
        {(railroad.microphone_markers ?? []).map((marker) => (
          <group key={marker.id} position={marker.position} scale={VISUAL_EXAGGERATION.sensorScale}>
            <Microphone sensor={{ color: "#a94334" }} reading={{ amplitude: .04 }} selected={false} />
            <Html
              position={[0, 4.05, 0]}
              center
              distanceFactor={950}
              zIndexRange={[3, 0]}
              style={{ pointerEvents: "none" }}
            >
              <div className="scene-sensor-label"><strong>{marker.label}</strong></div>
            </Html>
          </group>
        ))}
        <Environment preset="park" environmentIntensity={0.35} />
        <CameraRig routeLength={railroad.route.length_m} />
      </Canvas>
    </div>
  );
}
