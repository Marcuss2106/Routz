import { useMemo } from "react";

const TRACK_HALF_LENGTH = 7.7;

export function Railroad() {
  const sleepers = useMemo(
    () =>
      Array.from({ length: 25 }, (_, index) =>
        -TRACK_HALF_LENGTH + 0.3 + index * 0.64,
      ),
    [],
  );

  return (
    <group>
      <mesh position={[0, 0.08, -0.42]} receiveShadow>
        <boxGeometry args={[TRACK_HALF_LENGTH * 2, 0.12, 0.08]} />
        <meshStandardMaterial color="#8ea0b5" metalness={0.85} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.08, 0.42]} receiveShadow>
        <boxGeometry args={[TRACK_HALF_LENGTH * 2, 0.12, 0.08]} />
        <meshStandardMaterial color="#8ea0b5" metalness={0.85} roughness={0.3} />
      </mesh>
      {sleepers.map((x) => (
        <mesh key={x} position={[x, 0.01, 0]} receiveShadow>
          <boxGeometry args={[0.26, 0.08, 1.35]} />
          <meshStandardMaterial color="#4b3b35" roughness={0.95} />
        </mesh>
      ))}
      <mesh position={[0, -0.025, 0]} receiveShadow>
        <boxGeometry args={[TRACK_HALF_LENGTH * 2 + 1, 0.06, 1.5]} />
        <meshStandardMaterial color="#151c29" roughness={1} />
      </mesh>
    </group>
  );
}
