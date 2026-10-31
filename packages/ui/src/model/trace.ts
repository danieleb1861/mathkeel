import type { Snapshot, SnapshotNode } from "../snapshot";

export interface Graph {
  byId: ReadonlyMap<string, SnapshotNode>;
  /** Direct dependencies that exist in the snapshot. */
  parents: ReadonlyMap<string, readonly string[]>;
  /** Direct dependents. */
  children: ReadonlyMap<string, readonly string[]>;
  /** Sounding: how many results sit downstream of each node. */
  soundings: ReadonlyMap<string, number>;
}

export function buildGraph(snapshot: Pick<Snapshot, "nodes">): Graph {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    children.set(node.id, children.get(node.id) ?? []);
    const known = node.depends_on.filter((id) => byId.has(id) && id !== node.id);
    parents.set(node.id, known);
    for (const parent of known) {
      const list = children.get(parent) ?? [];
      list.push(node.id);
      children.set(parent, list);
    }
  }
  const soundings = new Map<string, number>();
  for (const id of byId.keys()) soundings.set(id, reach(id, children).size);
  return { byId, parents, children, soundings };
}

/** Everything reachable from `start`, excluding `start`. Safe on cycles. */
export function reach(start: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === start || seen.has(id)) continue;
    seen.add(id);
    stack.push(...(edges.get(id) ?? []));
  }
  return seen;
}

/** Breadth-first levels from `start`; level 0 is the nearest neighbours. */
export function levels(start: string, edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const seen = new Set<string>([start]);
  const out: string[][] = [];
  let frontier = edges.get(start) ?? [];
  while (frontier.length > 0) {
    const level: string[] = [];
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      level.push(id);
      next.push(...(edges.get(id) ?? []));
    }
    if (level.length > 0) out.push(level);
    frontier = next;
  }
  return out;
}

export function relatedTo(id: string, graph: Graph): Set<string> {
  const related = new Set<string>([id]);
  for (const other of reach(id, graph.parents)) related.add(other);
  for (const other of reach(id, graph.children)) related.add(other);
  return related;
}
