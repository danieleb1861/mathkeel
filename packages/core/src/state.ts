import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./normalise.js";
import { statePath, writeFileAtomic } from "./mapio.js";
import { changedPaths, headCommit } from "./repo.js";
import type { MapFile, SnapshotContractResult, VerdictValue } from "./types.js";

interface LastCheck {
  key: string;
  at: string;
  results: SnapshotContractResult[];
}

export interface StoredVerdict {
  verdict: VerdictValue;
  confidence: number;
  reason: string;
  fingerprint: string;
}

const MAP_BOOKKEEPING = new Set([
  ".mathkeel/map.json",
  ".mathkeel/map.toon",
  ".mathkeel/map.lock.toon",
  ".mathkeel/decisions.jsonl",
]);

/**
 * Identifies the tree a set of contract results belongs to, from the head, the
 * contract list, and the size and time of each changed file. No file is read.
 */
export function treeKey(root: string, map: MapFile): string {
  const changes: string[] = [];
  for (const { path: rel, entry } of changedPaths(root)) {
    if (MAP_BOOKKEEPING.has(rel) || rel.startsWith(".mathkeel/state")) continue;
    let stamp = "gone";
    try {
      const stat = statSync(path.join(root, ...rel.split("/")));
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      // A deleted file keeps the stamp "gone".
    }
    changes.push(`${entry}|${stamp}`);
  }
  return sha256(JSON.stringify([headCommit(root), map.contracts, changes.sort()]));
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Changes when a check or a verdict is stored, which neither git nor the watcher reports. */
export function storedResultsStamp(root: string): string {
  const stamps: string[] = [];
  for (const name of ["last-check.json", "verdicts.json"]) {
    try {
      stamps.push(String(statSync(statePath(root, name)).mtimeMs));
    } catch {
      stamps.push("none");
    }
  }
  return stamps.join("|");
}

export function saveLastCheck(root: string, map: MapFile, results: Map<string, SnapshotContractResult>): void {
  const record: LastCheck = { key: treeKey(root, map), at: new Date().toISOString(), results: [...results.values()] };
  writeFileAtomic(statePath(root, "last-check.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Results of the last `check`, or null when none exists or the tree has moved on
 * since. This reads a stored record: nothing here runs a contract.
 */
export function loadLastCheck(root: string, map: MapFile): Map<string, SnapshotContractResult> | null {
  const record = readJson(statePath(root, "last-check.json")) as LastCheck | null;
  if (record === null || record.key !== treeKey(root, map) || !Array.isArray(record.results)) return null;
  return new Map(record.results.map((r) => [r.id, r]));
}

export function loadVerdicts(root: string): Map<string, StoredVerdict> {
  const record = readJson(statePath(root, "verdicts.json"));
  if (record === null || typeof record !== "object") return new Map();
  return new Map(Object.entries(record as Record<string, StoredVerdict>));
}

export function saveVerdicts(root: string, verdicts: Map<string, StoredVerdict>): void {
  writeFileAtomic(statePath(root, "verdicts.json"), `${JSON.stringify(Object.fromEntries(verdicts), null, 2)}\n`);
}
