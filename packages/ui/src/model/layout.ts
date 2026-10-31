import type { NodeKind, Snapshot, SnapshotNode, Uncharted } from "../snapshot";

/**
 * Chart layout. Each chain is laid out by ELK on its own, which gives good
 * ordering and routing inside a band. Bands are then stacked and their layers
 * remapped onto one shared set of meridians, so a column means the same thing
 * in every chain: assumptions, equations, code, tests. Because all marks have
 * one width, the remap is a monotone piecewise-linear function of x and ELK's
 * routes survive it unchanged in topology.
 */

export const MARK_WIDTH = 224;
export const MARK_HEIGHT = 42;
/** Added below the lettering of a mark that shows its formula. */
export const FORMULA_HEIGHT = 44;
/** Height of the ink rule inside a mark; every edge meets a mark on this line. */
export const RULE_Y = 21;
const LAYER_GAP = 64;
const NODE_GAP = 8;
const BAND_GAP = 20;
const BAND_HEAD = 34;
const COLUMN_GAP = 0;

export type Rank = 0 | 1 | 2 | 3;

export const RANKS: readonly { rank: Rank; label: string; letter: string }[] = [
  { rank: 0, label: "Assumptions", letter: "A" },
  { rank: 1, label: "Equations", letter: "B" },
  { rank: 2, label: "Code", letter: "C" },
  { rank: 3, label: "Tests", letter: "D" },
];

const KIND_RANK: Record<NodeKind, Rank> = {
  assumption: 0,
  convention: 0,
  parameter: 0,
  closed_list: 0,
  definition: 0,
  equation: 1,
  lemma: 1,
  theorem: 1,
  code: 2,
  test: 3,
};

export function rankOf(kind: NodeKind): Rank {
  return KIND_RANK[kind] ?? 1;
}

export interface Point {
  x: number;
  y: number;
}

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  height: number;
  rank: Rank;
  layer: number;
  chain: string;
}

export interface PlacedEdge {
  id: string;
  source: string;
  target: string;
  points: Point[];
  /** flow: between columns. arc: inside one column. cross: between chains. */
  kind: "flow" | "arc" | "cross";
}

export interface Band {
  id: string;
  title: string;
  y: number;
  height: number;
}

export interface Column {
  rank: Rank;
  label: string;
  letter: string;
  x: number;
  width: number;
}

export interface FogSlice {
  path: string;
  lines: number;
  y: number;
  height: number;
}

export interface Fog {
  x: number;
  y: number;
  width: number;
  height: number;
  share: number;
  slices: FogSlice[];
}

export interface ChartLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  bands: Band[];
  columns: Column[];
  width: number;
  height: number;
  fog: Fog | null;
}

export interface ElkPoint {
  x: number;
  y: number;
}

