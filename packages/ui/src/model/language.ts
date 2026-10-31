import type {
  AnchorState,
  ContractResult,
  NodeClass,
  NodeKind,
  NodeStatus,
  Proof,
  SnapshotNode,
} from "../snapshot";

/**
 * Every word the UI says about a result lives here, so that honesty can be
 * tested in one place. mathkeel reports that a documented result changed. It
 * does not know whether code or mathematics is right, and it must not sound as
 * if it did. Text quoted from the map is evidence and is shown verbatim.
 */

export const CLASS_ORDER: readonly NodeClass[] = ["alert", "review", "queue", "fresh"];

const CLASS_LABEL: Record<NodeClass, string> = {
  alert: "Changed",
  review: "Proposal waiting",
  queue: "Needs review",
  fresh: "Unchanged",
};

const CLASS_SENTENCE: Record<NodeClass, string> = {
  alert: "This documented result changed: a contract failed and the documentation did not move.",
  review:
    "This documented result changed. An agent proposes that the change is legitimate. A person decides.",
  queue: "An anchor changed or moved. Read both spans before deciding anything.",
  fresh: "Every anchor matches the baseline.",
};

export function classLabel(cls: NodeClass): string {
  return CLASS_LABEL[cls];
}

export function classSentence(cls: NodeClass): string {
  return CLASS_SENTENCE[cls];
}

const KIND_LABEL: Record<NodeKind, string> = {
  assumption: "Assumption",
  definition: "Definition",
  equation: "Equation",
  lemma: "Lemma",
  theorem: "Theorem",
  code: "Code",
  test: "Test",
  convention: "Convention",
  parameter: "Parameter",
  closed_list: "Closed list",
};

export function kindLabel(kind: NodeKind): string {
  return KIND_LABEL[kind] ?? kind;
}

const PINNED_LABEL = "Matches current behaviour";

const STATUS_RUNGS: readonly { status: NodeStatus; label: string }[] = [
  { status: "stated", label: "Stated" },
  { status: "argued", label: "Argued" },
  { status: "implemented", label: "Implemented" },
  { status: "numerically_checked", label: "Numerically checked" },
  { status: "formally_checked", label: "Formally checked" },
];

export interface Rung {
  status: NodeStatus;
  label: string;
  reached: boolean;
  current: boolean;
}

/**
 * The status ladder. A node pinned to code was specified by reading the code,
 * so its checks only show that the code agrees with itself: the two "checked"
 * rungs collapse into one that says so.
 */
export function statusLadder(status: NodeStatus, pinned: boolean): Rung[] {
  const rank = STATUS_RUNGS.findIndex((rung) => rung.status === status);
  if (!pinned) {
    return STATUS_RUNGS.map((rung, index) => ({
      ...rung,
      reached: index <= rank,
      current: index === rank,
    }));
  }
  const top = rank >= 3;
  return [
    ...STATUS_RUNGS.slice(0, 3).map((rung, index) => ({
      ...rung,
      reached: index <= rank,
      current: index === rank,
    })),
    {
      status: "numerically_checked" as const,
      label: PINNED_LABEL,
      reached: top,
      current: top,
    },
  ];
}

export function statusLabel(status: NodeStatus, pinned: boolean): string {
  const rung = statusLadder(status, pinned).find((candidate) => candidate.current);
  return rung?.label ?? status;
}

export function contractStateLabel(state: ContractResult["state"], pinned: boolean): string {
  if (state === "fail") return "Failed";
  if (state === "not_run") return "Not run";
  return pinned ? PINNED_LABEL : "Passed";
}

export function proofLabel(proof: Proof, pinned: boolean): string {
  if (pinned) return "No proof: settled by reading the code";
  if (proof.state === "checked") return "Checked proof on record";
  if (proof.state === "sketch") return "Sketch only";
  return "No proof on record";
}

export function anchorLabel(state: AnchorState): string {
  if (state === "fresh") return "Unchanged";
  if (state === "queue") return "Changed";
  return "Not found";
}

/** Verdicts are an agent's proposals. The label says so, whatever the verdict. */
export function verdictLabel(verdict: string): string {
  if (verdict === "legitimate") return "Proposes: legitimate change";
  if (verdict === "error") return "Proposes: possible error";
  if (verdict === "uncertain") return "Proposes: uncertain";
  return `Proposes: ${verdict}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The exact command a person runs. The UI only ever hands it over. */
export function acceptCommand(id: string): string {
  return `mathkeel accept ${shellQuote(id)} --reason "<why this change is accepted>"`;
}

export function needsAcceptance(node: Pick<SnapshotNode, "class">): boolean {
  return node.class !== "fresh";
}

const CLAIMS =
  /\b(wrong|wrongly|incorrect|correct|correctly|proved|proven|guaranteed|validated|bug|broken)\b/i;

/** True when a string of UI copy stays inside what mathkeel can honestly say. */
export function isHonest(copy: string): boolean {
  return !CLAIMS.test(copy);
}
