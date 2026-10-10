import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Line2, LineGeometry, LineMaterial } from "three-stdlib";
import { VISUAL_EXAGGERATION } from "@/lib/simulation";
import type { RailLine, ScenePoint } from "@/types/simulation";

const DETAIL_ENTER_DISTANCE_M = 1800;
const DETAIL_EXIT_DISTANCE_M = 2250;
const DETAIL_FADE_SPEED = 5;

function offsetPath(points: ScenePoint[], offset: number, height: number): ScenePoint[] {
  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const dx = after[0] - before[0];
    const dz = after[2] - before[2];
    const length = Math.hypot(dx, dz) || 1;
    return [point[0] - (dz / length) * offset, height, point[2] + (dx / length) * offset];
  });
}

function makeLine(points: ScenePoint[], material: LineMaterial) {
  const geometry = new LineGeometry();
  geometry.setPositions(points.flatMap(([x, y, z]) => [x, y, z]));
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.frustumCulled = false;
  line.renderOrder = 3;
  return line;
}

function viewDistanceToGround(camera: THREE.Camera) {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  if (direction.y > -.04) return 60000;
  return Math.max(0, (camera.position.y - 2) / -direction.y);
}

function SleeperInstances({ lines, material }: { lines: RailLine[]; material: THREE.MeshStandardMaterial }) {
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
          items.push({ position: new THREE.Vector3(a[0] + (dx * at) / length, 1.15, a[2] + (dz * at) / length), angle: Math.atan2(dx, dz) });
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

  useFrame(() => {
    if (ref.current) ref.current.visible = material.opacity > .01;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, sleepers.length]} receiveShadow material={material} renderOrder={2}>
      <boxGeometry args={[VISUAL_EXAGGERATION.sleeperLengthM, 1.2, VISUAL_EXAGGERATION.sleeperWidthM]} />
    </instancedMesh>
  );
}

export function Railroad({ lines, route }: { lines: RailLine[]; route: ScenePoint[] }) {
  const { camera, gl, size } = useThree();
  const detailActive = useRef(true);
  const detailMix = useRef(1);
  const detailedGroup = useRef<THREE.Group>(null);
  const overviewGroup = useRef<THREE.Group>(null);
  const gauge = VISUAL_EXAGGERATION.railGaugeM / 2;

  const detailedMaterial = useMemo(() => new LineMaterial({
    color: 0x625e56,
    linewidth: 1.35,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
    alphaToCoverage: true,
    worldUnits: false,
  }), []);
  const overviewMaterial = useMemo(() => new LineMaterial({
    color: 0x595951,
    linewidth: 1.65,
    transparent: true,
    opacity: 0,
    depthTest: true,
    depthWrite: false,
    alphaToCoverage: true,
    worldUnits: false,
  }), []);
  const routeMaterial = useMemo(() => new LineMaterial({
    color: 0xd48a64,
    linewidth: 2.5,
    transparent: true,
    opacity: .74,
    depthTest: true,
    depthWrite: false,
    alphaToCoverage: true,
    worldUnits: false,
  }), []);
  const sleeperMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: 0x6c6354,
    roughness: .9,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  }), []);
  const lodMaterials = useRef({ detailedMaterial, overviewMaterial, sleeperMaterial });

  const detailedRails = useMemo(() => lines.flatMap((line) => [
    makeLine(offsetPath(line.points, gauge, 2.25), detailedMaterial),
    makeLine(offsetPath(line.points, -gauge, 2.25), detailedMaterial),
  ]), [detailedMaterial, gauge, lines]);
  const overviewRails = useMemo(() => lines.map((line) =>
    makeLine(line.points.map(([x, , z]) => [x, 2.65, z]), overviewMaterial)
  ), [lines, overviewMaterial]);
  const routeLine = useMemo(() => makeLine(route.map(([x, , z]) => [x, 3.2, z]), routeMaterial), [route, routeMaterial]);

  useEffect(() => {
    const pixelRatio = gl.getPixelRatio();
    const width = size.width * pixelRatio;
    const height = size.height * pixelRatio;
    lodMaterials.current.detailedMaterial.resolution.set(width, height);
    lodMaterials.current.overviewMaterial.resolution.set(width, height);
    routeMaterial.resolution.set(width, height);
  }, [gl, routeMaterial, size.height, size.width]);

  useEffect(() => () => {
    detailedRails.forEach((line) => line.geometry.dispose());
    overviewRails.forEach((line) => line.geometry.dispose());
    routeLine.geometry.dispose();
    detailedMaterial.dispose();
    overviewMaterial.dispose();
    routeMaterial.dispose();
    sleeperMaterial.dispose();
  }, [detailedMaterial, detailedRails, overviewMaterial, overviewRails, routeLine, routeMaterial, sleeperMaterial]);

  useFrame((_, delta) => {
    const distance = viewDistanceToGround(camera);
    if (detailActive.current && distance > DETAIL_EXIT_DISTANCE_M) detailActive.current = false;
    else if (!detailActive.current && distance < DETAIL_ENTER_DISTANCE_M) detailActive.current = true;
    const target = detailActive.current ? 1 : 0;
    detailMix.current = THREE.MathUtils.lerp(detailMix.current, target, 1 - Math.exp(-delta * DETAIL_FADE_SPEED));
    const detailOpacity = THREE.MathUtils.smoothstep(detailMix.current, 0, 1);
    lodMaterials.current.detailedMaterial.opacity = detailOpacity;
    lodMaterials.current.sleeperMaterial.opacity = detailOpacity;
    lodMaterials.current.overviewMaterial.opacity = 1 - detailOpacity;
    if (detailedGroup.current) detailedGroup.current.visible = detailOpacity > .01;
    if (overviewGroup.current) overviewGroup.current.visible = detailOpacity < .99;
  });

  return (
    <group>
      <SleeperInstances lines={lines} material={sleeperMaterial} />
      <group ref={overviewGroup}>{overviewRails.map((line, index) => <primitive key={`overview-${lines[index].id}`} object={line} />)}</group>
      <group ref={detailedGroup}>{detailedRails.map((line, index) => <primitive key={`detail-${index}`} object={line} />)}</group>
      <primitive object={routeLine} />
    </group>
  );
}
