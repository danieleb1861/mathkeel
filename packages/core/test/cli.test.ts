import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decode, encode } from "@toon-format/toon";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { JudgePack } from "../src/judge.js";
import { loadMap } from "../src/mapio.js";
import type { Anchor, Snapshot } from "../src/types.js";
import {
  CLI,
  commitAll,
  contract,
  FAILING,
  frozenRepo,
  git,
  letEventLoopRun,
  makeRepo,
  node,
  PASSING,
  removeRepos,
  runCli,
  writeFiles,
} from "./helpers.js";

afterAll(removeRepos);
afterEach(letEventLoopRun);

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js is missing: run npm test, which builds first");
});

const README = "# Doc\n\nThe rate is twice the input.\n\nThe gain is three.\n";
const PY = "def rate(x):\n    return x * 2\n\n\ndef gain(x):\n    return x * 3\n";

const docAnchor = (quote: string): Anchor => ({ path: "README.md", symbol: null, quote, hash: null });
const codeAnchor = (symbol: string): Anchor => ({ path: "src/m.py", symbol, quote: "", hash: null });

/** A contract that compares the code with its specification by reading a value file. */
const CHECKS_VALUE = "process.exit(require('fs').readFileSync('value.txt','utf8').trim()==='ok'?0:1)";

async function twoNodeRepo(script = PASSING): Promise<string> {
  return frozenRepo(
    { "README.md": README, "src/m.py": PY },
    [
      node({ id: "rate", doc: docAnchor("The rate is twice"), code: [codeAnchor("rate")], contracts: ["c"] }),
      node({
        id: "gain",
        doc: docAnchor("The gain is three"),
        code: [codeAnchor("gain")],
        contracts: ["c"],
        depends_on: ["rate"],
      }),
    ],
    [contract("c", script)],
  );
}

function statusJson(root: string): Snapshot {
  return JSON.parse(runCli(root, "status", "--json").stdout) as Snapshot;
}

function checkJson(root: string): { code: number; snapshot: Snapshot } {
  const result = runCli(root, "check", "--yes", "--json");
  return { code: result.code, snapshot: JSON.parse(result.stdout) as Snapshot };
}

const classOf = (s: Snapshot, id: string): string | undefined => s.nodes.find((n) => n.id === id)?.class;

describe("exit codes", () => {
  it("gives 2 for usage errors", async () => {
    const root = await twoNodeRepo();
    expect(runCli(root).code).toBe(2);
    expect(runCli(root, "nonsense").code).toBe(2);
    expect(runCli(root, "status", "--bad").code).toBe(2);
    expect(runCli(root, "status", "extra").code).toBe(2);
    expect(runCli(root, "map").code).toBe(2);
    expect(runCli(root, "map", "other").code).toBe(2);
    expect(runCli(root, "impact").code).toBe(2);
    expect(runCli(root, "trace").code).toBe(2);
    expect(runCli(root, "trace", "unknown").code).toBe(2);
    expect(runCli(root, "judge").code).toBe(2);
    expect(runCli(root, "accept", "rate").code).toBe(2);
    expect(runCli(root, "accept", "unknown", "--reason", "x").code).toBe(2);
    expect(runCli(root, "accept", "rate", "--reason", "   ").code).toBe(2);
    expect(runCli(root, "export").code).toBe(2);
    expect(runCli(root, "serve", "--port", "nope").code).toBe(2);
  });

  it("gives 2 outside a git repository", () => {
    const result = runCli(mkdtempSync(path.join(tmpdir(), "mathkeel-nogit-")), "status");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("git repository");
  });

  it("gives 2 with a broken or missing map", () => {
    const root = makeRepo({ "a.txt": "x\n" });
    expect(runCli(root, "status").code).toBe(2);
    writeFiles(root, { ".mathkeel/map.json": "{ not json" });
    expect(runCli(root, "status").code).toBe(2);
    expect(runCli(root, "map", "lint").code).toBe(2);
    writeFiles(root, { ".mathkeel/map.json": '{"nodes":[{"id":"a"}]}' });
    expect(runCli(root, "status").code).toBe(2);
  });

  it("gives 0 on a clean check and 1 on an alert", async () => {
    const clean = await twoNodeRepo();
    expect(runCli(clean, "check", "--yes").code).toBe(0);
    const failing = await twoNodeRepo(FAILING);
    expect(runCli(failing, "check", "--yes").code).toBe(1);
  });
});

