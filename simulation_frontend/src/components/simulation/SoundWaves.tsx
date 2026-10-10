import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { sampleRoute, VEHICLE_OFFSETS_M } from "@/lib/simulation";
import { useSimulationStore } from "@/stores/simulationStore";
import type { ScenePoint } from "@/types/simulation";

function ExpandingRing({ route, vehicleIndex, delay }: { route: ScenePoint[]; vehicleIndex: number; delay: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const { current } = useSimulationStore.getState();
    if (!current || !ref.current || !material.current) return;
    const sample = sampleRoute(route, current.value.distance_along_route_m - VEHICLE_OFFSETS_M[vehicleIndex]);
    const cycle = (clock.elapsedTime * .34 + delay + vehicleIndex * .09) % 1;
    ref.current.position.set(sample.position[0], 2.1, sample.position[2]);
    ref.current.scale.setScalar(16 + cycle * 255);
    material.current.opacity = current.value.status === "running" ? Math.pow(1 - cycle, 1.7) * .62 : 0;
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[.91, 1, 96]} />
      <meshBasicMaterial ref={material} color="#b43e32" transparent opacity={.4} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
  );
}

export function SoundWaves({ route }: { route: ScenePoint[] }) {
  return <group>{VEHICLE_OFFSETS_M.flatMap((_, vehicleIndex) => [0, .33, .66].map((delay) => <ExpandingRing key={`${vehicleIndex}-${delay}`} route={route} vehicleIndex={vehicleIndex} delay={delay} />))}</group>;
}
