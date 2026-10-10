import { Line } from "@react-three/drei";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { VISUAL_EXAGGERATION } from "@/lib/simulation";
import type { RailLine, ScenePoint } from "@/types/simulation";

function offsetPath(points: ScenePoint[], offset: number): ScenePoint[] {
  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const dx = after[0] - before[0];
    const dz = after[2] - before[2];
    const length = Math.hypot(dx, dz) || 1;
    return [point[0] - (dz / length) * offset, 2, point[2] + (dx / length) * offset];
  });
}

function SleeperInstances({ lines }: { lines: RailLine[] }) {
  const sleepers = useMemo(() => {
    const items: { position: THREE.Vector3; angle: number }[] = [];
    for (const line of lines) {
      let carried = 0;
      for (let index = 0; index < line.points.length - 1; index += 1) {
        const a = line.points[index];
        const b = line.points[index + 1];
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const length = Math.hypot(dx, dz);
        for (let at = VISUAL_EXAGGERATION.sleeperSpacingM - carried; at < length; at += VISUAL_EXAGGERATION.sleeperSpacingM) {
          items.push({ position: new THREE.Vector3(a[0] + (dx * at) / length, 1, a[2] + (dz * at) / length), angle: Math.atan2(dx, dz) });
        }
        carried = (carried + length) % VISUAL_EXAGGERATION.sleeperSpacingM;
      }
    }
    return items;
  }, [lines]);
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    sleepers.forEach((sleeper, index) => {
      dummy.position.copy(sleeper.position);
      dummy.rotation.set(0, sleeper.angle, 0);
      dummy.updateMatrix();
      ref.current?.setMatrixAt(index, dummy.matrix);
    });
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true;
  }, [sleepers]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, sleepers.length]} receiveShadow>
      <boxGeometry args={[VISUAL_EXAGGERATION.sleeperLengthM, 1.5, VISUAL_EXAGGERATION.sleeperWidthM]} />
      <meshStandardMaterial color="#6c6354" roughness={0.9} />
    </instancedMesh>
  );
}

export function Railroad({ lines, route }: { lines: RailLine[]; route: ScenePoint[] }) {
  const gauge = VISUAL_EXAGGERATION.railGaugeM / 2;
  return (
    <group>
      <SleeperInstances lines={lines} />
      {lines.map((line) => (
        <group key={line.id}>
          <Line points={offsetPath(line.points, gauge)} color="#625e56" lineWidth={1.2} />
          <Line points={offsetPath(line.points, -gauge)} color="#625e56" lineWidth={1.2} />
        </group>
      ))}
      <Line points={route.map(([x, , z]) => [x, 4, z])} color="#d48a64" lineWidth={2.4} transparent opacity={0.72} />
    </group>
  );
}
