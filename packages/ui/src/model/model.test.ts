import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import demo from "../../fixtures/demo.snapshot.json";
import type { Snapshot, SnapshotNode } from "../snapshot";
import { diffWords } from "./diff";
import { formulaSheet } from "./formulas";
import { groupInbox } from "./grouping";
import {
  acceptCommand,
  classLabel,
  contractStateLabel,
  isHonest,
  proofLabel,
  statusLabel,
  statusLadder,
  verdictLabel,
} from "./language";
import { type ElkRun, fogWidth, FORMULA_HEIGHT, layoutChart, MARK_HEIGHT, topologyKey } from "./layout";
import { parseSnapshot, SnapshotError } from "./parse";
import { buildGraph } from "./trace";

const snapshot = demo as unknown as Snapshot;

function node(id: string, extra: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    id,
    chain: "c",
    kind: "equation",
    title: id,
    status: "stated",
    proof: { state: "absent", ref: null },
    doc: { path: "d.md", symbol: null, quote: "", hash: "" },
    code: [],
    units: null,
    depends_on: [],
    contracts: [],
    verified_by: [],
    pinned_to_code: false,
    class: "fresh",
    reasons: [],
    anchors: [],
    contractResults: [],
    upstreamChanged: [],
    verdict: null,
    ...extra,
  };
}

const failed = (id: string) => [{ id, state: "fail" as const, msg: "moved" }];

describe("groupInbox", () => {
  it("joins nodes sharing a failed contract into one cause", () => {
    const inbox = groupInbox({
      gaps: [],
      nodes: [
        node("a", { class: "alert", contractResults: failed("k") }),
        node("b", { class: "alert", contractResults: failed("k") }),
      ],
    });
    expect(inbox.causeCount).toBe(1);
    const cause = inbox.sections[0]?.causes[0];
    expect(cause?.contract?.id).toBe("k");
    expect(cause?.members.map((member) => member.id)).toEqual(["a", "b"]);
  });

  it("collapses downstream nodes under the node that changed", () => {
    const inbox = groupInbox({
      gaps: [],
      nodes: [
        node("root", { class: "queue" }),
        node("mid", { class: "queue", upstreamChanged: ["root"] }),
        node("leaf", { upstreamChanged: ["root", "mid"] }),
      ],
    });
    expect(inbox.causeCount).toBe(1);
    expect(inbox.sections[0]?.causes[0]?.downstream.map((entry) => entry.node.id)).toEqual(["mid", "leaf"]);
    expect(inbox.order).toEqual(["root", "mid"]);
  });

  it("never lists an upstream-only node as an entry of its own", () => {
    const inbox = groupInbox({ gaps: [], nodes: [node("x", { upstreamChanged: ["gone"] })] });
    expect(inbox.sections).toEqual([]);
    expect(inbox.order).toEqual([]);
  });

  it("orders alerts, then review, then queue, and a changed node downstream raises its cause", () => {
    const inbox = groupInbox({
      gaps: [],
      nodes: [
        node("q", { class: "queue" }),
        node("r", { class: "review" }),
        node("a", { class: "alert" }),
        node("q2", { class: "queue" }),
        node("hot", { class: "alert", upstreamChanged: ["q2"] }),
      ],
    });
    expect(inbox.sections.map((section) => section.cls)).toEqual(["alert", "review", "queue"]);
    expect(inbox.sections[0]?.causes.map((cause) => cause.id).sort()).toEqual(["a", "q2"]);
  });

  it("keeps a node under one cause and notes the other", () => {
    const inbox = groupInbox({
      gaps: [],
      nodes: [
        node("p", { class: "alert" }),
        node("q", { class: "queue" }),
        node("shared", { upstreamChanged: ["p", "q"] }),
      ],
    });
    const entries = inbox.sections.flatMap((section) => section.causes.flatMap((cause) => cause.downstream));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.alsoUnder).toEqual(["q"]);
  });

  it("survives a cycle in upstreamChanged", () => {
    const inbox = groupInbox({
      gaps: [],
      nodes: [
        node("a", { class: "queue", upstreamChanged: ["b"] }),
        node("b", { class: "queue", upstreamChanged: ["a"] }),
      ],
    });
    expect(inbox.order.sort()).toEqual(["a", "b"]);
  });

  it("groups the fixture into its four causes", () => {
    const inbox = groupInbox(snapshot);
    expect(inbox.causeCount).toBe(4);
    expect(inbox.sections[0]?.causes[0]?.contract?.id).toBe("nw_matches_spec");
    expect(inbox.gaps[0]?.gaps).toHaveLength(2);
  });
});

