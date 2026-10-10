"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

import type { TrainState } from "@/types/simulation";

export function Train({ trainState }: { trainState: TrainState }) {
  const groupRef = useRef<THREE.Group>(null);
  const carCount = useMemo(() => Math.max(3, Math.round(trainState.lengthM / 16)), [trainState.lengthM]);
  const carLength = trainState.lengthM / carCount;

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.position.y = trainState.position[1] + Math.sin(clock.elapsedTime * 8) * 0.012;
    }
  });

  return (
    <group
      ref={groupRef}
      position={trainState.position}
      rotation={[0, -trainState.headingRadians, 0]}
    >
      {Array.from({ length: carCount }, (_, index) => {
        const offset = (index - (carCount - 1) / 2) * carLength;
        const locomotive = index === carCount - 1;
        return (
          <group key={`car-${index}`} position={[offset, 0, 0]}>
            <mesh position={[0, 1.8, 0]} castShadow>
              <boxGeometry args={[carLength * 0.88, 3.2, 3.2]} />
              <meshStandardMaterial
                color={locomotive ? "#d4574f" : "#b84642"}
                metalness={0.55}
                roughness={0.35}
              />
            </mesh>
            <mesh position={[0, 3.8, 0]} castShadow>
              <boxGeometry args={[carLength * 0.42, 1.0, 2.8]} />
              <meshStandardMaterial color="#26364d" metalness={0.4} roughness={0.45} />
            </mesh>
            {[-carLength * 0.28, carLength * 0.28].map((wheelOffset) => (
              <mesh
                key={wheelOffset}
                position={[wheelOffset, 0.7, 0]}
                rotation={[Math.PI / 2, 0, 0]}
                castShadow
              >
                <cylinderGeometry args={[0.85, 0.85, 0.32, 20]} />
                <meshStandardMaterial color="#141b25" metalness={0.7} roughness={0.3} />
              </mesh>
            ))}
            {locomotive && (
              <mesh position={[carLength * 0.42, 1.6, 0]}>
                <boxGeometry args={[0.18, 0.8, 1.8]} />
                <meshStandardMaterial color="#f0a765" emissive="#ff6c3d" emissiveIntensity={1.1} />
              </mesh>
            )}
          </group>
        );
      })}
      <pointLight position={[trainState.lengthM / 2, 1.6, 0]} color="#ff7654" intensity={4} distance={80} />
    </group>
  );
}
