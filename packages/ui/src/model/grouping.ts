import type { Gap, NodeClass, OpenClass, Snapshot, SnapshotNode } from "../snapshot";
import { CLASS_ORDER, classLabel } from "./language";

/**
 * Inbox grouping. One root cause, however many nodes it touched, is one row:
 *
 * - changed nodes that share a failed contract are one cause;
 * - a changed node that sits downstream of another cause collapses under it;
 * - unchanged nodes listing `upstreamChanged` collapse under the same cause, and
 *   they are never entries of their own (SPEC: neither queue nor alert).
 */

export interface DownstreamEntry {
  node: SnapshotNode;
  /** Other root causes this node also sits under. */
  alsoUnder: string[];
}

export interface RootCause {
  id: string;
  cls: OpenClass;
  /** Contract shared by the members, when that is what joins them. */
  contract: { id: string; msg: string } | null;
  /** Nodes that changed at the root of this cause. */
  members: SnapshotNode[];
  /** Everything collapsed under them, changed nodes first. */
  downstream: DownstreamEntry[];
}

export interface InboxSection {
  cls: OpenClass;
  label: string;
  causes: RootCause[];
}

export interface GapGroup {
  path: string;
  gaps: Gap[];
}

export interface Inbox {
  sections: InboxSection[];
  gaps: GapGroup[];
  /** Changed node ids in reading order, used to step through the Inbox. */
  order: string[];
  /** Root causes that need a person, gaps excluded. */
  causeCount: number;
}

const rank = (cls: NodeClass): number => CLASS_ORDER.indexOf(cls);

function pressing(nodes: readonly SnapshotNode[]): NodeClass {
  return nodes.reduce<NodeClass>(
    (best, node) => (rank(node.class) < rank(best) ? node.class : best),
    "fresh",
  );
}

function failedContracts(node: SnapshotNode): string[] {
  return node.contractResults
    .filter((result) => result.state === "fail")
    .map((result) => result.id);
}

class Components {
  private readonly parent = new Map<string, string>();

  find(id: string): string {
    let root = id;
    while (this.parent.has(root) && this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

export function groupInbox(snapshot: Pick<Snapshot, "nodes" | "gaps">): Inbox {
  const changed = snapshot.nodes.filter((node) => node.class !== "fresh");
  const changedIds = new Set(changed.map((node) => node.id));

  const components = new Components();
  const byContract = new Map<string, SnapshotNode[]>();
  for (const node of changed) {
    for (const contract of failedContracts(node)) {
      const sharers = byContract.get(contract) ?? [];
      const first = sharers[0];
      if (first) components.union(first.id, node.id);
      sharers.push(node);
      byContract.set(contract, sharers);
    }
  }

  const memberships = new Map<string, SnapshotNode[]>();
  for (const node of changed) {
    const key = components.find(node.id);
    const list = memberships.get(key) ?? [];
    list.push(node);
    memberships.set(key, list);
  }

  // A component is a root cause unless one of its nodes lists another changed
  // component upstream. Following those links ends at roots, cycles included.
  const upstreamOf = (key: string): Set<string> => {
    const up = new Set<string>();
    for (const node of memberships.get(key) ?? []) {
      for (const id of node.upstreamChanged) {
        if (!changedIds.has(id)) continue;
        const other = components.find(id);
        if (other !== key) up.add(other);
      }
    }
    return up;
  };

  const rootsOf = (key: string, trail: Set<string> = new Set()): Set<string> => {
    if (trail.has(key)) return new Set();
    trail.add(key);
    const up = upstreamOf(key);
    if (up.size === 0) return new Set([key]);
    const roots = new Set<string>();
    for (const other of up) for (const root of rootsOf(other, trail)) roots.add(root);
    return roots;
  };

  const resolved = new Map<string, Set<string>>();
  for (const key of memberships.keys()) {
    const roots = rootsOf(key);
    // A pure cycle has no entry point: each of its components stands alone.
    resolved.set(key, roots.size > 0 ? roots : new Set([key]));
  }

  const causes = new Map<string, RootCause>();
  for (const [key, roots] of resolved) {
    if (!roots.has(key)) continue;
    const members = memberships.get(key) ?? [];
    const shared = [...new Set(members.flatMap(failedContracts))].find(
      (id) => (byContract.get(id)?.length ?? 0) > 1,
    );
    const result = shared
      ? members
          .flatMap((node) => node.contractResults)
          .find((entry) => entry.id === shared && entry.state === "fail")
      : undefined;
    causes.set(key, {
      id: key,
      cls: pressing(members) as OpenClass,
      contract: shared ? { id: shared, msg: result?.msg ?? "" } : null,
      members,
      downstream: [],
    });
  }

  const byPressure = (a: string, b: string): number =>
    rank(causes.get(a)?.cls ?? "fresh") - rank(causes.get(b)?.cls ?? "fresh") ||
    a.localeCompare(b);

  const collapse = (node: SnapshotNode, roots: Iterable<string>): void => {
    const [first, ...rest] = [...roots].sort(byPressure);
    const cause = first ? causes.get(first) : undefined;
    if (!cause) return;
    cause.downstream.push({
      node,
      alsoUnder: rest.flatMap((key) => causes.get(key)?.members[0]?.id ?? []),
    });
  };

  for (const [key, roots] of resolved) {
    if (roots.has(key)) continue;
    for (const node of memberships.get(key) ?? []) collapse(node, roots);
  }

  for (const node of snapshot.nodes) {
    if (node.class !== "fresh") continue;
    const roots = new Set<string>();
    for (const id of node.upstreamChanged) {
      if (!changedIds.has(id)) continue;
      for (const root of resolved.get(components.find(id)) ?? []) roots.add(root);
    }
    if (roots.size > 0) collapse(node, roots);
  }

  for (const cause of causes.values()) {
    cause.downstream.sort(
      (a, b) => rank(a.node.class) - rank(b.node.class) || a.node.id.localeCompare(b.node.id),
    );
    // A changed node downstream raises the cause, so nothing urgent sits low.
    const raised = pressing([...cause.members, ...cause.downstream.map((entry) => entry.node)]);
    if (rank(raised) < rank(cause.cls)) cause.cls = raised as OpenClass;
  }

  const sections: InboxSection[] = [];
  for (const cls of ["alert", "review", "queue"] as const) {
    const inSection = [...causes.values()]
      .filter((cause) => cause.cls === cls)
      .sort(
        (a, b) =>
          b.downstream.length + b.members.length - (a.downstream.length + a.members.length) ||
          a.id.localeCompare(b.id),
      );
    if (inSection.length > 0) sections.push({ cls, label: classLabel(cls), causes: inSection });
  }

  const gapPaths = new Map<string, Gap[]>();
  for (const gap of snapshot.gaps) {
    const list = gapPaths.get(gap.path) ?? [];
    list.push(gap);
    gapPaths.set(gap.path, list);
  }
  const gaps = [...gapPaths.entries()]
    .map(([path, entries]) => ({ path, gaps: entries }))
    .sort((a, b) => b.gaps.length - a.gaps.length || a.path.localeCompare(b.path));

  const order = sections.flatMap((section) =>
    section.causes.flatMap((cause) => [
      ...cause.members.map((node) => node.id),
      ...cause.downstream
        .filter((entry) => entry.node.class !== "fresh")
        .map((entry) => entry.node.id),
    ]),
  );

  return { sections, gaps, order, causeCount: causes.size };
}
