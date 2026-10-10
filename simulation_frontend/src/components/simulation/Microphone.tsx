"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

import type { AudioSensor, SensorReading } from "@/types/simulation";

export function Microphone({
  sensor,
  reading,
  selected,
}: {
  sensor: AudioSensor;
  reading: SensorReading;
  selected: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const beaconRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(() => {
    if (groupRef.current) {
      const scale = 1 + reading.amplitude * 0.1;
      groupRef.current.scale.setScalar(scale);
    }
    if (beaconRef.current) {
      beaconRef.current.emissiveIntensity = 0.7 + reading.amplitude * 2.2;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh position={[0, 0.14, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.48, 0.58, 0.22, 24]} />
        <meshStandardMaterial
          color={selected ? "#ffffff" : "#17243a"}
          roughness={0.38}
          metalness={0.7}
        />
      </mesh>
      <mesh position={[0, 0.62, 0]} castShadow>
        <cylinderGeometry args={[0.075, 0.11, 0.9, 16]} />
        <meshStandardMaterial color={sensor.color} metalness={0.3} />
      </mesh>
      <mesh position={[0, 1.14, 0]} castShadow>
        <sphereGeometry args={[0.18, 20, 20]} />
        <meshStandardMaterial
          ref={beaconRef}
          color={sensor.color}
          emissive={sensor.color}
          emissiveIntensity={1.4}
        />
      </mesh>
      <mesh position={[0, 0.27, 0]}>
        <torusGeometry args={[selected ? 0.64 : 0.54, 0.025, 8, 40]} />
        <meshBasicMaterial color={sensor.color} transparent opacity={0.8} />
      </mesh>
    </group>
  );
}
