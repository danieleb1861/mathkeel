import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeMap } from "../src/mapio.js";
import { freezeMap, initRepo } from "../src/mapio.js";
import type { Contract, MapFile, MapNode } from "../src/types.js";

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const made: string[] = [];

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function commitAll(root: string, message = "change"): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

/** A synthetic git repository in the system temp folder. */
export function makeRepo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mathkeel-test-")));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test Person");
  git(root, "config", "user.email", "person@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFiles(root, files);
  commitAll(root, "first");
  return root;
}

export function removeRepos(): void {
  for (const root of made.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        // Windows may hold a handle for a moment after a child exits.
      }
    }
  }
}

export function node(overrides: Partial<MapNode> & { id: string }): MapNode {
  return {
    chain: "main",
    kind: "equation",
    title: overrides.id,
    status: "stated",
    proof: { state: "absent", ref: null },
    doc: null,
    code: [],
    units: null,
    depends_on: [],
    contracts: [],
    verified_by: [],
    pinned_to_code: false,
    ...overrides,
  };
}

/** A command for a contract: node evaluating a script, with no shell involved. */
export function contract(id: string, script: string, timeout_s = 30): Contract {
  return { id, kind: "numeric", command: [process.execPath, "-e", script], timeout_s };
}

export const PASSING = 'console.log(JSON.stringify({msg:"ok"}))';
export const FAILING = 'console.log(JSON.stringify({msg:"mismatch"}));process.exit(1)';

/** Writes the map, freezes it and commits, leaving a clean repository. */
export async function frozenRepo(
  files: Record<string, string>,
  nodes: MapNode[],
  contracts: Contract[] = [],
): Promise<string> {
  const root = makeRepo(files);
  initRepo(root);
  const map: MapFile = { schema: 1, baseline: null, chains: [], contracts, nodes, inventory: {} };
  writeMap(root, map);
  await freezeMap(root);
  commitAll(root, "map");
  return root;
}

/** Synchronous spawns starve the test runner's channel; this lets it drain between tests. */
export function letEventLoopRun(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(root: string, ...args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}