describe("honest language", () => {
  it("says a pinned node matches current behaviour, never checked", () => {
    expect(statusLabel("numerically_checked", true)).toBe("Matches current behaviour");
    expect(statusLabel("formally_checked", true)).toBe("Matches current behaviour");
    expect(contractStateLabel("pass", true)).toBe("Matches current behaviour");
    const rungs = statusLadder("numerically_checked", true).map((rung) => rung.label.toLowerCase());
    expect(rungs.some((label) => label.includes("checked"))).toBe(false);
    expect(proofLabel({ state: "checked", ref: "p" }, true).toLowerCase()).not.toContain("checked");
  });

  it("presents verdicts as proposals", () => {
    for (const verdict of ["error", "legitimate", "uncertain", "other"]) {
      expect(verdictLabel(verdict).startsWith("Proposes:")).toBe(true);
    }
  });

  it("labels classes without claims", () => {
    expect(classLabel("alert")).toBe("Changed");
    expect(classLabel("queue")).toBe("Needs review");
  });

  it("detects forbidden claims", () => {
    expect(isHonest("This documented result changed")).toBe(true);
    expect(isHonest("The code is wrong")).toBe(false);
    expect(isHonest("This is proved")).toBe(false);
  });

  it("keeps every string literal in the views free of claims", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".tsx") && !path.includes("preview")) files.push(path);
      }
    };
    walk(join(__dirname, ".."));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      expect(isHonest(code), file).toBe(true);
    }
  });

  it("builds an exact accept command and quotes unusual ids", () => {
    expect(acceptCommand("dm.variance")).toBe('mathkeel accept dm.variance --reason "<why this change is accepted>"');
    expect(acceptCommand("a b;rm")).toContain("'a b;rm'");
    expect(acceptCommand("it's")).toContain(`'it'\\''s'`);
  });
});

describe("model helpers", () => {
  it("counts soundings through the whole downstream, safely on cycles", () => {
    const graph = buildGraph({
      nodes: [node("a"), node("b", { depends_on: ["a"] }), node("c", { depends_on: ["b", "a"] })],
    });
    expect(graph.soundings.get("a")).toBe(2);
    expect(graph.soundings.get("c")).toBe(0);
    const loop = buildGraph({ nodes: [node("x", { depends_on: ["y"] }), node("y", { depends_on: ["x"] })] });
    expect(loop.soundings.get("x")).toBe(1);
  });

  it("sizes fog so its area share equals the uncharted share", () => {
    const width = 1000;
    const fog = fogWidth(width, 0.18);
    expect(fog / (fog + width)).toBeCloseTo(0.18, 6);
    expect(fogWidth(width, 0)).toBe(0);
  });

  it("orders formulas after what they depend on and keeps a missing one listed", () => {
    const sheet = formulaSheet({
      chains: [{ id: "c", title: "C", nodeIds: ["late", "early", "note", "bare"] }],
      nodes: [
        node("late", { latex: "b", depends_on: ["early"] }),
        node("early", { latex: "a", depends_on: ["note"] }),
        node("note", { kind: "assumption" }),
        node("bare"),
      ],
    });
    expect(sheet.groups[0]?.entries.map((entry) => [entry.number, entry.node.id])).toEqual([
      [1, "early"],
      [2, "late"],
      [3, "bare"],
    ]);
    expect([sheet.total, sheet.withFormula]).toEqual([3, 2]);
  });

  it("survives a cycle in a snapshot", () => {
    const sheet = formulaSheet({
      chains: [{ id: "c", title: "C", nodeIds: ["a", "b"] }],
      nodes: [node("a", { depends_on: ["b"] }), node("b", { depends_on: ["a"] })],
    });
    expect(sheet.total).toBe(2);
  });

  it("makes room for a formula only on a mark that has one, and only when asked", async () => {
    const parts = {
      chains: [{ id: "c", title: "C", nodeIds: ["tex", "plain"] }],
      nodes: [node("tex", { latex: "x" }), node("plain")],
      uncharted: [],
      summary: { ...snapshot.summary, unchartedShare: 0 },
    };
    const run: ElkRun = async (graph) => {
      let y = 0;
      const children = graph.children.map((child) => {
        const placed = { id: child.id, x: 0, y };
        y += child.height + 8;
        return placed;
      });
      return { children, edges: [] };
    };
    const heights = async (formulas: boolean) => {
      const layout = await layoutChart(parts, run, formulas);
      return [layout.nodes.map((entry) => entry.height), layout.height];
    };
    expect(await heights(false)).toEqual([[MARK_HEIGHT, MARK_HEIGHT], 2 * MARK_HEIGHT + 8 + 34]);
    expect(await heights(true)).toEqual([
      [MARK_HEIGHT + FORMULA_HEIGHT, MARK_HEIGHT],
      2 * MARK_HEIGHT + FORMULA_HEIGHT + 8 + 34,
    ]);
    expect(topologyKey(parts)).not.toBe(topologyKey({ ...parts, nodes: [node("tex"), node("plain")] }));
  });

  it("diffs words and marks only what moved", () => {
    expect(diffWords("w = 1 - j / (q + 1)", "w = 1 - j / q")).toEqual([
      { type: "same", text: "w = 1 - j / " },
      { type: "removed", text: "(" },
      { type: "same", text: "q" },
      { type: "removed", text: " + 1)" },
    ]);
  });

  it("rejects another schema and fills optional fields", () => {
    expect(() => parseSnapshot({ ...snapshot, schema: 2 })).toThrow(SnapshotError);
    const parsed = parseSnapshot({ ...snapshot, nodes: [{ id: "n" }] });
    expect(parsed.nodes[0]?.upstreamChanged).toEqual([]);
  });

  it("keeps the fixture summary equal to its nodes", () => {
    const count = (cls: string) => snapshot.nodes.filter((entry) => entry.class === cls).length;
    expect(snapshot.summary.alert).toBe(count("alert"));
    expect(snapshot.summary.queue).toBe(count("queue"));
    expect(snapshot.summary.review).toBe(count("review"));
    expect(snapshot.summary.fresh).toBe(count("fresh"));
    expect(new Set(snapshot.nodes.map((entry) => entry.class)).size).toBe(4);
  });
});
