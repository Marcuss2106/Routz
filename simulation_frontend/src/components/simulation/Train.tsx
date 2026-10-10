import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { sampleRoute, VEHICLE_OFFSETS_M, VISUAL_EXAGGERATION } from "@/lib/simulation";
import { useSimulationStore } from "@/stores/simulationStore";
import type { ScenePoint } from "@/types/simulation";

function Vehicle({ index, route }: { index: number; route: ScenePoint[] }) {
  const ref = useRef<THREE.Group>(null);
  const isEngine = index === 0;
  useFrame(() => {
    const { current, previous } = useSimulationStore.getState();
    if (!current || !ref.current) return;
    const elapsed = performance.now() - current.receivedAt;
    const interval = previous ? Math.max(50, current.receivedAt - previous.receivedAt) : 100;
    const alpha = Math.min(1, elapsed / interval);
    const priorDistance = previous?.value.distance_along_route_m ?? current.value.distance_along_route_m;
    const leadDistance = THREE.MathUtils.lerp(priorDistance, current.value.distance_along_route_m, alpha);
    const sample = sampleRoute(route, leadDistance - VEHICLE_OFFSETS_M[index]);
    ref.current.position.set(...sample.position);
    ref.current.rotation.y = sample.rotationY;
  });
  const scale = VISUAL_EXAGGERATION.trainScale;
  return (
    <group ref={ref} scale={scale}>
      {!isEngine && <>
        <mesh castShadow position={[0, 3, 0]}><boxGeometry args={[4.5, 3.5, 8.8]} /><meshStandardMaterial color={index % 2 ? "#bc4938" : "#a83b2e"} roughness={0.76} /></mesh>
        <mesh castShadow position={[0, 4.9, 0]}><boxGeometry args={[4.8, .35, 9.1]} /><meshStandardMaterial color="#78342d" roughness={.8} /></mesh>
        <mesh position={[0, 3.2, 4.43]}><boxGeometry args={[3.2, 1.7, .08]} /><meshStandardMaterial color="#d06a54" /></mesh>
      </>}
      {isEngine && <>
        <mesh castShadow position={[0, 3.1, -2.6]}><boxGeometry args={[4.6, 5.1, 4.3]} /><meshStandardMaterial color="#a83b2e" roughness={0.7} /></mesh>
        <mesh castShadow position={[0, 4.2, 2.6]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[2.15, 2.15, 7.4, 18]} /><meshStandardMaterial color="#b64232" roughness={.68} /></mesh>
        <mesh castShadow position={[0, 7.05, -2.6]}><boxGeometry args={[5.2, .45, 4.8]} /><meshStandardMaterial color="#6e302a" /></mesh>
        <mesh position={[0, 5.1, -4.78]}><boxGeometry args={[3.25, 1.65, .12]} /><meshStandardMaterial color="#253738" metalness={0.25} roughness={0.35} /></mesh>
        <mesh castShadow position={[0, 7.1, 3.2]}><cylinderGeometry args={[0.65, 1.0, 2.9, 14]} /><meshStandardMaterial color="#313832" /></mesh>
        <mesh castShadow position={[0, 3.4, 6.8]} rotation={[-Math.PI / 2, 0, 0]}><coneGeometry args={[2.05, 1.2, 18]} /><meshStandardMaterial color="#8d362d" /></mesh>
        <mesh position={[0, 4.2, 7.45]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[.6, .6, .22, 16]} /><meshStandardMaterial color="#f0c87b" emissive="#d58448" emissiveIntensity={1.2} /></mesh>
      </>}
      {[-3.2, 3.2].flatMap((z) => [-2.25, 2.25].map((x) => (
        <mesh key={`${x}-${z}`} castShadow position={[x, 1.15, z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[1.15, 1.15, 0.75, 12]} /><meshStandardMaterial color="#292d2a" roughness={0.8} />
        </mesh>
      )))}
      <mesh position={[0, 2.6, isEngine ? -5.7 : 5.7]}><boxGeometry args={[0.55, 0.45, 2.4]} /><meshStandardMaterial color="#353932" /></mesh>
    </group>
  );
}

export function Train({ route }: { route: ScenePoint[] }) {
  return <group>{VEHICLE_OFFSETS_M.map((_, index) => <Vehicle key={index} index={index} route={route} />)}</group>;
}