describe("init", () => {
  it("creates the layout, keeps state ignored, and is idempotent", () => {
    const root = makeRepo({ "a.txt": "x\n" });
    expect(runCli(root, "init").code).toBe(0);
    for (const rel of ["map.toon", "decisions.jsonl", "contracts", "state"]) {
      expect(existsSync(path.join(root, ".mathkeel", rel))).toBe(true);
    }
    writeFiles(root, { ".mathkeel/state/x.json": "{}" });
    git(root, "add", "-A");
    expect(git(root, "status", "--porcelain")).not.toContain("state/");
    const before = readFileSync(path.join(root, ".mathkeel", "map.toon"), "utf8");
    expect(runCli(root, "init").stdout).toContain("already initialised");
    expect(readFileSync(path.join(root, ".mathkeel", "map.toon"), "utf8")).toBe(before);
  });
});

describe("status", () => {
  it("reports fresh on an untouched repository, with not_run contracts", async () => {
    const root = await twoNodeRepo(FAILING);
    const s = statusJson(root);
    expect(s.schema).toBe(1);
    expect(s.contractsRun).toBe(false);
    expect(s.summary).toMatchObject({ fresh: 2, queue: 0, alert: 0, review: 0 });
    expect(s.nodes[0]?.contractResults).toEqual([{ id: "c", state: "not_run", msg: "" }]);
    expect(runCli(root, "status").code).toBe(0);
  });

  it("never alerts: a failing contract is not run", async () => {
    const root = await twoNodeRepo(FAILING);
    runCli(root, "check", "--yes");
    writeFiles(root, { "src/m.py": PY.replace("x * 2", "x * 5") });
    const s = statusJson(root);
    expect(s.summary.alert).toBe(0);
    expect(classOf(s, "rate")).toBe("queue");
  });

  it("gives before and after, line numbers and repo-relative paths", async () => {
    const root = await twoNodeRepo();
    writeFiles(root, { "src/m.py": `\n${PY.replace("x * 2", "x * 5")}` });
    const anchor = statusJson(root).nodes[0]?.anchors[1];
    expect(anchor).toMatchObject({
      kind: "code",
      path: "src/m.py",
      symbol: "rate",
      state: "queue",
      line: 2,
      before: "return x * 2",
      after: "return x * 5",
    });
  });

  it("uses forward slashes and no absolute path anywhere in its output", async () => {
    const root = await twoNodeRepo();
    writeFiles(root, { "src/sub/new.py": "def z():\n    pass\n", "src/m.py": PY.replace("x * 2", "x * 5") });
    const text = runCli(root, "status", "--json").stdout;
    expect(text).not.toContain(root);
    expect(text).not.toContain(root.replace(/\\/g, "/"));
    expect(text).not.toContain("\\\\");
    expect(statusJson(root).uncharted[0]?.path).toBe("src/sub/new.py");
  });

  it("propagates change as upstream_changed, neither queue nor alert", async () => {
    const root = await twoNodeRepo();
    writeFiles(root, { "src/m.py": PY.replace("x * 2", "x * 5") });
    const s = statusJson(root);
    expect(classOf(s, "gain")).toBe("fresh");
    expect(s.nodes.find((n) => n.id === "gain")?.upstreamChanged).toEqual(["rate"]);
    expect(s.summary).toMatchObject({ fresh: 1, queue: 1, alert: 0 });
  });

  it("never turns gaps or uncharted files into alerts", async () => {
    const root = await twoNodeRepo();
    writeFiles(root, { "src/m.py": `${PY}\n\ndef extra(q):\n    return q\n`, "src/other.py": "def o():\n    pass\n" });
    const s = checkJson(root).snapshot;
    expect(s.summary.gaps).toBe(2);
    expect(s.summary.unchartedShare).toBeGreaterThan(0);
    expect(s.summary).toMatchObject({ alert: 0, queue: 0, fresh: 2 });
    expect(runCli(root, "check", "--yes").code).toBe(0);
  });

  it("reports activity on the nodes a file touches", async () => {
    const root = await twoNodeRepo();
    writeFiles(root, { "src/m.py": PY.replace("x * 2", "x * 5") });
    commitAll(root);
    const row = statusJson(root).activity.find((a) => a.path === "src/m.py");
    expect(row?.touches).toEqual(["rate", "gain"]);
    expect(Number.isNaN(Date.parse(row?.changedAt ?? ""))).toBe(false);
  });

  it("reports a renamed file once, under its new path", async () => {
    const root = await twoNodeRepo();
    writeFiles(root, { "src/extra.py": "def e():\n    pass\n" });
    commitAll(root);
    git(root, "mv", "src/extra.py", "src/moved.py");
    const paths = statusJson(root).activity.map((a) => a.path);
    expect(paths).toContain("src/moved.py");
    expect(paths.filter((p) => p.includes("xtra.py") && p !== "src/extra.py")).toEqual([]);
  });

  it("marks a dirty repository", async () => {
    const root = await twoNodeRepo();
    expect(statusJson(root).repo.dirty).toBe(false);
    writeFiles(root, { "src/m.py": `${PY}# x\n` });
    expect(statusJson(root).repo.dirty).toBe(true);
  });
});

