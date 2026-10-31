/**
 * The Snapshot contract is owned by the engine (`packages/core/src/types.ts`).
 * These aliases only give the UI short names for its parts, so a contract
 * change in the engine surfaces here as a type error.
 */
import type { NodeClass, Snapshot, SnapshotNode } from "mathkeel/types";

export type { MapNode, NodeClass, Snapshot, SnapshotNode } from "mathkeel/types";

export type NodeKind = SnapshotNode["kind"];
export type NodeStatus = SnapshotNode["status"];
export type Proof = SnapshotNode["proof"];
export type Anchor = SnapshotNode["anchors"][number];
export type AnchorState = Anchor["state"];
export type ContractResult = SnapshotNode["contractResults"][number];
export type Gap = Snapshot["gaps"][number];
export type Uncharted = Snapshot["uncharted"][number];
export type Activity = Snapshot["activity"][number];
export type OpenClass = Exclude<NodeClass, "fresh">;