export interface ElkInput {
  id: string;
  layoutOptions: Record<string, string>;
  children: {
    id: string;
    width: number;
    height: number;
    layoutOptions: Record<string, string>;
    ports: { id: string; x: number; y: number; width: number; height: number; layoutOptions: Record<string, string> }[];
  }[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}

export interface ElkOutput {
  children?: { id: string; x?: number; y?: number }[];
  edges?: {
    id: string;
    sections?: { startPoint: ElkPoint; endPoint: ElkPoint; bendPoints?: ElkPoint[] }[];
  }[];
  height?: number;
}

export type ElkRun = (graph: ElkInput) => Promise<ElkOutput>;

interface ChainGroup {
  id: string;
  title: string;
  nodes: SnapshotNode[];
}

export function chainGroups(snapshot: Pick<Snapshot, "chains" | "nodes">): ChainGroup[] {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const placed = new Set<string>();
  const groups: ChainGroup[] = [];
  for (const chain of snapshot.chains) {
    const nodes = chain.nodeIds.flatMap((id) => {
      const node = byId.get(id);
      if (!node || placed.has(id)) return [];
      placed.add(id);
      return [node];
    });
    if (nodes.length > 0) groups.push({ id: chain.id, title: chain.title, nodes });
  }
  const rest = snapshot.nodes.filter((node) => !placed.has(node.id));
  if (rest.length > 0) groups.push({ id: "unassigned", title: "Outside any chain", nodes: rest });
  return groups;
}

function markHeight(node: SnapshotNode, formulas: boolean): number {
  return formulas && node.latex ? MARK_HEIGHT + FORMULA_HEIGHT : MARK_HEIGHT;
}

function elkGraph(group: ChainGroup, formulas: boolean): ElkInput {
  const ranks = new Map(group.nodes.map((node) => [node.id, rankOf(node.kind)]));
  return {
    id: group.id,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.separateConnectedComponents": "false",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
      "elk.spacing.nodeNode": String(NODE_GAP),
      "elk.layered.spacing.edgeNodeBetweenLayers": "14",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "8",
      "elk.spacing.edgeNode": "14",
      "elk.spacing.edgeEdge": "8",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: group.nodes.map((node) => ({
      id: node.id,
      width: MARK_WIDTH,
      height: markHeight(node, formulas),
      layoutOptions: {
        "elk.partitioning.partition": String(rankOf(node.kind)),
        "elk.portConstraints": "FIXED_POS",
      },
      ports: [
        {
          id: `${node.id}::in`,
          x: 0,
          y: RULE_Y,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": "WEST" },
        },
        {
          id: `${node.id}::out`,
          x: MARK_WIDTH,
          y: RULE_Y,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": "EAST" },
        },
      ],
    })),
    edges: group.nodes.flatMap((node) =>
      node.depends_on
        // Links inside a column are drawn as arcs, so each rank stays one column.
        .filter((parent) => ranks.has(parent) && ranks.get(parent) !== ranks.get(node.id))
        .map((parent) => ({
          id: `${parent}->${node.id}`,
          sources: [`${parent}::out`],
          targets: [`${node.id}::in`],
        })),
    ),
  };
}

interface Layer {
  x: number;
  rank: Rank;
}

/** Monotone piecewise-linear map from ELK x to shared meridian x. */
export function remapper(layers: readonly { from: number; to: number }[]): (x: number) => number {
  const stops = layers.flatMap(({ from, to }) => [
    { from, to },
    { from: from + MARK_WIDTH, to: to + MARK_WIDTH },
  ]);
  return (x) => {
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return x;
    if (x <= first.from) return first.to + (x - first.from);
    if (x >= last.from) return last.to + (x - last.from);
    for (let index = 0; index < stops.length - 1; index += 1) {
      const left = stops[index] as { from: number; to: number };
      const right = stops[index + 1] as { from: number; to: number };
      if (x >= left.from && x <= right.from) {
        const span = right.from - left.from;
        return span === 0 ? left.to : left.to + ((x - left.from) / span) * (right.to - left.to);
      }
    }
    return x;
  };
}

/** Fog is sized so its area over the whole chart equals the uncharted share. */
export function fogWidth(chartWidth: number, share: number): number {
  const bounded = Math.max(0, Math.min(0.95, share));
  return (chartWidth * bounded) / (1 - bounded);
}

function placeFog(
  width: number,
  height: number,
  share: number,
  uncharted: readonly Uncharted[],
): Fog | null {
  if (share <= 0 || height <= 0) return null;
  const fogX = width;
  const fog = fogWidth(width, share);
  const total = uncharted.reduce((sum, entry) => sum + Math.max(1, entry.lines), 0);
  const sorted = [...uncharted].sort((a, b) => b.lines - a.lines);
  let y = 0;
  const slices = sorted.map((entry) => {
    const sliceHeight = total > 0 ? (height * Math.max(1, entry.lines)) / total : 0;
    const slice = { path: entry.path, lines: entry.lines, y, height: sliceHeight };
    y += sliceHeight;
    return slice;
  });
  return { x: fogX, y: 0, width: fog, height, share, slices };
}

function crossRoute(from: Point, to: Point): Point[] {
  const mid = from.x + Math.max(24, (to.x - from.x) / 2);
  return [from, { x: mid, y: from.y }, { x: mid, y: to.y }, to];
}

export async function layoutChart(
  snapshot: Pick<Snapshot, "chains" | "nodes" | "uncharted" | "summary">,
  run: ElkRun,
  formulas = false,
): Promise<ChartLayout> {
  const groups = chainGroups(snapshot);
  const results = await Promise.all(groups.map((group) => run(elkGraph(group, formulas))));

  // Layers of each chain, and how many layers each rank needs across chains.
  const chainLayers = groups.map((group, index) => {
    const output = results[index] as ElkOutput;
    const byNode = new Map((output.children ?? []).map((child) => [child.id, child]));
    const xs = new Map<number, Rank>();
    for (const node of group.nodes) {
      const x = Math.round(byNode.get(node.id)?.x ?? 0);
      const rank = rankOf(node.kind);
      const known = xs.get(x);
      xs.set(x, known === undefined ? rank : (Math.min(known, rank) as Rank));
    }
    const layers: Layer[] = [...xs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([x, rank]) => ({ x, rank }));
    return layers;
  });

  const perRank = new Map<Rank, number>();
  for (const layers of chainLayers) {
    const counts = new Map<Rank, number>();
    for (const layer of layers) counts.set(layer.rank, (counts.get(layer.rank) ?? 0) + 1);
    for (const [rank, count] of counts) perRank.set(rank, Math.max(perRank.get(rank) ?? 0, count));
  }

  const step = MARK_WIDTH + LAYER_GAP;
  const columns: Column[] = [];
  let cursor = 0;
  for (const { rank, label, letter } of RANKS) {
    const count = perRank.get(rank) ?? 0;
    if (count === 0) continue;
    const width = count * step - LAYER_GAP;
    columns.push({ rank, label, letter, x: cursor, width });
    cursor += width + LAYER_GAP + COLUMN_GAP;
  }
  const width = Math.max(0, cursor - LAYER_GAP - COLUMN_GAP);
  const columnX = new Map(columns.map((column) => [column.rank, column.x]));

  const nodes: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];
  const bands: Band[] = [];
  const placedById = new Map<string, PlacedNode>();
  let bandY = 0;

