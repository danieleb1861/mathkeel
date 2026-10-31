import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decode, encode } from "@toon-format/toon";
import { isCodeLanguage, languageOf, resolveAnchor, Workspace } from "./anchors.js";
import { currentInventory } from "./census.js";
import { MapError, UsageError } from "./errors.js";
import { RepoFiles, headCommit, isSensitivePath, toRepoPath } from "./repo.js";
import { lockSchema, mapSchema } from "./schema.js";
import type { Anchor, MapFile, MapNode } from "./types.js";

export const MATHKEEL_DIR = ".mathkeel";

/** `map.toon` is the default; a `map.json` already in the repository stays in use. */
export function mapPath(root: string): string {
  const json = path.join(root, MATHKEEL_DIR, "map.json");
  return existsSync(json) ? json : path.join(root, MATHKEEL_DIR, "map.toon");
}

/** Hashes, baseline and inventory of a `map.toon`: written by the engine, read by no agent. */
export function lockPath(root: string): string {
  return path.join(root, MATHKEEL_DIR, "map.lock.toon");
}

export function statePath(root: string, ...parts: string[]): string {
  return path.join(root, MATHKEEL_DIR, "state", ...parts);
}

export function decisionsPath(root: string): string {
  return path.join(root, MATHKEEL_DIR, "decisions.jsonl");
}

const EMPTY_MAP: MapFile = { schema: 1, baseline: null, chains: [], contracts: [], nodes: [], inventory: {} };

export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}

/** Agents read and write TOON; the format follows the file's extension. */
export function readData(file: string): unknown {
  const text = readFileSync(file, "utf8");
  return file.endsWith(".toon") ? decode(text) : JSON.parse(text);
}

export function formatData(file: string, value: unknown): string {
  return `${file.endsWith(".toon") ? encode(value) : JSON.stringify(value, null, 2)}\n`;
}

/** An anchor's place in its node, so that rewording its locator keeps the frozen hash. */
function anchorKeys(node: MapNode): { anchor: Anchor; key: string }[] {
  return allAnchors(node).map(({ anchor, where }) => ({ anchor, key: where.slice(node.id.length + 1) }));
}

function compactAnchor({ path: file, symbol, quote }: Anchor) {
  return { path: file, ...(symbol === null ? {} : { symbol }), ...(quote === "" ? {} : { quote }) };
}

/** A node as an agent writes it: no hash and no field left at its default. */
function compactNode(node: MapNode) {
  const { doc, code, proof, units, depends_on, contracts, verified_by, pinned_to_code, ...rest } = node;
  return {
    ...rest,
    ...(doc === null ? {} : { doc: compactAnchor(doc) }),
    ...(code.length === 0 ? {} : { code: code.map(compactAnchor) }),
    ...(proof.state === "absent" && proof.ref === null ? {} : { proof }),
    ...(units === null ? {} : { units }),
    ...(depends_on.length === 0 ? {} : { depends_on }),
    ...(contracts.length === 0 ? {} : { contracts }),
    ...(verified_by.length === 0 ? {} : { verified_by }),
    ...(pinned_to_code ? { pinned_to_code } : {}),
  };
}

export function writeMap(root: string, map: MapFile): void {
  const file = mapPath(root);
  if (path.basename(file) === "map.json") {
    writeFileAtomic(file, formatData(file, map));
    return;
  }
  const anchors = map.nodes.flatMap((node) =>
    anchorKeys(node).flatMap(({ anchor, key }) =>
      anchor.hash === null ? [] : [{ node: node.id, anchor: key, hash: anchor.hash }],
    ),
  );
  const lock = lockPath(root);
  writeFileAtomic(lock, formatData(lock, { baseline: map.baseline, anchors, inventory: map.inventory }));
  const { schema, chains, contracts, nodes } = map;
  writeFileAtomic(file, formatData(file, { schema, chains, contracts, nodes: nodes.map(compactNode) }));
}

/** The lock wins over a hash left in `map.toon`: only freeze and accept may set one. */
function applyLock(root: string, map: MapFile): void {
  const file = lockPath(root);
  if (!existsSync(file)) return;
  let raw: unknown;
  try {
    raw = readData(file);
  } catch (error) {
    throw new MapError("map.lock.toon is not valid TOON", [String(error)]);
  }
  const lock = lockSchema.safeParse(raw);
  if (!lock.success) {
    throw new MapError(
      "map.lock.toon does not match the schema",
      lock.error.issues.map((i) => `${i.path.join(".") || "lock"}: ${i.message}`),
    );
  }
  const hashes = new Map(lock.data.anchors.map((row) => [`${row.node} ${row.anchor}`, row.hash]));
  for (const node of map.nodes) {
    for (const { anchor, key } of anchorKeys(node)) anchor.hash = hashes.get(`${node.id} ${key}`) ?? anchor.hash;
  }
  map.baseline = lock.data.baseline;
  map.inventory = lock.data.inventory;
}

