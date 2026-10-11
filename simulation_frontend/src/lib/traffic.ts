import {
  clamp,
  distanceOnGround,
  mapRouteDistanceToAcousticS,
  railPositionToGround,
} from "@/lib/geometry";
import type { GroundPosition, RoadLine, ScenePoint } from "@/types/simulation";

export type TrafficVehicleKind = "sedan" | "suv" | "pickup";

export interface TrafficCar {
  id: string;
  roadId: string;
  kind: TrafficVehicleKind;
  color: string;
  visualPath: ScenePoint[];
  acousticPath: GroundPosition[];
  speedMps: number;
  direction: 1 | -1;
  startDistanceM: number;
  audioGain: number;
  engineHz: number;
  phase: number;
}

export interface TrafficCarPose {
  position: ScenePoint;
  acousticPosition: GroundPosition;
  rotationY: number;
}

const MAX_RENDERED_CARS = 8;
const MIN_ROAD_LENGTH_M = 180;
const MAX_ROUTE_DISTANCE_M = 1_100;
const TRAFFIC_COLORS = ["#42647a", "#b8664b", "#6c765e", "#d0a15c", "#4b4c55"];
const TRAFFIC_SPECS: Record<TrafficVehicleKind, { audioGain: number; engineHz: number }> = {
  sedan: { audioGain: 0.58, engineHz: 92 },
  suv: { audioGain: 0.68, engineHz: 78 },
  pickup: { audioGain: 0.76, engineHz: 68 },
};

type RouteProjection = {
  distanceAlongRouteM: number;
  distanceM: number;
  lateralM: number;
  normalX: number;
  normalZ: number;
};

function pathLength(points: ScenePoint[]) {
  return points.reduce((total, point, index) => {
    if (index === 0) return total;
    return total + distanceOnGround(points[index - 1], point);
  }, 0);
}

function projectToRoute(point: ScenePoint, route: ScenePoint[]): RouteProjection {
  let best: RouteProjection = {
    distanceAlongRouteM: 0,
    distanceM: Number.POSITIVE_INFINITY,
    lateralM: 0,
    normalX: 0,
    normalZ: 1,
  };
  let routeDistanceM = 0;
  for (let index = 0; index < route.length - 1; index += 1) {
    const first = route[index];
    const second = route[index + 1];
    const dx = second[0] - first[0];
    const dz = second[2] - first[2];
    const length = Math.hypot(dx, dz);
    if (length < Number.EPSILON) continue;
    const ratio = clamp(((point[0] - first[0]) * dx + (point[2] - first[2]) * dz) / (length * length), 0, 1);
    const closestX = first[0] + dx * ratio;
    const closestZ = first[2] + dz * ratio;
    const tangentX = dx / length;
    const tangentZ = dz / length;
    const normalX = -tangentZ;
    const normalZ = tangentX;
    const offsetX = point[0] - closestX;
    const offsetZ = point[2] - closestZ;
    const distanceM = Math.hypot(offsetX, offsetZ);
    if (distanceM < best.distanceM) {
      best = {
        distanceAlongRouteM: routeDistanceM + ratio * length,
        distanceM,
        lateralM: offsetX * normalX + offsetZ * normalZ,
        normalX,
        normalZ,
      };
    }
    routeDistanceM += length;
  }
  return best;
}

function closestRoadProjection(points: ScenePoint[], route: ScenePoint[]) {
  return points.reduce<RouteProjection | null>((best, point) => {
    const candidate = projectToRoute(point, route);
    return !best || candidate.distanceM < best.distanceM ? candidate : best;
  }, null)!;
}

function toAcousticPath(points: ScenePoint[], route: ScenePoint[], routeLengthM: number): GroundPosition[] {
  return points.map((point) => {
    const projection = projectToRoute(point, route);
    const base = railPositionToGround(mapRouteDistanceToAcousticS(projection.distanceAlongRouteM, routeLengthM));
    // The renderer uses z=south while the acoustic frame uses y=north.
    return [
      base[0] + projection.normalX * projection.lateralM,
      0,
      base[2] - projection.normalZ * projection.lateralM,
    ];
  });
}

