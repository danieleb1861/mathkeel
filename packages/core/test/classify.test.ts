import { describe, expect, it } from "vitest";
import { classify, type ClassifyAnchor, type ClassifyContract, type ClassifyInput } from "../src/classify.js";
import type { VerdictValue } from "../src/types.js";

const FRESH_DOC: ClassifyAnchor = { kind: "doc", state: "fresh" };
const FRESH_CODE: ClassifyAnchor = { kind: "code", state: "fresh" };
const FAIL: ClassifyContract = { id: "c", state: "fail" };
const PASS: ClassifyContract = { id: "c", state: "pass" };
const NOT_RUN: ClassifyContract = { id: "c", state: "not_run" };

function input(id: string, anchors: ClassifyAnchor[], contracts: ClassifyContract[], verdict?: VerdictValue): ClassifyInput {
  return verdict === undefined ? { id, anchors, contracts } : { id, anchors, contracts, verdict };
}

function classOf(nodes: ClassifyInput[], id: string): string | undefined {
  return classify(nodes).get(id)?.class;
}

describe("rule 1: alert", () => {
  it("alerts when a contract failed and every doc anchor is fresh", () => {
    expect(classOf([input("a", [FRESH_DOC, FRESH_CODE], [FAIL])], "a")).toBe("alert");
  });

  it("alerts when a code anchor changed and the doc did not move", () => {
    expect(classOf([input("a", [FRESH_DOC, { kind: "code", state: "queue" }], [FAIL])], "a")).toBe("alert");
  });

  it("alerts when the node has no doc anchor at all", () => {
    expect(classOf([input("a", [FRESH_CODE], [FAIL])], "a")).toBe("alert");
  });

  it("alerts all sharers of a failed contract when no sharer moved its doc", () => {
    const nodes = [input("a", [FRESH_DOC], [FAIL]), input("b", [FRESH_DOC], [FAIL])];
    expect(classOf(nodes, "a")).toBe("alert");
    expect(classOf(nodes, "b")).toBe("alert");
  });

  it("alerts when one failed contract is unexplained although another is explained", () => {
    const explained: ClassifyContract = { id: "x", state: "fail" };
    const unexplained: ClassifyContract = { id: "y", state: "fail" };
    const nodes = [
      input("a", [FRESH_DOC], [explained, unexplained]),
      input("b", [{ kind: "doc", state: "queue" }], [explained]),
    ];
    expect(classOf(nodes, "a")).toBe("alert");
  });

  it("is not moved by a sharer whose non-fresh anchor is code, not doc", () => {
    const nodes = [input("a", [FRESH_DOC], [FAIL]), input("b", [FRESH_DOC, { kind: "code", state: "queue" }], [FAIL])];
    expect(classOf(nodes, "a")).toBe("alert");
  });

  it("is not moved by a moved doc on a node that does not share the contract", () => {
    const nodes = [
      input("a", [FRESH_DOC], [FAIL]),
      input("other", [{ kind: "doc", state: "queue" }], [{ id: "d", state: "pass" }]),
    ];
    expect(classOf(nodes, "a")).toBe("alert");
  });
});

describe("rule 2: queue when the documentation moved with the code", () => {
  it("queues when the shared contract failed and the doc moved on another node", () => {
    const nodes = [input("a", [FRESH_DOC, FRESH_CODE], [FAIL]), input("b", [{ kind: "doc", state: "queue" }], [FAIL])];
    expect(classOf(nodes, "a")).toBe("queue");
    expect(classOf(nodes, "b")).toBe("queue");
    expect(classify(nodes).get("a")?.reasons.join()).toContain("the documentation moved with the code on b");
  });

  it("queues when the doc moved on the node itself", () => {
    expect(classOf([input("a", [{ kind: "doc", state: "queue" }], [FAIL])], "a")).toBe("queue");
  });

  it("counts a lost doc anchor as non-fresh", () => {
    const nodes = [input("a", [FRESH_DOC], [FAIL]), input("b", [{ kind: "doc", state: "lost" }], [FAIL])];
    expect(classOf(nodes, "a")).toBe("queue");
  });
});

describe("rule 3: anchors alone never alert", () => {
  it.each(["queue", "lost"] as const)("queues a %s doc anchor with a passing contract", (state) => {
    expect(classOf([input("a", [{ kind: "doc", state }], [PASS])], "a")).toBe("queue");
  });

  it.each(["queue", "lost"] as const)("queues a %s code anchor with no contract", (state) => {
    expect(classOf([input("a", [FRESH_DOC, { kind: "code", state }], [])], "a")).toBe("queue");
  });

  it("never alerts on anchors whatever their state", () => {
    const nodes = [
      input("a", [{ kind: "doc", state: "lost" }, { kind: "code", state: "lost" }], []),
      input("b", [{ kind: "code", state: "queue" }], [PASS]),
    ];
    for (const outcome of classify(nodes).values()) expect(outcome.class).toBe("queue");
  });
});

describe("rule 4: fresh", () => {
  it("is fresh with fresh anchors and a passing contract", () => {
    expect(classOf([input("a", [FRESH_DOC, FRESH_CODE], [PASS])], "a")).toBe("fresh");
    expect(classify([input("a", [FRESH_DOC], [PASS])]).get("a")?.reasons).toEqual([]);
  });

  it("is fresh with no anchors and no contracts", () => {
    expect(classOf([input("a", [], [])], "a")).toBe("fresh");
  });
});

describe("status runs no contract", () => {
  it("can only produce fresh or queue", () => {
    const anchorSets: ClassifyAnchor[][] = [
      [FRESH_DOC],
      [{ kind: "doc", state: "queue" }],
      [{ kind: "doc", state: "lost" }],
      [{ kind: "code", state: "queue" }],
    ];
    const verdicts: (VerdictValue | undefined)[] = [undefined, "legitimate", "error", "uncertain"];
    for (const anchors of anchorSets) {
      for (const verdict of verdicts) {
        const outcome = classOf([input("a", anchors, [NOT_RUN], verdict)], "a");
        expect(["fresh", "queue"]).toContain(outcome);
      }
    }
  });
});

describe("judge verdicts", () => {
  it("moves a legitimate alert to review", () => {
    expect(classOf([input("a", [FRESH_DOC], [FAIL], "legitimate")], "a")).toBe("review");
  });

  it.each(["error", "uncertain"] as const)("leaves an %s verdict as alert", (verdict) => {
    expect(classOf([input("a", [FRESH_DOC], [FAIL], verdict)], "a")).toBe("alert");
  });

  it("does nothing on a node that is not an alert", () => {
    expect(classOf([input("a", [FRESH_DOC], [PASS], "legitimate")], "a")).toBe("fresh");
    expect(classOf([input("a", [{ kind: "code", state: "queue" }], [PASS], "legitimate")], "a")).toBe("queue");
    expect(classOf([input("a", [{ kind: "doc", state: "queue" }], [FAIL], "legitimate")], "a")).toBe("queue");
  });
});
