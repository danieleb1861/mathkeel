import type { AnchorState, ContractState, NodeClass, VerdictValue } from "./types.js";

export interface ClassifyAnchor {
  kind: "doc" | "code";
  state: AnchorState;
  /** Shown in the reason; has no effect on the class. */
  note?: string;
}

export interface ClassifyContract {
  id: string;
  state: ContractState;
}

export interface ClassifyInput {
  id: string;
  anchors: ClassifyAnchor[];
  contracts: ClassifyContract[];
  /** A proposal from `judge apply`. It can move an alert to review and nothing else. */
  verdict?: VerdictValue | null;
}

export interface ClassifyOutput {
  class: NodeClass;
  reasons: string[];
}

function hasMovedDoc(node: ClassifyInput): boolean {
  return node.anchors.some((a) => a.kind === "doc" && a.state !== "fresh");
}

function sharersOf(contractId: string, nodes: ClassifyInput[]): ClassifyInput[] {
  return nodes.filter((n) => n.contracts.some((c) => c.id === contractId));
}

/**
 * The classification rules of SPEC.md, as one pure function. They passed the
 * evaluation: do not change them without a new evaluation.
 *
 * 1. alert if one of its contracts failed and no node sharing that contract has
 *    a non-fresh doc anchor.
 * 2. queue if a contract failed while a node sharing it has a non-fresh doc anchor.
 * 3. queue if any anchor is queue or lost. Anchors alone never alert.
 * 4. fresh otherwise.
 *
 * A contract that was not run counts as not failed, so a snapshot from `status`
 * can only hold fresh or queue. A `legitimate` verdict turns an alert into
 * review; `error`, `uncertain` and no verdict leave it an alert.
 */
export function classify(nodes: ClassifyInput[]): Map<string, ClassifyOutput> {
  const result = new Map<string, ClassifyOutput>();
  for (const node of nodes) {
    const reasons: string[] = [];
    const failed = node.contracts.filter((c) => c.state === "fail");
    const unexplained = failed.filter((c) => !sharersOf(c.id, nodes).some(hasMovedDoc));
    const explained = failed.filter((c) => !unexplained.includes(c));

    for (const contract of unexplained) {
      reasons.push(`contract ${contract.id} failed and no documentation moved`);
    }
    for (const contract of explained) {
      const movers = sharersOf(contract.id, nodes)
        .filter(hasMovedDoc)
        .map((n) => n.id);
      reasons.push(`contract ${contract.id} failed; the documentation moved with the code on ${movers.join(", ")}`);
    }
    for (const anchor of node.anchors) {
      if (anchor.state !== "fresh") reasons.push(anchor.note || `${anchor.kind} anchor is ${anchor.state}`);
    }

    let nodeClass: NodeClass;
    if (unexplained.length > 0) nodeClass = node.verdict === "legitimate" ? "review" : "alert";
    else if (explained.length > 0) nodeClass = "queue";
    else if (node.anchors.some((a) => a.state !== "fresh")) nodeClass = "queue";
    else nodeClass = "fresh";

    if (nodeClass === "review") reasons.push("the judge proposed legitimate; a person decides");
    result.set(node.id, { class: nodeClass, reasons });
  }
  return result;
}
