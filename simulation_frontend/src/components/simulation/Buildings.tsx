import type { SceneLandmark } from "@/types/simulation";

function Building({ landmark }: { landmark: SceneLandmark }) {
  const [width, height, depth] = landmark.dimensions_m;
  return (
    <group position={landmark.position} rotation-y={landmark.rotation_y_rad}>
      <mesh castShadow receiveShadow position={[0, -1 + height / 2, 0]}>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color="#b9c0a5" roughness={0.94} />
      </mesh>
      <mesh receiveShadow position={[0, height - 0.65, 0]}>
        <boxGeometry args={[width * 0.92, 1.2, depth * 0.9]} />
        <meshStandardMaterial color="#a9ae99" roughness={0.9} />
      </mesh>
    </group>
  );
}

export function BuildingLayer({ landmarks }: { landmarks: SceneLandmark[] }) {
  return <group>{landmarks.map((landmark) => <Building key={landmark.id} landmark={landmark} />)}</group>;
}