/** Creates `.mathkeel/`, leaving whatever already exists in place. */
export function initRepo(root: string): string[] {
  const created: string[] = [];
  const dir = path.join(root, MATHKEEL_DIR);
  for (const sub of [dir, path.join(dir, "contracts"), path.join(dir, "state")]) {
    if (!existsSync(sub)) created.push(path.relative(root, sub).replace(/\\/g, "/"));
    mkdirSync(sub, { recursive: true });
  }
  if (!existsSync(mapPath(root))) {
    writeMap(root, EMPTY_MAP);
    created.push(`${MATHKEEL_DIR}/${path.basename(mapPath(root))}`, `${MATHKEEL_DIR}/${path.basename(lockPath(root))}`);
  }
  if (!existsSync(decisionsPath(root))) {
    writeFileSync(decisionsPath(root), "");
    created.push(`${MATHKEEL_DIR}/decisions.jsonl`);
  }
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) {
    writeFileSync(ignore, "state/\n");
    created.push(`${MATHKEEL_DIR}/.gitignore`);
  }
  return created;
}

function normaliseAnchorPath(anchor: Anchor, where: string, issues: string[]): void {
  const rel = toRepoPath(anchor.path);
  if (rel === null) {
    issues.push(`${where}: path ${JSON.stringify(anchor.path)} leaves the repository`);
    return;
  }
  anchor.path = rel;
  if (isSensitivePath(rel)) issues.push(`${where}: ${rel} is a sensitive file and is never read`);
}

export function allAnchors(node: MapNode): { anchor: Anchor; kind: "doc" | "code"; where: string }[] {
  const out: { anchor: Anchor; kind: "doc" | "code"; where: string }[] = [];
  if (node.doc !== null) out.push({ anchor: node.doc, kind: "doc", where: `${node.id}.doc` });
  node.code.forEach((anchor, i) => out.push({ anchor, kind: "code", where: `${node.id}.code[${i}]` }));
  return out;
}

function findCycle(map: MapFile): string[] | null {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const trail: string[] = [];
  const visit = (id: string): string[] | null => {
    if (trail.includes(id)) return [...trail.slice(trail.indexOf(id)), id];
    if (done.has(id)) return null;
    trail.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    trail.pop();
    done.add(id);
    return null;
  };
  for (const node of map.nodes) {
    const cycle = visit(node.id);
    if (cycle !== null) return cycle;
  }
  return null;
}

/** Problems a map has on its own, without reading any file it points at. */
export function linkIssues(map: MapFile): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const node of map.nodes) {
    if (ids.has(node.id)) issues.push(`duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  const contracts = new Set<string>();
  for (const contract of map.contracts) {
    if (contracts.has(contract.id)) issues.push(`duplicate contract id ${contract.id}`);
    contracts.add(contract.id);
  }
  for (const node of map.nodes) {
    for (const dep of node.depends_on) {
      if (!ids.has(dep)) issues.push(`${node.id}: depends_on names unknown node ${dep}`);
    }
    for (const contract of node.contracts) {
      if (!contracts.has(contract)) issues.push(`${node.id}: names undeclared contract ${contract}`);
    }
    if (node.status === "formally_checked" && (node.proof.state !== "checked" || node.proof.ref === null)) {
      issues.push(`${node.id}: formally_checked needs a checked proof with a ref`);
    }
    if (node.proof.state === "checked" && node.proof.ref === null) {
      issues.push(`${node.id}: a checked proof needs a ref`);
    }
    node.verified_by = node.verified_by.map((ref) => ref.split("\\").join("/"));
    for (const { anchor, where } of allAnchors(node)) {
      normaliseAnchorPath(anchor, where, issues);
      if (anchor.symbol === null && anchor.quote.trim() === "") {
        issues.push(`${where}: an anchor needs a symbol or a quote`);
      }
    }
  }
  const cycle = findCycle(map);
  if (cycle !== null) issues.push(`depends_on cycle: ${cycle.join(" -> ")}`);
  return issues;
}

/** Parses the map against the schema; throws MapError with every schema issue. */
export function parseMap(root: string): MapFile {
  const file = mapPath(root);
  const name = path.basename(file);
  if (!existsSync(file)) throw new UsageError(`${MATHKEEL_DIR}/${name} not found; run mathkeel init`);
  if (name === "map.json" && existsSync(path.join(root, MATHKEEL_DIR, "map.toon"))) {
    throw new MapError("both map.json and map.toon exist; keep one", []);
  }
  let raw: unknown;
  try {
    raw = readData(file);
  } catch (error) {
    throw new MapError(`${name} is not valid ${name === "map.toon" ? "TOON" : "JSON"}`, [String(error)]);
  }
  // Every field has a default and TOON decodes an empty file to {}, so a blank or
  // cut map.toon would otherwise pass as an empty map and silently protect nothing.
  if (name === "map.toon" && !(typeof raw === "object" && raw !== null && "nodes" in raw)) {
    throw new MapError("map.toon has no nodes section", []);
  }
  const parsed = mapSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "map"}: ${i.message}`);
    throw new MapError(`${name} does not match the schema`, issues);
  }
  if (name === "map.toon") applyLock(root, parsed.data);
  return parsed.data;
}

