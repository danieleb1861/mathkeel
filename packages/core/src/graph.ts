import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MapError } from "./errors.js";
import { allAnchors, readData } from "./mapio.js";
import type { MapFile } from "./types.js";

const MAP_SOURCE = ".mathkeel/map.toon";
const MAX_GRAPH_BYTES = 256 * 1024 * 1024;

interface GraphNode {
  id: string;
  label: string;
  file_type: "concept" | "code" | "document";
  source_file: string;
}

interface GraphLink {
  source: string;
  target: string;
  relation: string;
  confidence: "EXTRACTED";
  source_file: string;
  _src: string;
  _tgt: string;
}

/**
 * The map as a node-link graph, in the shape Graphify reads: undirected, with the
 * direction kept in `_src` and `_tgt`. It holds structure only: a class or status
 * copied here would go stale without any alert.
 */
export function mapGraph(map: MapFile) {
  const nodes = new Map<string, GraphNode>();
  const links = new Map<string, GraphLink>();
  const add = (node: GraphNode): void => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const link = (source: string, target: string, relation: string): void => {
    links.set(`${source} ${relation} ${target}`, {
      source,
      target,
      relation,
      confidence: "EXTRACTED",
      source_file: MAP_SOURCE,
      _src: source,
      _tgt: target,
    });
  };

  for (const node of map.nodes) {
    add({ id: `mathkeel:${node.id}`, label: node.title, file_type: "concept", source_file: MAP_SOURCE });
  }
  for (const node of map.nodes) {
    const id = `mathkeel:${node.id}`;
    for (const parent of node.depends_on) link(id, `mathkeel:${parent}`, "depends_on");
    for (const { anchor, kind } of allAnchors(node)) {
      const target = anchor.symbol === null ? anchor.path : `${anchor.path}#${anchor.symbol}`;
      add({
        id: target,
        label: anchor.symbol ?? path.posix.basename(anchor.path),
        file_type: kind === "doc" ? "document" : "code",
        source_file: anchor.path,
      });
      link(id, target, kind === "doc" ? "documented_in" : "implemented_by");
    }
    for (const test of node.verified_by) {
      add({ id: test, label: test.split("::").pop() ?? test, file_type: "code", source_file: test.split("::")[0] ?? test });
      link(id, test, "verified_by");
    }
    for (const contract of node.contracts) {
      add({ id: `mathkeel:contract:${contract}`, label: contract, file_type: "code", source_file: MAP_SOURCE });
      link(id, `mathkeel:contract:${contract}`, "checked_by");
    }
  }
  return { directed: false, multigraph: false, graph: {}, nodes: [...nodes.values()], links: [...links.values()] };
}

const edgeSchema = z.looseObject({
  source: z.string(),
  target: z.string(),
  confidence: z.string().optional(),
});
const relationshipSchema = z.looseObject({ from: z.string(), to: z.string(), status: z.string().optional() });
const graphFileSchema = z.looseObject({
  nodes: z.array(z.looseObject({ id: z.string(), source_file: z.string().nullish() })).optional(),
  links: z.array(edgeSchema).optional(),
  edges: z.array(edgeSchema).optional(),
  relationships: z.array(relationshipSchema).optional(),
});

export interface Relation {
  a: string;
  b: string;
  confidence: string;
}

function repoFile(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** File-to-file relations of a Graphify `graph.json` or a `source_manifest.json`. */
export function readRelations(file: string): Relation[] {
  const name = path.basename(file);
  let raw: unknown;
  try {
    if (statSync(file).size > MAX_GRAPH_BYTES) throw new Error("larger than 256 MiB");
    raw = readData(file);
  } catch (error) {
    throw new MapError(`${name} could not be read`, [error instanceof Error ? error.message : String(error)]);
  }
  const parsed = graphFileSchema.safeParse(raw);
  if (!parsed.success || !(parsed.data.links || parsed.data.edges || parsed.data.relationships)) {
    throw new MapError(`${name} has neither links, edges nor relationships`, []);
  }
  const { nodes, links, edges, relationships } = parsed.data;
  const fileOf = new Map((nodes ?? []).map((node) => [node.id, node.source_file ?? ""]));
  const fromLinks = (links ?? edges ?? []).map((edge) => ({
    a: repoFile(fileOf.get(edge.source) ?? ""),
    b: repoFile(fileOf.get(edge.target) ?? ""),
    confidence: edge.confidence ?? "EXTRACTED",
  }));
  const fromManifest = (relationships ?? []).map((edge) => ({
    a: repoFile(edge.from),
    b: repoFile(edge.to),
    confidence: edge.status ?? "EXTRACTED",
  }));
  return [...fromLinks, ...fromManifest].filter((relation) => relation.a !== relation.b);
}

export interface Suggestion {
  path: string;
  lines: number;
  links: number;
  inferred: number;
  near: string[];
}

/**
 * Unmapped files ranked by their links to mapped code. A suggestion is where to
 * look next: it adds no node, and an inferred link never raises an alert.
 */
export function suggest(map: MapFile, uncharted: readonly { path: string; lines: number }[], relations: readonly Relation[]): Suggestion[] {
  const mapped = new Set(map.nodes.flatMap((node) => node.code.map((anchor) => anchor.path)));
  const rows = new Map(uncharted.map((file) => [file.path, { ...file, links: 0, inferred: 0, near: new Set<string>() }]));
  for (const { a, b, confidence } of relations) {
    for (const [file, other] of [[a, b], [b, a]] as const) {
      const row = rows.get(file);
      if (row === undefined || !mapped.has(other)) continue;
      if (confidence === "EXTRACTED") row.links += 1;
      else if (confidence === "INFERRED") row.inferred += 1;
      else continue;
      row.near.add(other);
    }
  }
  return [...rows.values()]
    .filter((row) => row.near.size > 0)
    .sort((x, y) => y.links - x.links || y.inferred - x.inferred || y.lines - x.lines || x.path.localeCompare(y.path))
    .map((row) => ({ ...row, near: [...row.near].sort() }));
}
