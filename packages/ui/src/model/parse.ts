import type { Snapshot } from "../snapshot";

export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Checks the outer shape once, at the border, and fills optional per-node
 * fields so a slightly older engine degrades to blanks rather than a crash.
 */
export function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) {
    throw new SnapshotError(
      "The snapshot could not be read.",
      "The engine returned no JSON object.",
    );
  }
  if (value.schema !== 1) {
    throw new SnapshotError(
      "This snapshot uses another schema.",
      `Schema ${String(value.schema)} is not schema 1, which this UI reads. Update mathkeel so the engine and UI match.`,
    );
  }
  for (const field of ["chains", "nodes", "gaps", "uncharted", "activity", "decisions"] as const) {
    if (!Array.isArray(value[field])) {
      throw new SnapshotError("The snapshot is incomplete.", `The field "${field}" is missing.`);
    }
  }
  const snapshot = value as unknown as Snapshot;
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      reasons: node.reasons ?? [],
      anchors: node.anchors ?? [],
      contractResults: node.contractResults ?? [],
      upstreamChanged: node.upstreamChanged ?? [],
      verdict: node.verdict ?? null,
      depends_on: node.depends_on ?? [],
      contracts: node.contracts ?? [],
      verified_by: node.verified_by ?? [],
      code: node.code ?? [],
      pinned_to_code: node.pinned_to_code ?? false,
      proof: node.proof ?? { state: "absent", ref: null },
    })),
  };
}
