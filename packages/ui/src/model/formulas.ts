import type { NodeKind, Snapshot, SnapshotNode } from "../snapshot";
import { chainGroups } from "./layout";

const MATHEMATICAL: ReadonlySet<NodeKind> = new Set<NodeKind>(["equation", "lemma", "theorem"]);

export interface FormulaEntry {
  number: number;
  node: SnapshotNode;
}

export interface FormulaGroup {
  id: string;
  title: string;
  entries: FormulaEntry[];
}

export interface FormulaSheet {
  groups: FormulaGroup[];
  total: number;
  withFormula: number;
}

/** Each node after what it depends on, otherwise in map order. */
function inReadingOrder(nodes: readonly SnapshotNode[]): SnapshotNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const ordered: SnapshotNode[] = [];
  const visit = (node: SnapshotNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    for (const parent of node.depends_on) {
      const source = byId.get(parent);
      if (source) visit(source);
    }
    ordered.push(node);
  };
  nodes.forEach(visit);
  return ordered;
}

/**
 * The map read like a page of a paper. An equation, lemma or theorem with no
 * formula stays listed, so that a missing formula is seen and not silently lost.
 */
export function formulaSheet(snapshot: Pick<Snapshot, "chains" | "nodes">): FormulaSheet {
  let number = 0;
  const groups = chainGroups(snapshot).flatMap((group) => {
    const entries = inReadingOrder(group.nodes)
      .filter((node) => node.latex || MATHEMATICAL.has(node.kind))
      .map((node) => ({ number: (number += 1), node }));
    return entries.length > 0 ? [{ id: group.id, title: group.title, entries }] : [];
  });
  const all = groups.flatMap((group) => group.entries);
  return { groups, total: all.length, withFormula: all.filter((entry) => entry.node.latex).length };
}
