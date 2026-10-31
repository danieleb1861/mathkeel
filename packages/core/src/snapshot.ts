import { statSync } from "node:fs";
import path from "node:path";
import { resolveAnchor, Workspace, type ResolvedAnchor } from "./anchors.js";
import { classify, type ClassifyInput } from "./classify.js";
import { computeGaps, computeUncharted } from "./census.js";
import { readDecisions } from "./decisions.js";
import { allAnchors, loadMap } from "./mapio.js";
import { sha256 } from "./normalise.js";
import { RepoFiles, changedPaths, headCommit, isSensitivePath, tryGit } from "./repo.js";
import { loadLastCheck, loadVerdicts } from "./state.js";
import type {
  MapFile,
  MapNode,
  NodeClass,
  Snapshot,
  SnapshotActivity,
  SnapshotAnchor,
  SnapshotContractResult,
  SnapshotNode,
} from "./types.js";

const SHORT_SPAN_CHARS = 280;
const ACTIVITY_LIMIT = 30;

export interface SnapshotOptions {
  /** Results of a `check` that has just run. */
  contractResults?: Map<string, SnapshotContractResult>;
  /** Show the stored results of the last `check` if the tree has not moved since. Runs nothing. */
  useLastCheck?: boolean;
}

export interface Analysis {
  map: MapFile;
  snapshot: Snapshot;
  /** Identifies, per node, what a verdict was about, so that a later change voids it. */
  fingerprints: Map<string, string>;
  spans: Map<string, ResolvedAnchor[]>;
}

function shortSpan(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= SHORT_SPAN_CHARS ? trimmed : `${trimmed.slice(0, SHORT_SPAN_CHARS - 1)}…`;
}

/** The lines that differ between two versions of a span. */
export function changedLines(before: string, after: string): { before: string; after: string } {
  const a = before.split("\n");
  const b = after.split("\n");
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a[prefix]?.trim() === b[prefix]?.trim()) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && a[a.length - 1 - suffix]?.trim() === b[b.length - 1 - suffix]?.trim()) suffix++;
  const oldPart = a.slice(prefix, a.length - suffix).join("\n");
  const newPart = b.slice(prefix, b.length - suffix).join("\n");
  return oldPart === "" && newPart === "" ? { before, after } : { before: oldPart, after: newPart };
}

/** The commit a node's hashes were last set against. */
function baselineOf(map: MapFile, node: MapNode, decisions: { id: string; commit: string }[]): string | null {
  for (let i = decisions.length - 1; i >= 0; i--) {
    const decision = decisions[i];
    if (decision?.id === node.id && decision.commit !== "") return decision.commit;
  }
  return map.baseline;
}

class Baselines {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly root: string) {}

  at(commit: string): Workspace {
    let ws = this.workspaces.get(commit);
    if (ws === undefined) {
      ws = new Workspace(new RepoFiles(this.root, commit));
      this.workspaces.set(commit, ws);
    }
    return ws;
  }

  async dispose(): Promise<void> {
    for (const ws of this.workspaces.values()) await ws.dispose();
  }
}

function upstreamOf(id: string, map: MapFile, classes: Map<string, NodeClass>): string[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const pending = [...(byId.get(id)?.depends_on ?? [])];
  while (pending.length > 0) {
    const next = pending.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(byId.get(next)?.depends_on ?? []));
  }
  return [...seen].filter((n) => classes.get(n) !== "fresh");
}

function recentActivity(root: string, map: MapFile): SnapshotActivity[] {
  const latest = new Map<string, string>();
  for (const { path: rel } of changedPaths(root)) {
    if (latest.has(rel)) continue;
    try {
      latest.set(rel, statSync(path.join(root, ...rel.split("/"))).mtime.toISOString());
    } catch {
      latest.set(rel, new Date().toISOString());
    }
  }
  const log = tryGit(root, ["log", "-n", "30", "--format=%x01%cI", "--name-only"]) ?? "";
  let when = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("\u0001")) when = line.slice(1).trim();
    else if (line.trim() !== "" && !latest.has(line)) latest.set(line, when);
  }
  const activity: SnapshotActivity[] = [];
  for (const [file, changedAt] of latest) {
    if (file.startsWith(".mathkeel/") || isSensitivePath(file)) continue;
    const touches = map.nodes
      .filter(
        (n) =>
          allAnchors(n).some((a) => a.anchor.path === file) ||
          n.verified_by.some((ref) => ref.split("::")[0] === file),
      )
      .map((n) => n.id);
    activity.push({ path: file, changedAt, touches });
  }
  activity.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  return activity.slice(0, ACTIVITY_LIMIT);
}

function fingerprintOf(node: MapNode, spans: ResolvedAnchor[], failed: string[]): string {
  return sha256(JSON.stringify([node.id, [...failed].sort(), spans.map((s) => s.hash)]));
}

