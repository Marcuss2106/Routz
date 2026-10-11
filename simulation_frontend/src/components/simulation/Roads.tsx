import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { LineMaterial, LineSegments2, LineSegmentsGeometry } from "three-stdlib";
import type { RailCrossing, RoadLine } from "@/types/simulation";

const ROAD_DETAIL_ENTER_DISTANCE_M = 1900;
const ROAD_DETAIL_EXIT_DISTANCE_M = 2400;
const ROAD_DETAIL_FADE_SPEED = 5;

const ROAD_STYLE = {
  major: { width: 18, lineWidth: 3.1, color: 0xd6cfbb },
  medium: { width: 13, lineWidth: 2.45, color: 0xc7c2ae },
  local: { width: 8, lineWidth: 1.8, color: 0xb7b5a2 },
} as const;

const ROAD_CATEGORIES = ["local", "medium", "major"] as const;

function viewDistanceToGround(camera: THREE.Camera) {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  if (direction.y > -.04) return 60000;
  return Math.max(0, (camera.position.y + 1) / -direction.y);
}

function makeRoadLines(roads: RoadLine[], category: RoadLine["category"], height: number, material: LineMaterial, renderOrder: number) {
  const positions = roads
    .filter((road) => road.category === category)
    .flatMap((road) => road.points.slice(0, -1).flatMap((first, index) => {
      const second = road.points[index + 1];
      return [first[0], height, first[2], second[0], height, second[2]];
    }));
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const line = new LineSegments2(geometry, material);
  line.computeLineDistances();
  line.frustumCulled = false;
  line.renderOrder = renderOrder;
  return line;
}

function RoadInstances({
  roads,
  category,
  border,
  material,
}: {
  roads: RoadLine[];
  category: RoadLine["category"];
  border: boolean;
  material: THREE.MeshStandardMaterial;
}) {
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
          border ? -0.86 : -0.7,
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
    <instancedMesh ref={ref} args={[undefined, undefined, segments.length]} receiveShadow renderOrder={border ? 0 : 1} material={material}>
      <boxGeometry args={[style.width + (border ? 3 : 0), border ? .28 : .34, 1]} />
    </instancedMesh>
  );
}

export function RoadLayer({ roads }: { roads: RoadLine[] }) {
  const { camera, gl, size } = useThree();
  const detailActive = useRef(true);
  const detailMix = useRef(1);
  const detailedGroup = useRef<THREE.Group>(null);
  const overviewGroup = useRef<THREE.Group>(null);

  const detailedMaterials = useMemo(() => Object.fromEntries(ROAD_CATEGORIES.flatMap((category) => [
    [`${category}-border`, new THREE.MeshStandardMaterial({
      color: 0x77796e,
      roughness: .96,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    })],
    [category, new THREE.MeshStandardMaterial({
      color: ROAD_STYLE[category].color,
      roughness: .96,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    })],
  ])) as Record<string, THREE.MeshStandardMaterial>, []);

  const overviewMaterials = useMemo(() => Object.fromEntries(ROAD_CATEGORIES.flatMap((category) => [
    [`${category}-border`, new LineMaterial({
      color: 0x77796e,
      linewidth: ROAD_STYLE[category].lineWidth + 1.35,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
      alphaToCoverage: true,
      worldUnits: false,
    })],
    [category, new LineMaterial({
      color: ROAD_STYLE[category].color,
      linewidth: ROAD_STYLE[category].lineWidth,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
      alphaToCoverage: true,
      worldUnits: false,
    })],
  ])) as Record<string, LineMaterial>, []);

  const overviewLines = useMemo(() => ROAD_CATEGORIES.flatMap((category) => [
    makeRoadLines(roads, category, -.49, overviewMaterials[`${category}-border`], 0),
    makeRoadLines(roads, category, -.47, overviewMaterials[category], 1),
  ]), [overviewMaterials, roads]);

  useEffect(() => {
    const pixelRatio = gl.getPixelRatio();
    const width = size.width * pixelRatio;
    const height = size.height * pixelRatio;
    Object.values(overviewMaterials).forEach((material) => material.resolution.set(width, height));
  }, [gl, overviewMaterials, size.height, size.width]);

  useEffect(() => () => {
    overviewLines.forEach((line) => line.geometry.dispose());
    Object.values(overviewMaterials).forEach((material) => material.dispose());
    Object.values(detailedMaterials).forEach((material) => material.dispose());
  }, [detailedMaterials, overviewLines, overviewMaterials]);

  useFrame((_, delta) => {
    const distance = viewDistanceToGround(camera);
    if (detailActive.current && distance > ROAD_DETAIL_EXIT_DISTANCE_M) detailActive.current = false;
    else if (!detailActive.current && distance < ROAD_DETAIL_ENTER_DISTANCE_M) detailActive.current = true;

    const target = detailActive.current ? 1 : 0;
    detailMix.current = THREE.MathUtils.lerp(detailMix.current, target, 1 - Math.exp(-delta * ROAD_DETAIL_FADE_SPEED));
    const detailOpacity = THREE.MathUtils.smoothstep(detailMix.current, 0, 1);
    Object.values(detailedMaterials).forEach((material) => { material.opacity = detailOpacity; });
    Object.values(overviewMaterials).forEach((material) => { material.opacity = 1 - detailOpacity; });
    if (detailedGroup.current) detailedGroup.current.visible = detailOpacity > .01;
    if (overviewGroup.current) overviewGroup.current.visible = detailOpacity < .99;
  });

  return (
    <group>
      <group ref={overviewGroup}>
        {overviewLines.map((line, index) => <primitive key={`road-overview-${index}`} object={line} />)}
      </group>
      <group ref={detailedGroup}>
        {ROAD_CATEGORIES.map((category) => (
          <RoadInstances key={`${category}-border`} roads={roads} category={category} border material={detailedMaterials[`${category}-border`]} />
        ))}
        {ROAD_CATEGORIES.map((category) => (
          <RoadInstances key={category} roads={roads} category={category} border={false} material={detailedMaterials[category]} />
        ))}
      </group>
    </group>
  );
}

function CrossingMarker({ crossing }: { crossing: RailCrossing }) {
  return (
    <group position={crossing.position} rotation-y={crossing.rotation_y_rad}>
      <mesh position={[0, -0.78, 0]} receiveShadow renderOrder={2}>
        <boxGeometry args={[20, .5, 28]} />
        <meshStandardMaterial color="#d6cfbb" roughness={.92} depthWrite={false} />
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
