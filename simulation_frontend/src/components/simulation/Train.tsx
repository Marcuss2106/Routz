"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

import type { TrainState } from "@/types/simulation";

export function Train({ trainState }: { trainState: TrainState }) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.position.y = trainState.position[1] + Math.sin(clock.elapsedTime * 8) * 0.012;
    }
  });

  return (
    <group
      ref={groupRef}
      position={trainState.position}
      scale={[trainState.direction, 1, 1]}
    >
      <mesh position={[0.2, 0.38, 0]} castShadow>
        <boxGeometry args={[2.25, 0.75, 0.95]} />
        <meshStandardMaterial color="#d4574f" metalness={0.55} roughness={0.35} />
      </mesh>
      <mesh position={[0.6, 0.95, 0]} castShadow>
        <boxGeometry args={[0.8, 0.45, 0.9]} />
        <meshStandardMaterial color="#26364d" metalness={0.4} roughness={0.45} />
      </mesh>
      <mesh position={[1.35, 0.28, 0]} castShadow>
        <boxGeometry args={[0.28, 0.42, 0.98]} />
        <meshStandardMaterial color="#f0a765" emissive="#ff6c3d" emissiveIntensity={1.1} />
      </mesh>
      <mesh position={[-1.45, 0.38, 0]} castShadow>
        <boxGeometry args={[1.1, 0.68, 0.88]} />
        <meshStandardMaterial color="#b84642" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[-2.35, 0.34, 0]} castShadow>
        <boxGeometry args={[0.52, 0.6, 0.82]} />
        <meshStandardMaterial color="#b84642" metalness={0.5} roughness={0.4} />
      </mesh>
      {[-0.65, 0.75, -1.8, -2.65].map((x) => (
        <mesh key={x} position={[x, -0.08, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.22, 0.22, 0.14, 20]} />
          <meshStandardMaterial color="#141b25" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}
      <pointLight position={[1.55, 0.35, 0]} color="#ff7654" intensity={2} distance={3} />
    </group>
  );
}
