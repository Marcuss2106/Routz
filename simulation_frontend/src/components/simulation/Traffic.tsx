"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { trafficCarPose, type TrafficCar } from "@/lib/traffic";
import { useSimulationStore } from "@/stores/simulationStore";

function TrafficCarModel({ car }: { car: TrafficCar }) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!groupRef.current) return;
    const simulationTimeS = useSimulationStore.getState().current?.value.simulation_time_s ?? 0;
    const pose = trafficCarPose(car, simulationTimeS);
    groupRef.current.position.set(...pose.position);
    groupRef.current.position.y = 0.35;
    groupRef.current.rotation.y = pose.rotationY;
  });

  const cabinColor = car.kind === "pickup" ? "#343b3b" : "#d8d5c5";
  return (
    <group ref={groupRef}>
      <mesh castShadow position={[0, 1.05, 0]}>
        <boxGeometry args={[2.65, 0.82, 5.4]} />
        <meshStandardMaterial color={car.color} roughness={0.72} />
      </mesh>
      <mesh castShadow position={[0, 1.66, -0.28]}>
        <boxGeometry args={[2.18, 0.62, car.kind === "pickup" ? 2.05 : 2.45]} />
        <meshStandardMaterial color={cabinColor} roughness={0.55} metalness={0.08} />
      </mesh>
      <mesh position={[0, 1.67, 0.99]}>
        <boxGeometry args={[1.82, 0.34, 0.06]} />
        <meshStandardMaterial color="#273639" roughness={0.3} metalness={0.25} />
      </mesh>
      {[-1.38, 1.38].flatMap((x) => [-1.72, 1.72].map((z) => (
        <mesh key={`${x}-${z}`} castShadow position={[x, 0.54, z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.48, 0.48, 0.38, 12]} />
          <meshStandardMaterial color="#242a29" roughness={0.9} />
        </mesh>
      )))}
      <mesh position={[0, 1.08, 2.73]}>
        <boxGeometry args={[0.72, 0.18, 0.06]} />
        <meshStandardMaterial color="#f0ca79" emissive="#b36f38" emissiveIntensity={0.85} />
      </mesh>
    </group>
  );
}

export function TrafficLayer({ cars }: { cars: TrafficCar[] }) {
  return <group>{cars.map((car) => <TrafficCarModel key={car.id} car={car} />)}</group>;
}