describe("check", () => {
  it("alerts on a mutated contract failure and queues when the doc moved too", async () => {
    const root = await frozenRepo(
      { "README.md": README, "src/m.py": PY, "value.txt": "ok\n" },
      [
        node({ id: "rate", doc: docAnchor("The rate is twice"), code: [codeAnchor("rate")], contracts: ["v"] }),
        node({ id: "gain", doc: docAnchor("The gain is three"), code: [codeAnchor("gain")], contracts: ["v"] }),
      ],
      [contract("v", CHECKS_VALUE)],
    );
    expect(checkJson(root).code).toBe(0);

    writeFiles(root, { "value.txt": "bad\n", "src/m.py": PY.replace("x * 2", "x * 5") });
    const silent = checkJson(root);
    expect(silent.code).toBe(1);
    expect(classOf(silent.snapshot, "rate")).toBe("alert");
    expect(classOf(silent.snapshot, "gain")).toBe("alert");

    writeFiles(root, { "README.md": README.replace("is three.", "is three, as revised.") });
    const moved = checkJson(root);
    expect(moved.code).toBe(0);
    expect(classOf(moved.snapshot, "rate")).toBe("queue");
    expect(classOf(moved.snapshot, "gain")).toBe("queue");
    expect(moved.snapshot.nodes[0]?.reasons.join()).toContain("moved with the code on gain");
  });
});