/** The map as every command but `map lint` loads it: both schema and links must hold. */
export function loadMap(root: string): MapFile {
  const map = parseMap(root);
  const issues = linkIssues(map);
  if (issues.length > 0) throw new MapError("the map has broken links", issues);
  return map;
}

/** Advice that leaves the map valid: with a symbol, the quote of a code anchor is never compared. */
export function mapWarnings(map: MapFile): string[] {
  return map.nodes.flatMap((node) =>
    allAnchors(node).flatMap(({ anchor, kind, where }) =>
      kind === "code" && anchor.symbol !== null && anchor.quote !== ""
        ? [`${where}: the symbol locates this anchor, so its quote is unused copied code; drop it`]
        : [],
    ),
  );
}

/** Everything `map lint` checks: schema, links, unresolved anchors. */
export async function lintMap(root: string): Promise<string[]> {
  const map = parseMap(root);
  const issues = linkIssues(map);
  const files = new RepoFiles(root);
  const ws = new Workspace(files);
  try {
    for (const node of map.nodes) {
      for (const { anchor, kind, where } of allAnchors(node)) {
        if (toRepoPath(anchor.path) === null) continue;
        const resolved = await resolveAnchor(ws, kind, anchor);
        if (resolved.state === "lost") issues.push(`${where}: unresolved: ${resolved.note}`);
      }
      for (const reference of node.verified_by) {
        const issue = await referenceIssue(reference, ws);
        if (issue !== null) issues.push(`${node.id}.verified_by: ${issue}`);
      }
    }
  } finally {
    await ws.dispose();
  }
  return issues;
}

async function referenceIssue(reference: string, ws: Workspace): Promise<string | null> {
  const separator = reference.indexOf("::");
  const file = separator === -1 ? reference : reference.slice(0, separator);
  const symbol = separator === -1 ? null : reference.slice(separator + 2);
  if (!ws.files.has(file)) return `${file} not found`;
  if (symbol === null || !isCodeLanguage(languageOf(file))) return null;
  const parsed = await ws.code(file);
  if (parsed === null || parsed.lookup(symbol).length === 0) return `${reference} not found`;
  return null;
}

export interface FreezeResult {
  frozen: number;
  kept: string[];
  baseline: string;
}

/**
 * Records hashes and inventory. A hash already frozen stays as it is even when
 * the span has changed: only `accept`, which records a person and a reason, may
 * rebaseline. Anchors still in a changed state are returned in `kept`.
 */
export async function freezeMap(root: string): Promise<FreezeResult> {
  const map = loadMap(root);
  const files = new RepoFiles(root);
  const ws = new Workspace(files);
  let frozen = 0;
  const kept: string[] = [];
  const unresolved: string[] = [];
  try {
    for (const node of map.nodes) {
      for (const { anchor, kind, where } of allAnchors(node)) {
        const resolved = await resolveAnchor(ws, kind, anchor);
        if (resolved.state === "lost") {
          unresolved.push(`${where}: unresolved: ${resolved.note}`);
        } else if (anchor.hash === null) {
          anchor.hash = resolved.hash;
          frozen++;
        } else if (resolved.state !== "fresh") {
          kept.push(where);
        }
      }
    }
    if (unresolved.length > 0) throw new MapError("cannot freeze with unresolved anchors", unresolved);
    map.inventory = await currentInventory(map, ws);
  } finally {
    await ws.dispose();
  }
  const head = headCommit(root);
  if (head === "") throw new UsageError("map freeze needs a commit to use as the baseline");
  if (map.baseline === null || kept.length === 0) map.baseline = head;
  writeMap(root, map);
  return { frozen, kept, baseline: map.baseline };
}
