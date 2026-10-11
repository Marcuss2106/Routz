"use client";

import { useMemo } from "react";
import type { RailLine, RailroadPayload, ScenePoint } from "@/types/simulation";

const VIEW_WIDTH = 220;
const VIEW_HEIGHT = 112;
const VIEW_SPAN_M = 650;

function distance2d(first: ScenePoint, second: ScenePoint) {
  return Math.hypot(first[0] - second[0], first[2] - second[2]);
}

function routeDistances(points: ScenePoint[]) {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(distances[index - 1] + distance2d(points[index - 1], points[index]));
  }
  return distances;
}

function pointAt(points: ScenePoint[], distances: number[], distanceM: number): ScenePoint {
  const target = Math.max(0, Math.min(distanceM, distances.at(-1) ?? 0));
  let index = 1;
  while (index < distances.length - 1 && distances[index] < target) index += 1;
  const segmentM = distances[index] - distances[index - 1];
  const ratio = segmentM <= 0 ? 0 : (target - distances[index - 1]) / segmentM;
  return [
    points[index - 1][0] + (points[index][0] - points[index - 1][0]) * ratio,
    0,
    points[index - 1][2] + (points[index][2] - points[index - 1][2]) * ratio,
  ];
}

function touches(line: RailLine, point: ScenePoint) {
  return distance2d(line.points[0], point) <= 3 || distance2d(line.points.at(-1)!, point) <= 3;
}

function outwardVector(line: RailLine, junction: ScenePoint) {
  const fromStart = distance2d(line.points[0], junction) <= 3;
  const first = fromStart ? line.points[0] : line.points.at(-1)!;
  const second = fromStart ? line.points[1] : line.points.at(-2)!;
  return { x: second[0] - first[0], z: second[2] - first[2] };
}

function directionScore(line: RailLine, junction: ScenePoint, forward: ScenePoint) {
  const branch = outwardVector(line, junction);
  const route = { x: forward[0] - junction[0], z: forward[2] - junction[2] };
  const denominator = Math.hypot(branch.x, branch.z) * Math.hypot(route.x, route.z);
  return denominator === 0 ? -1 : (branch.x * route.x + branch.z * route.z) / denominator;
}

function project(point: ScenePoint, center: ScenePoint, spanM: number) {
  return {
    x: VIEW_WIDTH / 2 + ((point[0] - center[0]) / spanM) * VIEW_WIDTH,
    y: VIEW_HEIGHT / 2 + ((point[2] - center[2]) / spanM) * VIEW_HEIGHT,
  };
}

function displayName(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

interface JunctionPredictionProps {
  railroad: RailroadPayload;
  routeDistanceM: number;
  positionConfidence: number;
  directionConfidence: number;
  usingSimulationFallback: boolean;
}

export function JunctionPrediction({
  railroad,
  routeDistanceM,
  positionConfidence,
  directionConfidence,
  usingSimulationFallback,
}: JunctionPredictionProps) {
  const prediction = useMemo(() => {
    const route = railroad.route.points;
    if (route.length < 2) return null;
    const distances = routeDistances(route);
    const candidates = route.flatMap((point, index) => {
      if (index === 0 || index === route.length - 1 || distances[index] <= routeDistanceM + 4) return [];
      const connected = railroad.network.filter((line) => line.points.length > 1 && touches(line, point));
      return connected.length >= 3 ? [{ point, index, connected, distanceM: distances[index] }] : [];
    });
    const next = candidates.sort((left, right) => left.distanceM - right.distanceM)[0];
    if (!next) return null;
    const chosen = [...next.connected].sort(
      (left, right) => directionScore(right, next.point, route[next.index + 1]) - directionScore(left, next.point, route[next.index + 1]),
    )[0];
    const outgoingBranches = Math.max(1, next.connected.length - 1);
    const prior = 1 / outgoingBranches;
    const acousticConfidence = Math.max(0, Math.min(1, positionConfidence * 0.45 + directionConfidence * 0.55));
    const probability = Math.round((prior + (1 - prior) * acousticConfidence) * 100);
    return {
      ...next,
      chosen,
      probability,
      trainPoint: pointAt(route, distances, routeDistanceM),
      distanceAheadM: Math.max(0, next.distanceM - routeDistanceM),
    };
  }, [directionConfidence, positionConfidence, railroad, routeDistanceM]);

  if (!prediction) {
    return <div className="junction-card"><div className="junction-heading"><span>Route prediction</span><strong>NO JUNCTION AHEAD</strong></div></div>;
  }

  const viewSpanM = Math.max(VIEW_SPAN_M, prediction.distanceAheadM * 2.35);
  const routePoints = railroad.route.points.map((point) => project(point, prediction.point, viewSpanM));
  const train = project(prediction.trainPoint, prediction.point, viewSpanM);
  const nearbyLines = railroad.network.filter((line) => line.points.some((point) => distance2d(point, prediction.point) < viewSpanM * 0.8));
  const rawRouteName = prediction.chosen.name?.trim() || prediction.chosen.id.replace(/^rail-/, "Route ");
  const routeName = displayName(rawRouteName);

  return (
    <div className="junction-card">
      <div className="junction-heading">
        <span>Most likely junction route</span>
        <strong aria-label={`${prediction.probability} percent probability`}>{prediction.probability}%</strong>
      </div>
      <svg className="junction-map" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img" aria-label={`Top view of the next junction. Predicted route ${routeName} at ${prediction.probability} percent.`}>
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} rx="9" fill="#dad9cc" />
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {nearbyLines.map((line) => {
            const points = line.points.map((point) => {
              const mapped = project(point, prediction.point, viewSpanM);
              return `${mapped.x},${mapped.y}`;
            }).join(" ");
            return <polyline key={line.id} points={points} stroke="#777b70" strokeOpacity=".48" strokeWidth="2" />;
          })}
          <polyline points={routePoints.map((point) => `${point.x},${point.y}`).join(" ")} stroke="#a94334" strokeWidth="4" />
        </g>
        <circle cx={VIEW_WIDTH / 2} cy={VIEW_HEIGHT / 2} r="5" fill="#f0eee4" stroke="#78342d" strokeWidth="2.5" />
        <g transform={`translate(${train.x} ${train.y})`}>
          <circle r="6" fill="#26302d" stroke="#f0eee4" strokeWidth="2" />
          <path d="M0-3.5 3 2.5-3 2.5Z" fill="#f0eee4" />
        </g>
      </svg>
      <div className="junction-route-copy">
        <span>{routeName}</span>
        <strong>{Math.round(prediction.distanceAheadM)} m ahead</strong>
      </div>
      <p className="junction-caption">{usingSimulationFallback ? "Probability uses the equal-branch prior until acoustic tracking locks." : "Heuristic probability from acoustic position and direction confidence."}</p>
    </div>
  );
}
