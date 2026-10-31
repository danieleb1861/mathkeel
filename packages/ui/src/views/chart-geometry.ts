import type { Fog, Point } from "../model/layout";

/** Polyline with softened corners, like a course drawn with a flexible rule. */
export function roundedPath(points: readonly Point[], radius = 9): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let path = `M${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  for (let index = 0; index < rest.length; index += 1) {
    const here = rest[index] as Point;
    const before = (index === 0 ? first : rest[index - 1]) as Point;
    const after = rest[index + 1];
    if (!after) {
      path += `L${here.x.toFixed(1)} ${here.y.toFixed(1)}`;
      continue;
    }
    const inLength = Math.hypot(here.x - before.x, here.y - before.y);
    const outLength = Math.hypot(after.x - here.x, after.y - here.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 0.5) {
      path += `L${here.x.toFixed(1)} ${here.y.toFixed(1)}`;
      continue;
    }
    const enter = {
      x: here.x - ((here.x - before.x) / inLength) * r,
      y: here.y - ((here.y - before.y) / inLength) * r,
    };
    const leave = {
      x: here.x + ((after.x - here.x) / outLength) * r,
      y: here.y + ((after.y - here.y) / outLength) * r,
    };
    path += `L${enter.x.toFixed(1)} ${enter.y.toFixed(1)}`;
    path += `Q${here.x.toFixed(1)} ${here.y.toFixed(1)} ${leave.x.toFixed(1)} ${leave.y.toFixed(1)}`;
  }
  return path;
}

/** A link between two marks in one column, bowed into the gutter on the left. */
export function arcPath(from: Point, to: Point): string {
  const bow = 14 + Math.min(18, Math.abs(to.y - from.y) / 14);
  const x = from.x - bow;
  return `M${from.x} ${from.y}C${x} ${from.y} ${x} ${to.y} ${to.x} ${to.y}`;
}

/** Deterministic, zero-mean shoreline: the edge wanders but the area stays exact. */
export function shoreline(fog: Fog, inset = 0): string {
  const steps = Math.max(12, Math.round(fog.height / 18));
  const amplitude = Math.min(16, fog.width * 0.14);
  const points: string[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const y = fog.y + t * fog.height;
    const wander =
      Math.sin(t * Math.PI * 2 * 2) * 0.55 +
      Math.sin(t * Math.PI * 2 * 5 + 1.1) * 0.3 +
      Math.sin(t * Math.PI * 2 * 11 + 2.3) * 0.15;
    points.push(`${(fog.x + inset + wander * amplitude).toFixed(1)} ${y.toFixed(1)}`);
  }
  return points.join("L");
}

export function fogPath(fog: Fog): string {
  const right = fog.x + fog.width;
  return `M${shoreline(fog)}L${right} ${fog.y + fog.height}L${right} ${fog.y}Z`;
}
