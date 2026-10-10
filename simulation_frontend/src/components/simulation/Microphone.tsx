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
      <mesh position={[0, 0.18, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.15, .36, 1.15]} />
        <meshStandardMaterial color="#4b5149" roughness={0.72} metalness={0.2} />
      </mesh>
      <mesh position={[0, 1.55, 0]} castShadow>
        <cylinderGeometry args={[0.11, 0.15, 2.55, 12]} />
        <meshStandardMaterial color="#626960" metalness={0.55} roughness={.42} />
      </mesh>
      <mesh position={[0, 2.72, 0]} castShadow>
        <boxGeometry args={[1.05, .78, .72]} />
        <meshStandardMaterial color={selected ? "#eeeadd" : "#343c37"} roughness={.38} metalness={.35} />
      </mesh>
      <mesh position={[0, 2.74, .38]} castShadow rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[.23, .23, .16, 24]} />
        <meshStandardMaterial
          ref={beaconRef}
          color={sensor.color}
          emissive={sensor.color}
          emissiveIntensity={1.4}
        />
      </mesh>
      <mesh position={[0, 3.24, 0]}>
        <sphereGeometry args={[.16, 18, 18]} />
        <meshStandardMaterial color={sensor.color} emissive={sensor.color} emissiveIntensity={selected ? 2.6 : 1.2} />
      </mesh>
      <mesh position={[0, 0.38, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[selected ? .74 : .62, selected ? .82 : .7, 48]} />
        <meshBasicMaterial color={sensor.color} transparent opacity={0.8} />
      </mesh>
    </group>
  );
}
