import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { RailCrossing, RoadLine } from "@/types/simulation";

const ROAD_STYLE = {
  major: { width: 18, color: "#d6cfbb" },
  medium: { width: 13, color: "#c7c2ae" },
  local: { width: 8, color: "#b7b5a2" },
} as const;

function RoadInstances({ roads, category, border = false }: { roads: RoadLine[]; category: RoadLine["category"]; border?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const segments = useMemo(() => roads
    .filter((road) => road.category === category)
    .flatMap((road) => road.points.slice(0, -1).map((first, index) => {
      const second = road.points[index + 1];
      const dx = second[0] - first[0];
      const dz = second[2] - first[2];
      return {
        position: new THREE.Vector3(
          (first[0] + second[0]) / 2,
          road.elevation_m + (border ? -.05 : .2),
          (first[2] + second[2]) / 2,
        ),
        angle: Math.atan2(dx, dz),
        length: Math.hypot(dx, dz) + 1,
      };
    })), [category, roads, border]);

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    segments.forEach((segment, index) => {
      dummy.position.copy(segment.position);
      dummy.rotation.set(0, segment.angle, 0);
      dummy.scale.set(1, 1, segment.length);
      dummy.updateMatrix();
      ref.current?.setMatrixAt(index, dummy.matrix);
    });
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true;
  }, [segments]);

  const style = ROAD_STYLE[category];
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, segments.length]} receiveShadow>
      <boxGeometry args={[style.width + (border ? 3 : 0), border ? .28 : .34, 1]} />
      <meshStandardMaterial color={border ? "#77796e" : style.color} roughness={.96} />
    </instancedMesh>
  );
}

export function RoadLayer({ roads }: { roads: RoadLine[] }) {
  return (
    <group>
      {(["local", "medium", "major"] as const).map((category) => <RoadInstances key={`${category}-border`} roads={roads} category={category} border />)}
      {(["local", "medium", "major"] as const).map((category) => <RoadInstances key={category} roads={roads} category={category} />)}
    </group>
  );
}

function CrossingMarker({ crossing }: { crossing: RailCrossing }) {
  return (
    <group position={crossing.position} rotation-y={crossing.rotation_y_rad}>
      <mesh position={[0, 1.3, 0]} receiveShadow>
        <boxGeometry args={[20, .5, 28]} />
        <meshStandardMaterial color="#9d7e68" roughness={.82} />
      </mesh>
      {[-13, 13].map((side) => (
        <group key={side} position={[side, 0, 0]}>
          <mesh castShadow position={[0, 7, 0]}>
            <cylinderGeometry args={[.65, .85, 14, 10]} />
            <meshStandardMaterial color="#4f554e" metalness={.35} roughness={.55} />
          </mesh>
          <mesh castShadow position={[0, 13.7, 0]} rotation={[0, 0, Math.PI / 4]}>
            <boxGeometry args={[8, 1.25, .7]} />
            <meshStandardMaterial color="#eee9d9" roughness={.72} />
          </mesh>
          <mesh castShadow position={[0, 13.7, 0]} rotation={[0, 0, -Math.PI / 4]}>
            <boxGeometry args={[8, 1.25, .7]} />
            <meshStandardMaterial color="#eee9d9" roughness={.72} />
          </mesh>
          <mesh position={[0, 10.7, .65]}>
            <sphereGeometry args={[1.15, 12, 12]} />
            <meshStandardMaterial color="#a94334" emissive="#7c2822" emissiveIntensity={.65} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function CrossingMarkers({ crossings }: { crossings: RailCrossing[] }) {
  return <group>{crossings.map((crossing) => <CrossingMarker key={crossing.id} crossing={crossing} />)}</group>;
}