function samplePath(points: ScenePoint[], distanceM: number) {
  const lengthM = pathLength(points);
  if (points.length < 2 || lengthM < Number.EPSILON) {
    return { position: points[0] ?? [0, 0, 0] as ScenePoint, rotationY: 0 };
  }
  let remaining = ((distanceM % lengthM) + lengthM) % lengthM;
  for (let index = 0; index < points.length - 1; index += 1) {
    const first = points[index];
    const second = points[index + 1];
    const segmentLengthM = distanceOnGround(first, second);
    if (remaining <= segmentLengthM || index === points.length - 2) {
      const ratio = segmentLengthM < Number.EPSILON ? 0 : remaining / segmentLengthM;
      return {
        position: [
          first[0] + (second[0] - first[0]) * ratio,
          first[1] + (second[1] - first[1]) * ratio,
          first[2] + (second[2] - first[2]) * ratio,
        ] as ScenePoint,
        rotationY: Math.atan2(second[0] - first[0], second[2] - first[2]),
      };
    }
    remaining -= segmentLengthM;
  }
  return { position: points.at(-1)!, rotationY: 0 };
}

function sampleGroundPath(points: GroundPosition[], distanceM: number): GroundPosition {
  const lengthM = pathLength(points as ScenePoint[]);
  if (points.length < 2 || lengthM < Number.EPSILON) return points[0] ?? [0, 0, 0];
  let remaining = ((distanceM % lengthM) + lengthM) % lengthM;
  for (let index = 0; index < points.length - 1; index += 1) {
    const first = points[index];
    const second = points[index + 1];
    const segmentLengthM = distanceOnGround(first, second);
    if (remaining <= segmentLengthM || index === points.length - 2) {
      const ratio = segmentLengthM < Number.EPSILON ? 0 : remaining / segmentLengthM;
      return [
        first[0] + (second[0] - first[0]) * ratio,
        first[1] + (second[1] - first[1]) * ratio,
        first[2] + (second[2] - first[2]) * ratio,
      ];
    }
    remaining -= segmentLengthM;
  }
  return points.at(-1)!;
}

/** Build a small deterministic traffic population near the active rail route. */
export function buildTrafficCars(roads: RoadLine[], route: ScenePoint[]): TrafficCar[] {
  if (route.length < 2) return [];
  const routeLengthM = pathLength(route);
  const candidates = roads
    .filter((road) => road.ground_level && pathLength(road.points) >= MIN_ROAD_LENGTH_M)
    .map((road) => ({ road, projection: closestRoadProjection(road.points, route), lengthM: pathLength(road.points) }))
    .filter(({ projection }) => projection.distanceM <= MAX_ROUTE_DISTANCE_M)
    .sort((first, second) => first.projection.distanceM - second.projection.distanceM || first.road.id.localeCompare(second.road.id));

  const cars: TrafficCar[] = [];
  candidates.slice(0, Math.ceil(MAX_RENDERED_CARS / 2)).forEach(({ road, lengthM }, roadIndex) => {
    const kind: TrafficVehicleKind = roadIndex % 3 === 0 ? "suv" : roadIndex % 3 === 1 ? "sedan" : "pickup";
    const spec = TRAFFIC_SPECS[kind];
    const acousticPath = toAcousticPath(road.points, route, routeLengthM);
    [1, -1].forEach((direction, laneIndex) => {
      cars.push({
        id: `traffic-${roadIndex + 1}-${laneIndex + 1}`,
        roadId: road.id,
        kind,
        color: TRAFFIC_COLORS[(roadIndex + laneIndex) % TRAFFIC_COLORS.length],
        visualPath: road.points,
        acousticPath,
        speedMps: 7.5 + roadIndex * 1.4 + laneIndex * 1.8,
        direction: direction as 1 | -1,
        startDistanceM: lengthM * (0.18 + laneIndex * 0.48),
        audioGain: spec.audioGain,
        engineHz: spec.engineHz,
        phase: roadIndex * 1.31 + laneIndex * 2.17,
      });
    });
  });
  return cars;
}

export function trafficCarPose(car: TrafficCar, simulationTimeS: number): TrafficCarPose {
  const travelDistanceM = car.startDistanceM + car.direction * car.speedMps * simulationTimeS;
  const visual = samplePath(car.visualPath, travelDistanceM);
  const acousticPosition = sampleGroundPath(car.acousticPath, travelDistanceM);
  return {
    position: visual.position,
    acousticPosition,
    rotationY: visual.rotationY + (car.direction === 1 ? 0 : Math.PI),
  };
}
