/**
 * The contract between the engine and the UI. This file holds types only and
 * imports nothing, so the UI can import it without pulling engine code:
 *
 *   import type { Snapshot } from "mathkeel/types";
 */

export type NodeKind =
  | "assumption"
  | "definition"
  | "equation"
  | "lemma"
  | "theorem"
  | "code"
  | "test"
  | "convention"
  | "parameter"
  | "closed_list";

export type NodeStatus =
  | "stated"
  | "argued"
  | "implemented"
  | "numerically_checked"
  | "formally_checked";

export type ProofState = "absent" | "sketch" | "checked";

export interface Anchor {
  path: string;
  symbol: string | null;
  quote: string;
  /** sha256 of the normalised span; null until `map freeze`. */
  hash: string | null;
}

export interface MapNode {
  id: string;
  chain: string;
  kind: NodeKind;
  title: string;
  latex?: string | undefined;
  status: NodeStatus;
  proof: { state: ProofState; ref: string | null };
  doc: Anchor | null;
  code: Anchor[];
  units: string | null;
  depends_on: string[];
  contracts: string[];
  verified_by: string[];
  /** True when an ambiguity was settled by reading code: the UI must say "matches current behaviour". */
  pinned_to_code: boolean;
}

export type ContractKind = "numeric" | "unit" | "literal" | "census";

export interface Contract {
  id: string;
  kind: ContractKind;
  command: string[];
  timeout_s: number;
}

export interface InventoryEntry {
  functions: string[];
  parameters: string[];
  members: string[];
}

export interface MapChain {
  id: string;
  title: string;
}

export interface MapFile {
  schema: 1;
  baseline: string | null;
  chains: MapChain[];
  contracts: Contract[];
  nodes: MapNode[];
  inventory: Record<string, InventoryEntry>;
}

export type NodeClass = "fresh" | "queue" | "alert" | "review";
export type AnchorState = "fresh" | "queue" | "lost";
export type ContractState = "pass" | "fail" | "not_run";
export type GapKind = "function" | "parameter" | "member";
export type VerdictValue = "error" | "legitimate" | "uncertain";

export interface SnapshotAnchor {
  kind: "doc" | "code";
  path: string;
  symbol: string | null;
  state: AnchorState;
  line: number | null;
  /** Short span at the baseline; null on a fresh anchor. */
  before: string | null;
  /** Short span now; null when the anchor is lost. */
  after: string | null;
}

export interface SnapshotContractResult {
  id: string;
  state: ContractState;
  msg: string;
}

export interface SnapshotVerdict {
  verdict: string;
  confidence: number;
  reason: string;
}

export type SnapshotNode = MapNode & {
  class: NodeClass;
  reasons: string[];
  anchors: SnapshotAnchor[];
  contractResults: SnapshotContractResult[];
  upstreamChanged: string[];
  verdict: SnapshotVerdict | null;
};

export interface SnapshotGap {
  path: string;
  symbol: string;
  kind: GapKind;
}

export interface SnapshotUncharted {
  path: string;
  lines: number;
}

export interface SnapshotActivity {
  path: string;
  changedAt: string;
  touches: string[];
}

export interface SnapshotDecision {
  id: string;
  by: string;
  at: string;
  reason: string;
}

export interface Snapshot {
  schema: 1;
  generatedAt: string;
  repo: { name: string; head: string; dirty: boolean; baseline: string };
  contractsRun: boolean;
  summary: {
    fresh: number;
    queue: number;
    alert: number;
    review: number;
    gaps: number;
    unchartedShare: number;
  };
  chains: { id: string; title: string; nodeIds: string[] }[];
  nodes: SnapshotNode[];
  gaps: SnapshotGap[];
  uncharted: SnapshotUncharted[];
  activity: SnapshotActivity[];
  decisions: SnapshotDecision[];
}
