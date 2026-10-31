import { isCodeLanguage, languageOf, type Workspace } from "./anchors.js";
import type { RepoFiles } from "./repo.js";
import type { InventoryEntry, MapFile, MapNode, SnapshotGap, SnapshotUncharted } from "./types.js";

function anchorsOf(node: MapNode): { path: string }[] {
  return node.doc === null ? node.code : [node.doc, ...node.code];
}

/** Source files some anchor points at. */
export function mappedModules(map: MapFile): string[] {
  const paths = new Set<string>();
  for (const node of map.nodes) {
    for (const anchor of anchorsOf(node)) {
      if (isCodeLanguage(languageOf(anchor.path))) paths.add(anchor.path);
    }
  }
  return [...paths].sort();
}

function testFile(reference: string): string {
  return reference.split("::")[0] ?? reference;
}

/** The current public surface of the mapped modules, in the shape the map stores. */
export async function currentInventory(map: MapFile, ws: Workspace): Promise<Record<string, InventoryEntry>> {
  const inventory: Record<string, InventoryEntry> = {};
  for (const path of mappedModules(map)) {
    const parsed = await ws.code(path);
    if (parsed === null) continue;
    const entry: InventoryEntry = { functions: [], parameters: [], members: [] };
    for (const item of parsed.census) {
      const list =
        item.kind === "function" ? entry.functions : item.kind === "parameter" ? entry.parameters : entry.members;
      if (!list.includes(item.symbol)) list.push(item.symbol);
    }
    entry.functions.sort();
    entry.parameters.sort();
    entry.members.sort();
    inventory[path] = entry;
  }
  return inventory;
}

/** Public items of mapped modules missing from the frozen inventory. Never an alert. */
export async function computeGaps(map: MapFile, ws: Workspace): Promise<SnapshotGap[]> {
  const gaps: SnapshotGap[] = [];
  for (const path of mappedModules(map)) {
    const parsed = await ws.code(path);
    if (parsed === null) continue;
    const frozen = map.inventory[path];
    const seen = new Set<string>();
    for (const item of parsed.census) {
      const key = `${item.kind}:${item.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list =
        item.kind === "function" ? frozen?.functions : item.kind === "parameter" ? frozen?.parameters : frozen?.members;
      if (!list?.includes(item.symbol)) gaps.push({ path, symbol: item.symbol, kind: item.kind });
    }
  }
  return gaps;
}

function countLines(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

/** Source files nothing maps, and their share of the source lines of the repository. */
export function computeUncharted(map: MapFile, files: RepoFiles): { uncharted: SnapshotUncharted[]; share: number } {
  const charted = new Set(mappedModules(map));
  for (const node of map.nodes) for (const ref of node.verified_by) charted.add(testFile(ref));

  const uncharted: SnapshotUncharted[] = [];
  let total = 0;
  let unmapped = 0;
  for (const path of files.list()) {
    if (path.startsWith(".mathkeel/") || !isCodeLanguage(languageOf(path))) continue;
    const text = files.read(path);
    if (text === null) continue;
    const lines = countLines(text);
    total += lines;
    if (charted.has(path)) continue;
    unmapped += lines;
    uncharted.push({ path, lines });
  }
  uncharted.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  return { uncharted, share: total === 0 ? 0 : Math.round((unmapped / total) * 10000) / 10000 };
}