describe("judge and accept", () => {
  async function alerted(): Promise<string> {
    const root = await frozenRepo(
      { "README.md": README, "src/m.py": PY },
      [
        node({ id: "rate", doc: docAnchor("The rate is twice"), code: [codeAnchor("rate")], contracts: ["c"] }),
        node({ id: "gain", doc: docAnchor("The gain is three"), code: [codeAnchor("gain")], contracts: ["d"] }),
      ],
      [contract("c", FAILING), contract("d", FAILING)],
    );
    writeFiles(root, { "src/m.py": PY.replace("x * 2", "x * 5") });
    expect(runCli(root, "check", "--yes").code).toBe(1);
    return root;
  }

  const judgeDir = (root: string): string => path.join(root, ".mathkeel", "state", "judge");

  function writeVerdicts(root: string, verdicts: unknown): void {
    writeFileSync(path.join(judgeDir(root), "verdicts.json"), JSON.stringify(verdicts));
  }

  it("refuses to pack before a current check", async () => {
    const root = await twoNodeRepo();
    expect(runCli(root, "judge", "pack").code).toBe(2);
  });

  it("packs one file per alert, with diff, contracts and doc, and no earlier verdict", async () => {
    const root = await alerted();
    expect(runCli(root, "judge", "pack").code).toBe(1);
    expect(readdirSync(judgeDir(root)).sort()).toEqual(["A001.toon", "A002.toon"]);
    const pack = decode(readFileSync(path.join(judgeDir(root), "A001.toon"), "utf8")) as unknown as JudgePack;
    expect(pack.node).toBe("rate");
    expect(pack.diff).toContain("-    return x * 2");
    expect(pack.diff).toContain("+    return x * 5");
    expect(pack.failedContracts).toEqual([{ id: "c", msg: "mismatch" }]);
    expect(pack.doc).toEqual({ path: "README.md", text: "The rate is twice the input." });
    expect(JSON.stringify(pack).toLowerCase()).not.toContain("verdict");

    writeVerdicts(root, [{ id: "A001", verdict: "error", confidence: 0.9, reason: "wrong" }]);
    expect(runCli(root, "judge", "apply").code).toBe(1);
    runCli(root, "judge", "pack");
    const again = readFileSync(path.join(judgeDir(root), "A001.toon"), "utf8");
    expect(again).not.toContain("wrong");
    expect(readdirSync(judgeDir(root))).not.toContain("verdicts.json");
  });

  it("applies verdicts.toon, keeping hostile text intact", async () => {
    const root = await alerted();
    runCli(root, "judge", "pack");
    const reason = 'x: "y", - [2]: a\nsecond line';
    const verdicts = [
      { id: "A001", verdict: "legitimate", confidence: 0.5, reason },
      { id: "A002", verdict: "error", confidence: 1, reason: "plain" },
    ];
    writeFileSync(path.join(judgeDir(root), "verdicts.toon"), encode(verdicts));
    expect(runCli(root, "judge", "apply").stdout).toContain("proposed legitimate");
    const rate = checkJson(root).snapshot.nodes.find((n) => n.id === "rate");
    expect(rate?.verdict?.reason).toBe(reason);
    writeFileSync(path.join(judgeDir(root), "verdicts.toon"), "verdicts[3]{id}:\n  A001\n");
    expect(runCli(root, "judge", "apply").code).toBe(2);
    runCli(root, "judge", "pack");
    expect(readdirSync(judgeDir(root))).not.toContain("verdicts.toon");
  });

  it("moves legitimate to review and leaves error and uncertain as alert", async () => {
    const root = await alerted();
    runCli(root, "judge", "pack");
    writeVerdicts(root, [
      { id: "A001", verdict: "legitimate", confidence: 0.8, reason: "intended" },
      { id: "A002", verdict: "error", confidence: 0.7, reason: "a bug" },
    ]);
    expect(runCli(root, "judge", "apply").code).toBe(1);
    const { snapshot } = checkJson(root);
    expect(classOf(snapshot, "rate")).toBe("review");
    expect(classOf(snapshot, "gain")).toBe("alert");
    expect(snapshot.nodes[0]?.verdict).toEqual({ verdict: "legitimate", confidence: 0.8, reason: "intended" });
    expect(snapshot.summary).toMatchObject({ alert: 1, review: 1 });
  });

  it("keeps uncertain as alert", async () => {
    const root = await alerted();
    runCli(root, "judge", "pack");
    writeVerdicts(root, [{ id: "A001", verdict: "uncertain", confidence: 0.5, reason: "unclear" }]);
    runCli(root, "judge", "apply");
    expect(classOf(checkJson(root).snapshot, "rate")).toBe("alert");
  });

  it("does not let a verdict rebaseline, record a decision or turn the check green", async () => {
    const root = await alerted();
    runCli(root, "judge", "pack");
    writeVerdicts(root, [
      { id: "A001", verdict: "legitimate", confidence: 1, reason: "x" },
      { id: "A002", verdict: "legitimate", confidence: 1, reason: "x" },
    ]);
    const before = readFileSync(path.join(root, ".mathkeel", "map.toon"), "utf8");
    expect(runCli(root, "judge", "apply").code).toBe(1);
    expect(readFileSync(path.join(root, ".mathkeel", "map.toon"), "utf8")).toBe(before);
    expect(readFileSync(path.join(root, ".mathkeel", "decisions.jsonl"), "utf8")).toBe("");
    expect(runCli(root, "check", "--yes").code).toBe(1);
  });

  it("voids a verdict when the node changes again", async () => {
    const root = await alerted();
    runCli(root, "judge", "pack");
    writeVerdicts(root, [{ id: "A001", verdict: "legitimate", confidence: 1, reason: "x" }]);
    runCli(root, "judge", "apply");
    writeFiles(root, { "src/m.py": PY.replace("x * 2", "x * 9") });
    const { snapshot } = checkJson(root);
    expect(classOf(snapshot, "rate")).toBe("alert");
    expect(snapshot.nodes[0]?.verdict).toBeNull();
  });

  it("skips a verdict for an unknown or path-like id and a stale pack", async () => {
    const root = await alerted();
    runCli(root, "judge", "pack");
    writeVerdicts(root, [
      { id: "../../map", verdict: "legitimate", confidence: 1, reason: "x" },
      { id: "A999", verdict: "legitimate", confidence: 1, reason: "x" },
    ]);
    const quiet = runCli(root, "judge", "apply");
    expect(quiet.stdout).toContain("no such pack");
    writeVerdicts(root, [{ id: "A001", verdict: "legitimate", confidence: 1, reason: "x" }]);
    writeFiles(root, { "src/m.py": PY.replace("x * 2", "x * 9") });
    runCli(root, "check", "--yes");
    expect(runCli(root, "judge", "apply").stdout).toContain("changed since the pack");
  });

  it("rejects a malformed verdicts file", async () => {
    const root = await alerted();
    runCli(root, "judge", "pack");
    writeVerdicts(root, [{ id: "A001", verdict: "proved", confidence: 1, reason: "x" }]);
    expect(runCli(root, "judge", "apply").code).toBe(2);
    writeVerdicts(root, [{ id: "A001", verdict: "error", confidence: 7, reason: "x" }]);
    expect(runCli(root, "judge", "apply").code).toBe(2);
    expect(runCli(makeRepo({ "a.txt": "x\n" }), "judge", "apply").code).toBe(2);
  });

  it("accept rebaselines, appends a decision with person, time and commit, and clears the verdict", async () => {
    const root = await alerted();
    runCli(root, "judge", "pack");
    writeVerdicts(root, [{ id: "A001", verdict: "legitimate", confidence: 1, reason: "x" }]);
    runCli(root, "judge", "apply");
    const head = git(root, "rev-parse", "HEAD").trim();
    expect(runCli(root, "accept", "rate", "--reason", "the factor was revised").code).toBe(0);

    const lines = readFileSync(path.join(root, ".mathkeel", "decisions.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const decision = JSON.parse(lines[0] as string) as Record<string, string>;
    expect(decision).toMatchObject({ id: "rate", by: "Test Person", reason: "the factor was revised", commit: head });
    expect(Number.isNaN(Date.parse(decision.at ?? ""))).toBe(false);

    const s = statusJson(root);
    expect(classOf(s, "rate")).toBe("fresh");
    expect(s.decisions[0]).toMatchObject({ id: "rate", by: "Test Person" });
    expect(s.nodes[0]?.verdict).toBeNull();
  });

  it("appends and never rewrites decisions", async () => {
    const root = await twoNodeRepo();
    runCli(root, "accept", "rate", "--reason", "one");
    const first = readFileSync(path.join(root, ".mathkeel", "decisions.jsonl"), "utf8");
    runCli(root, "accept", "rate", "--reason", "two");
    const second = readFileSync(path.join(root, ".mathkeel", "decisions.jsonl"), "utf8");
    expect(second.startsWith(first)).toBe(true);
    expect(second.trim().split("\n")).toHaveLength(2);
  });

  it("keeps the contract failing after accept: accept rebaselines hashes only", async () => {
    const root = await alerted();
    runCli(root, "accept", "rate", "--reason", "revised");
    expect(classOf(checkJson(root).snapshot, "rate")).toBe("alert");
  });

  it("refuses to accept a lost anchor until the map is repaired", async () => {
    const root = await twoNodeRepo();
    writeFiles(root, { "src/m.py": PY.replace("def rate", "def renamed") });
    const result = runCli(root, "accept", "rate", "--reason", "x");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("symbol gone");
    expect(readFileSync(path.join(root, ".mathkeel", "decisions.jsonl"), "utf8")).toBe("");
  });

  it("refuses to accept without a person", async () => {
    const root = await twoNodeRepo();
    git(root, "config", "user.name", "");
    git(root, "config", "user.email", "");
    const home = path.join(root, "no-home");
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, [CLI, "accept", "rate", "--reason", "x"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    expect(result.status).toBe(2);
  });
});

describe("impact and trace", () => {
  async function chained(): Promise<string> {
    return frozenRepo(
      { "README.md": README, "src/m.py": PY, "tests/test_m.py": "def test_rate():\n    pass\n" },
      [
        node({ id: "a", kind: "assumption", doc: docAnchor("The rate is twice") }),
        node({ id: "e", kind: "equation", depends_on: ["a"], doc: docAnchor("The gain is three") }),
        node({ id: "c", kind: "code", depends_on: ["e"], code: [codeAnchor("rate")] }),
        node({ id: "t", kind: "test", depends_on: ["c"], verified_by: ["tests/test_m.py::test_rate"] }),
        node({ id: "other", kind: "code", code: [codeAnchor("gain")] }),
      ],
    );
  }

  it("finds what a file or symbol touches, and downstream", async () => {
    const root = await chained();
    const bySymbol = JSON.parse(runCli(root, "impact", "rate", "--json").stdout) as { direct: string[]; downstream: string[] };
    expect(bySymbol).toMatchObject({ direct: ["c"], downstream: ["t"] });
    const byFile = JSON.parse(runCli(root, "impact", "src/m.py", "--json").stdout) as { direct: string[]; downstream: string[] };
    expect(byFile.direct).toEqual(["c", "other"]);
    const byDoc = JSON.parse(runCli(root, "impact", "README.md", "--json").stdout) as { direct: string[]; downstream: string[] };
    expect(byDoc.direct).toEqual(["a", "e"]);
    expect(byDoc.downstream.sort()).toEqual(["c", "t"]);
    const none = JSON.parse(runCli(root, "impact", "nothing.py", "--json").stdout) as { direct: string[] };
    expect(none.direct).toEqual([]);
  });

  it("accepts a path with backslashes", async () => {
    const root = await chained();
    const result = JSON.parse(runCli(root, "impact", "src\\m.py", "--json").stdout) as { direct: string[] };
    expect(result.direct).toEqual(["c", "other"]);
  });

  it("traces assumption to equation to code to test", async () => {
    const root = await chained();
    const steps = JSON.parse(runCli(root, "trace", "e", "--json").stdout) as { stage: string; id: string; verifiedBy: string[] }[];
    expect(steps.map((s) => [s.stage, s.id])).toEqual([
      ["assumption", "a"],
      ["equation", "e"],
      ["code", "c"],
      ["test", "t"],
    ]);
    const text = runCli(root, "trace", "c").stdout;
    expect(text).toContain("verified_by tests/test_m.py::test_rate");
    expect(text).toContain("code src/m.py#rate");
  });
});

describe("toon", () => {
  it("gives the same data as --json", async () => {
    const root = await twoNodeRepo();
    const { generatedAt: _a, ...fromToon } = decode(runCli(root, "status", "--toon").stdout) as unknown as Snapshot;
    const { generatedAt: _b, ...fromJson } = statusJson(root);
    expect(fromToon).toEqual(fromJson);
    for (const args of [["impact", "src/m.py"], ["trace", "rate"]]) {
      const json: unknown = JSON.parse(runCli(root, ...args, "--json").stdout);
      expect(decode(runCli(root, ...args, "--toon").stdout)).toEqual(json);
    }
  });

  it("refuses --json with --toon before any contract runs", async () => {
    const root = await twoNodeRepo();
    const result = runCli(root, "check", "--yes", "--json", "--toon");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("choose one");
    expect(existsSync(path.join(root, ".mathkeel", "state", "last-check.json"))).toBe(false);
  });

  it("does not read a blank or cut map.toon as an empty map", () => {
    const root = makeRepo({ "a.txt": "x\n" });
    runCli(root, "init");
    expect(runCli(root, "status").code).toBe(0);
    for (const text of ["", "schema: 1\nchains: []\n"]) {
      writeFiles(root, { ".mathkeel/map.toon": text });
      const result = runCli(root, "status");
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("no nodes section");
    }
    writeFiles(root, { ".mathkeel/map.toon": "nodes[2]:\n  - id: a\n" });
    expect(runCli(root, "status").stderr).toContain("not valid TOON");
  });

  it("keeps an existing map.json as JSON and refuses two maps", async () => {
    const root = makeRepo({ "m.py": "def f():\n    return 1\n" });
    writeFiles(root, { ".mathkeel/map.json": '{"nodes":[]}' });
    expect(runCli(root, "map", "freeze").code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, ".mathkeel", "map.json"), "utf8"))).toHaveProperty("baseline");
    expect(existsSync(path.join(root, ".mathkeel", "map.toon"))).toBe(false);
    writeFiles(root, { ".mathkeel/map.toon": "nodes: []\n" });
    const result = runCli(root, "status");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("keep one");
  });
});

