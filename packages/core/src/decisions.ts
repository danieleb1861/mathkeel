import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolveAnchor, Workspace } from "./anchors.js";
import { UsageError, MapError } from "./errors.js";
import { allAnchors, decisionsPath, loadMap, writeMap } from "./mapio.js";
import { RepoFiles, headCommit, tryGit } from "./repo.js";
import { decisionSchema } from "./schema.js";
import { loadVerdicts, saveVerdicts } from "./state.js";
import type { SnapshotDecision } from "./types.js";

export interface Decision extends SnapshotDecision {
  commit: string;
}

export function readDecisions(root: string): Decision[] {
  const file = decisionsPath(root);
  if (!existsSync(file)) return [];
  const decisions: Decision[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed = decisionSchema.safeParse(JSON.parse(line));
      if (parsed.success) decisions.push(parsed.data);
    } catch {
      // A damaged line is skipped: the file is append-only and stays readable.
    }
  }
  return decisions;
}

function gitIdentity(root: string): string {
  const name = tryGit(root, ["config", "user.name"])?.trim();
  const email = tryGit(root, ["config", "user.email"])?.trim();
  const person = name || email;
  if (!person) throw new UsageError("accept records a person: set git config user.name first");
  return person;
}

/**
 * A person's decision: rebaselines the hashes of one node and records who, when,
 * why and at which commit. The record is written first, so that a crash cannot
 * leave a rebaseline without a decision behind it.
 */
export async function acceptNode(root: string, id: string, reason: string): Promise<Decision> {
  const trimmed = reason.trim();
  if (trimmed === "") throw new UsageError("accept needs a --reason");
  const map = loadMap(root);
  const node = map.nodes.find((n) => n.id === id);
  if (node === undefined) throw new UsageError(`unknown node ${id}`);

  const ws = new Workspace(new RepoFiles(root));
  const updates: { hash: string; apply: (hash: string) => void }[] = [];
  const unresolved: string[] = [];
  try {
    for (const { anchor, kind, where } of allAnchors(node)) {
      const resolved = await resolveAnchor(ws, kind, anchor);
      if (resolved.hash === null) unresolved.push(`${where}: unresolved: ${resolved.note}`);
      else updates.push({ hash: resolved.hash, apply: (hash) => (anchor.hash = hash) });
    }
  } finally {
    await ws.dispose();
  }
  if (unresolved.length > 0) {
    throw new MapError(`cannot accept ${id}: repair the lost anchors in the map first`, unresolved);
  }

  const decision: Decision = {
    id,
    by: gitIdentity(root),
    at: new Date().toISOString(),
    reason: trimmed,
    commit: headCommit(root),
  };
  appendFileSync(decisionsPath(root), `${JSON.stringify(decision)}\n`);
  updates.forEach((u) => u.apply(u.hash));
  writeMap(root, map);

  const verdicts = loadVerdicts(root);
  if (verdicts.delete(id)) saveVerdicts(root, verdicts);
  return decision;
}