  groups.forEach((group, index) => {
    const output = results[index] as ElkOutput;
    const layers = chainLayers[index] as Layer[];
    const seen = new Map<Rank, number>();
    const stops = layers.map((layer) => {
      const position = seen.get(layer.rank) ?? 0;
      seen.set(layer.rank, position + 1);
      return { from: layer.x, to: (columnX.get(layer.rank) ?? 0) + position * step };
    });
    const mapX = remapper(stops);
    const top = bandY + BAND_HEAD;
    const children = new Map((output.children ?? []).map((child) => [child.id, child]));
    let bottom = top;
    for (const node of group.nodes) {
      const child = children.get(node.id);
      const y = top + (child?.y ?? 0);
      const placed: PlacedNode = {
        id: node.id,
        x: Math.round(mapX(child?.x ?? 0)),
        y,
        height: markHeight(node, formulas),
        rank: rankOf(node.kind),
        layer: Math.round(child?.x ?? 0),
        chain: group.id,
      };
      nodes.push(placed);
      placedById.set(node.id, placed);
      bottom = Math.max(bottom, y + placed.height);
    }
    for (const edge of output.edges ?? []) {
      const section = edge.sections?.[0];
      if (!section) continue;
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
        (point) => ({ x: mapX(point.x), y: top + point.y }),
      );
      const [source = "", target = ""] = edge.id.split("->");
      edges.push({ id: edge.id, source, target, points, kind: "flow" });
    }
    bands.push({ id: group.id, title: group.title, y: bandY, height: bottom - bandY });
    bandY = bottom + BAND_GAP;
  });

  for (const group of groups) {
    for (const node of group.nodes) {
      const target = placedById.get(node.id);
      if (!target) continue;
      for (const parent of node.depends_on) {
        const source = placedById.get(parent);
        if (!source || source === target) continue;
        const id = `${parent}->${node.id}`;
        if (source.chain !== target.chain) {
          edges.push({
            id,
            source: parent,
            target: node.id,
            kind: "cross",
            points: crossRoute(
              { x: source.x + MARK_WIDTH, y: source.y + RULE_Y },
              { x: target.x, y: target.y + RULE_Y },
            ),
          });
        } else if (source.rank === target.rank) {
          edges.push({
            id,
            source: parent,
            target: node.id,
            kind: "arc",
            points: [
              { x: source.x, y: source.y + RULE_Y },
              { x: target.x, y: target.y + RULE_Y },
            ],
          });
        }
      }
    }
  }

  const height = Math.max(0, bandY - BAND_GAP);
  return {
    nodes,
    edges,
    bands,
    columns,
    width,
    height,
    fog: placeFog(width, height, snapshot.summary.unchartedShare, snapshot.uncharted),
  };
}

/** A key that changes only when positions could change, not on every status. */
export function topologyKey(snapshot: Pick<Snapshot, "chains" | "nodes" | "uncharted" | "summary">): string {
  return JSON.stringify([
    snapshot.chains.map((chain) => [chain.id, chain.title, chain.nodeIds]),
    snapshot.nodes.map((node) => [node.id, node.kind, node.depends_on, Boolean(node.latex)]),
    snapshot.uncharted,
    snapshot.summary.unchartedShare,
  ]);
}