export async function analyse(root: string, options: SnapshotOptions = {}): Promise<Analysis> {
  const map = loadMap(root);
  const results = options.contractResults ?? (options.useLastCheck ? loadLastCheck(root, map) : null);
  const contractsRun = results !== null;

  const files = new RepoFiles(root);
  const ws = new Workspace(files);
  const baselines = new Baselines(root);
  try {
    const decisions = readDecisions(root);
    const verdicts = loadVerdicts(root);
    const spans = new Map<string, ResolvedAnchor[]>();
    const anchorsById = new Map<string, SnapshotAnchor[]>();
    const fingerprints = new Map<string, string>();
    const inputs: ClassifyInput[] = [];

    for (const node of map.nodes) {
      const nodeSpans: ResolvedAnchor[] = [];
      const anchors: SnapshotAnchor[] = [];
      const commit = baselineOf(map, node, decisions);
      for (const { anchor, kind } of allAnchors(node)) {
        const resolved = await resolveAnchor(ws, kind, anchor);
        nodeSpans.push(resolved);
        let before: string | null = null;
        let after = resolved.text === null ? null : shortSpan(resolved.text);
        if (resolved.state !== "fresh") {
          const old = commit === null ? null : await resolveAnchor(baselines.at(commit), kind, anchor);
          const oldText = old?.text ?? null;
          if (oldText !== null && resolved.text !== null) {
            const diff = changedLines(oldText, resolved.text);
            before = shortSpan(diff.before);
            after = shortSpan(diff.after);
          } else {
            before = oldText !== null ? shortSpan(oldText) : anchor.quote === "" ? null : shortSpan(anchor.quote);
          }
        }
        anchors.push({
          kind,
          path: anchor.path,
          symbol: anchor.symbol,
          state: resolved.state,
          line: resolved.line,
          before,
          after,
        });
      }
      spans.set(node.id, nodeSpans);
      anchorsById.set(node.id, anchors);

      const contracts = node.contracts.map((id) => ({ id, state: results?.get(id)?.state ?? ("not_run" as const) }));
      const failed = contracts.filter((c) => c.state === "fail").map((c) => c.id);
      const fingerprint = fingerprintOf(node, nodeSpans, failed);
      fingerprints.set(node.id, fingerprint);
      const stored = contractsRun ? verdicts.get(node.id) : undefined;
      inputs.push({
        id: node.id,
        anchors: anchors.map((a, i) => ({ kind: a.kind, state: a.state, note: nodeSpans[i]?.note ?? "" })),
        contracts,
        verdict: stored?.fingerprint === fingerprint ? stored.verdict : null,
      });
    }

    const classified = classify(inputs);
    const classes = new Map([...classified].map(([id, c]) => [id, c.class]));
    const nodes: SnapshotNode[] = map.nodes.map((node) => {
      const outcome = classified.get(node.id);
      const stored = contractsRun ? verdicts.get(node.id) : undefined;
      const current = stored?.fingerprint === fingerprints.get(node.id) ? stored : undefined;
      return {
        ...node,
        class: outcome?.class ?? "fresh",
        reasons: outcome?.reasons ?? [],
        anchors: anchorsById.get(node.id) ?? [],
        contractResults: node.contracts.map((id) => {
          const result = results?.get(id);
          return { id, state: result?.state ?? "not_run", msg: result?.msg ?? "" };
        }),
        upstreamChanged: upstreamOf(node.id, map, classes),
        verdict: current ? { verdict: current.verdict, confidence: current.confidence, reason: current.reason } : null,
      };
    });

    const gaps = await computeGaps(map, ws);
    const { uncharted, share } = computeUncharted(map, files);
    const count = (c: NodeClass): number => nodes.filter((n) => n.class === c).length;
    const titles = new Map(map.chains.map((c) => [c.id, c.title]));
    const chainIds = [...new Set([...map.chains.map((c) => c.id), ...map.nodes.map((n) => n.chain)])];

    const snapshot: Snapshot = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      repo: {
        name: path.basename(root),
        head: headCommit(root),
        dirty: (tryGit(root, ["status", "--porcelain=v1"]) ?? "").trim() !== "",
        baseline: map.baseline ?? "",
      },
      contractsRun,
      summary: {
        fresh: count("fresh"),
        queue: count("queue"),
        alert: count("alert"),
        review: count("review"),
        gaps: gaps.length,
        unchartedShare: share,
      },
      chains: chainIds.map((id) => ({
        id,
        title: titles.get(id) ?? id,
        nodeIds: map.nodes.filter((n) => n.chain === id).map((n) => n.id),
      })),
      nodes,
      gaps,
      uncharted,
      activity: recentActivity(root, map),
      decisions: decisions.map(({ id, by, at, reason }) => ({ id, by, at, reason })),
    };
    return { map, snapshot, fingerprints, spans };
  } finally {
    await ws.dispose();
    await baselines.dispose();
  }
}

export async function buildSnapshot(root: string, options: SnapshotOptions = {}): Promise<Snapshot> {
  return (await analyse(root, options)).snapshot;
}