describe("export", () => {
  it("writes one offline HTML file", async () => {
    const root = await twoNodeRepo();
    expect(runCli(root, "export", "out/report.html").code).toBe(0);
    const html = readFileSync(path.join(root, "out", "report.html"), "utf8");
    expect(html).toContain("rate");
    expect(html.startsWith("<!doctype html>") || html.includes("<html")).toBe(true);
  });

  it("shows the last check when the tree has not moved, and not otherwise", async () => {
    const root = await twoNodeRepo(FAILING);
    runCli(root, "check", "--yes");
    runCli(root, "export", "a.html");
    const shown = readFileSync(path.join(root, "a.html"), "utf8");
    expect(shown).toMatch(/alert/);
    expect(shown).toMatch(/"class":"alert"|<td>alert<\/td>/);

    writeFiles(root, { "src/m.py": PY.replace("x * 2", "x * 5") });
    runCli(root, "export", "b.html");
    const stale = readFileSync(path.join(root, "b.html"), "utf8");
    expect(stale).not.toMatch(/"class":"alert"|<td>alert<\/td>/);
  });
});

describe("repository text is data", () => {
  it("keeps a map that survives every step of the pipeline", async () => {
    const root = await twoNodeRepo();
    expect(runCli(root, "map", "lint").stdout).toContain("map ok");
    expect(loadMap(root).nodes).toHaveLength(2);
    expect(loadMap(root).baseline).toMatch(/^[0-9a-f]{40}$/);
  });
});
