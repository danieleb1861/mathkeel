import { UsageError } from "./errors.js";
import { allAnchors } from "./mapio.js";
import { toRepoPath } from "./repo.js";
import type { MapFile, MapNode, NodeKind } from "./types.js";

export interface ImpactResult {
  target: string;
  direct: string[];
  downstream: string[];
}

function dependants(map: MapFile): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const node of map.nodes) {
    for (const dep of node.depends_on) reverse.set(dep, [...(reverse.get(dep) ?? []), node.id]);
  }
  return reverse;
}

function reach(start: string[], edges: (id: string) => string[]): string[] {
  const seen = new Set<string>();
  const pending = [...start];
  while (pending.length > 0) {
    const id = pending.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...edges(id));
  }
  return [...seen];
}

function touches(node: MapNode, target: string, rel: string | null): boolean {
  const byAnchor = allAnchors(node).some(({ anchor }) => {
    const qualified = anchor.symbol === null ? null : `${anchor.path}::${anchor.symbol}`;
    return anchor.path === rel || anchor.symbol === target || qualified === target;
  });
  return byAnchor || node.verified_by.some((ref) => ref === target || ref.split("::")[0] === rel);
}

/** Mapped nodes that anchor a file or symbol, and the nodes downstream of them. */
export function impact(map: MapFile, target: string): ImpactResult {
  const rel = toRepoPath(target);
  const direct = map.nodes.filter((n) => touches(n, target, rel)).map((n) => n.id);
  const reverse = dependants(map);
  const downstream = reach(direct, (id) => reverse.get(id) ?? []).filter((id) => !direct.includes(id));
  return { target, direct, downstream };
}

const STAGE_ORDER = ["assumption", "equation", "code", "test"] as const;
export type TraceStage = (typeof STAGE_ORDER)[number];

const STAGE_OF: Record<NodeKind, TraceStage> = {
  assumption: "assumption",
  convention: "assumption",
  definition: "assumption",
  parameter: "assumption",
  closed_list: "assumption",
  equation: "equation",
  lemma: "equation",
  theorem: "equation",
  code: "code",
  test: "test",
};

export interface TraceStep {
  stage: TraceStage;
  id: string;
  kind: NodeKind;
  title: string;
  anchors: string[];
  verifiedBy: string[];
}

/** Every node on a path through `id`, ordered assumption -> equation -> code -> test. */
export function trace(map: MapFile, id: string): TraceStep[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  if (!byId.has(id)) throw new UsageError(`unknown node ${id}`);
  const reverse = dependants(map);
  const upstream = reach([id], (n) => byId.get(n)?.depends_on ?? []);
  const downstream = reach([id], (n) => reverse.get(n) ?? []);
  const members = new Set([...upstream, ...downstream]);

  const order: string[] = [];
  const placed = new Set<string>();
  const place = (nodeId: string): void => {
    if (placed.has(nodeId) || !members.has(nodeId)) return;
    placed.add(nodeId);
    (byId.get(nodeId)?.depends_on ?? []).forEach(place);
    order.push(nodeId);
  };
  map.nodes.forEach((n) => place(n.id));

  const steps = order.map((nodeId): TraceStep => {
    const node = byId.get(nodeId) as MapNode;
    return {
      stage: STAGE_OF[node.kind],
      id: node.id,
      kind: node.kind,
      title: node.title,
      anchors: allAnchors(node).map(({ anchor, kind }) => {
        const symbol = anchor.symbol === null ? "" : `#${anchor.symbol}`;
        return `${kind} ${anchor.path}${symbol}`;
      }),
      verifiedBy: node.verified_by,
    };
  });
  const rank = (step: TraceStep): number => STAGE_ORDER.indexOf(step.stage);
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => rank(a.step) - rank(b.step) || a.index - b.index)
    .map(({ step }) => step);
}
