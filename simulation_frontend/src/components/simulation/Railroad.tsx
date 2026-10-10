import { Line } from "@react-three/drei";
import { useMemo } from "react";

import {
  TRACK_LENGTH_M,
  railPointAtS,
  railTangentAtS,
} from "@/lib/geometry";

export function Railroad() {
  const railLines = useMemo(() => {
    const points = Array.from({ length: Math.floor(TRACK_LENGTH_M / 12) + 1 }, (_, index) => {
      const sM = Math.min(TRACK_LENGTH_M, index * 12);
      const point = railPointAtS(sM);
      const tangent = railTangentAtS(sM);
      return {
        left: [point.x_m - tangent.north * 0.72, 0.08, point.y_m + tangent.east * 0.72] as [number, number, number],
        right: [point.x_m + tangent.north * 0.72, 0.08, point.y_m - tangent.east * 0.72] as [number, number, number],
      };
    });
    const left = points.map((point) => point.left);
    const right = points.map((point) => point.right);
    return { left, right };
  }, []);

  const sleepers = useMemo(
    () =>
      Array.from({ length: Math.floor(TRACK_LENGTH_M / 12) + 1 }, (_, index) => {
        const sM = index * 12;
        const point = railPointAtS(sM);
        const tangent = railTangentAtS(sM);
        return {
          position: [point.x_m, 0.01, point.y_m] as [number, number, number],
          rotation: Math.atan2(tangent.north, tangent.east),
        };
      }),
    [],
  );

  return (
    <group>
      <Line points={railLines.left} color="#8ea0b5" lineWidth={3} />
      <Line points={railLines.right} color="#8ea0b5" lineWidth={3} />
      {sleepers.map((sleeper, index) => (
        <mesh
          key={`sleeper-${index}`}
          position={sleeper.position}
          rotation={[0, -sleeper.rotation, 0]}
          receiveShadow
        >
          <boxGeometry args={[2.8, 0.08, 0.32]} />
          <meshStandardMaterial color="#4b3b35" roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}
