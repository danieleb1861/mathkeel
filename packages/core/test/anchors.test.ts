import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAnchor, Workspace, type AnchorKind } from "../src/anchors.js";
import { computeGaps, computeUncharted, currentInventory } from "../src/census.js";
import { freezeMap, initRepo, lintMap, linkIssues, loadMap, lockPath, mapPath, mapWarnings, writeMap } from "../src/mapio.js";
import { hashText } from "../src/normalise.js";
import { RepoFiles } from "../src/repo.js";
import { changedLines } from "../src/snapshot.js";
import type { Anchor, MapFile } from "../src/types.js";
import { commitAll, makeRepo, node, removeRepos, writeFiles } from "./helpers.js";

afterAll(removeRepos);

const anchor = (path: string, symbol: string | null, quote: string, hash: string | null = null): Anchor => ({
  path,
  symbol,
  quote,
  hash,
});

async function resolve(root: string, kind: AnchorKind, a: Anchor) {
  const ws = new Workspace(new RepoFiles(root));
  try {
    return await resolveAnchor(ws, kind, a);
  } finally {
    await ws.dispose();
  }
}

/** Hash now, then the same anchor after `change`. */
async function afterChange(
  files: Record<string, string>,
  kind: AnchorKind,
  a: Anchor,
  change: Record<string, string>,
) {
  const root = makeRepo(files);
  const first = await resolve(root, kind, a);
  writeFiles(root, change);
  return resolve(root, kind, { ...a, hash: first.hash });
}

const README = "# Title\n\nThe variance is $\\sigma^2$ with lag one.\nIt uses Bartlett weights.\n\nAnother paragraph.\n";
const PY = 'def f(a):\n    """Returns twice a."""\n    return a * 2\n';

describe("code anchors", () => {
  const code = anchor("src/m.py", "f", "return a * 2");

  it("is fresh when only formatting, comments and names changed", async () => {
    const changed = 'def f(x):\n    """Returns twice a."""\n    # note\n    return x*2\n';
    expect((await afterChange({ "src/m.py": PY }, "code", code, { "src/m.py": changed })).state).toBe("fresh");
  });

  it("queues a real change", async () => {
    const changed = PY.replace("a * 2", "a * 3");
    const result = await afterChange({ "src/m.py": PY }, "code", code, { "src/m.py": changed });
    expect(result.state).toBe("queue");
    expect(result.text).toContain("a * 3");
  });

  it("stays fresh when the symbol moved within the file", async () => {
    const moved = `import os\n\n\ndef g():\n    pass\n\n\n${PY}`;
    const result = await afterChange({ "src/m.py": PY }, "code", code, { "src/m.py": moved });
    expect(result.state).toBe("fresh");
    expect(result.line).toBe(8);
  });

  it("is lost when the symbol is gone", async () => {
    const renamed = PY.replace("def f", "def g");
    expect((await afterChange({ "src/m.py": PY }, "code", code, { "src/m.py": renamed })).state).toBe("lost");
  });

  it("is lost when the file is gone", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    expect((await resolve(root, "code", code)).state).toBe("lost");
  });

  it("anchors by quote when there is no symbol, on the enclosing definition", async () => {
    const byQuote = anchor("src/m.py", null, "return a * 2");
    const first = await resolve(makeRepo({ "src/m.py": PY }), "code", byQuote);
    expect(first.state).toBe("queue");
    expect(first.text).toContain("def f");
    const fresh = await afterChange({ "src/m.py": PY }, "code", byQuote, { "src/m.py": PY.replace("Returns", "Gives") });
    expect(fresh.state).toBe("fresh");
  });

  it("is lost when the quote of a symbol-less anchor is gone", async () => {
    const byQuote = anchor("src/m.py", null, "return a * 2");
    const gone = PY.replace("a * 2", "a * 3");
    expect((await afterChange({ "src/m.py": PY }, "code", byQuote, { "src/m.py": gone })).state).toBe("lost");
  });

  it("finds spans after non-ASCII text", async () => {
    const text = "# \u00e9\u00fc \u4e2d\u6587 \u{1F600}\nX = '\u00e9'\n\n\ndef f(a):\n    return a * 2\n";
    const byQuote = await resolve(makeRepo({ "m.py": text }), "code", anchor("m.py", null, "return a * 2"));
    expect(byQuote.text).toBe("def f(a):\n    return a * 2");
    expect(byQuote.line).toBe(5);
    const bySymbol = await resolve(makeRepo({ "m.py": text }), "code", anchor("m.py", "f", ""));
    expect(bySymbol.hash).toBe(byQuote.hash);
  });

  it("resolves a Rust symbol", async () => {
    const source = "pub fn f(a: f64) -> f64 {\n    a * 2.0\n}\n";
    const rust = anchor("src/m.rs", "f", "a * 2.0");
    const reformatted = await afterChange({ "src/m.rs": source }, "code", rust, {
      "src/m.rs": "pub fn f(b: f64) -> f64 { b * 2.0 }\n",
    });
    expect(reformatted.state).toBe("fresh");
    const changed = await afterChange({ "src/m.rs": source }, "code", rust, {
      "src/m.rs": source.replace("2.0", "3.0"),
    });
    expect(changed.state).toBe("queue");
  });

  it("hashes a CRLF checkout the same as LF", async () => {
    const lf = await resolve(makeRepo({ "src/m.py": PY }), "code", code);
    const crlf = await resolve(makeRepo({ "src/m.py": PY.replace(/\n/g, "\r\n") }), "code", code);
    expect(crlf.hash).toBe(lf.hash);
    const rustLf = "fn f() {\n    1;\n}\n";
    const rust = anchor("m.rs", "f", "");
    const a = await resolve(makeRepo({ "m.rs": rustLf }), "code", rust);
    const b = await resolve(makeRepo({ "m.rs": rustLf.replace(/\n/g, "\r\n") }), "code", rust);
    expect(b.hash).toBe(a.hash);
  });
});

describe("doc anchors", () => {
  const doc = anchor("README.md", null, "The variance is $\\sigma^2$");

  it("hashes the paragraph around the quote", async () => {
    const result = await resolve(makeRepo({ "README.md": README }), "doc", doc);
    expect(result.text).toBe("The variance is $\\sigma^2$ with lag one.\nIt uses Bartlett weights.");
    expect(result.line).toBe(3);
  });

  it("is fresh after a reflow of the paragraph", async () => {
    const reflowed = README.replace("with lag one.\nIt uses", "with lag one. It uses");
    expect((await afterChange({ "README.md": README }, "doc", doc, { "README.md": reflowed })).state).toBe("fresh");
  });

  it("is fresh when the paragraph moved", async () => {
    const moved = README.replace("# Title\n", "# Title\n\nNew intro.\n");
    const result = await afterChange({ "README.md": README }, "doc", doc, { "README.md": moved });
    expect(result.state).toBe("fresh");
    expect(result.line).toBe(5);
  });

  it("queues when the quote is present but its paragraph changed", async () => {
    const changed = README.replace("Bartlett", "Parzen");
    const result = await afterChange({ "README.md": README }, "doc", doc, { "README.md": changed });
    expect(result.state).toBe("queue");
    expect(result.text).toContain("Parzen");
  });

  it("is lost when the quote is gone", async () => {
    const changed = README.replace("The variance is", "The dispersion is");
    expect((await afterChange({ "README.md": README }, "doc", doc, { "README.md": changed })).state).toBe("lost");
  });

  it("matches a quote across a line break", async () => {
    const wrapped = anchor("README.md", null, "with lag one. It uses");
    expect((await resolve(makeRepo({ "README.md": README }), "doc", wrapped)).line).toBe(3);
  });

  it("keeps display maths with a blank line in one span", async () => {
    const text = "Intro.\n\n$$\na\n\nb\n$$\n\nEnd.\n";
    const result = await resolve(makeRepo({ "d.md": text }), "doc", anchor("d.md", null, "a"));
    expect(result.text).toBe("$$\na\n\nb\n$$");
  });

  it("uses a Markdown heading as a symbol", async () => {
    const text = "# A\n\none\n\n## B\n\ntwo\n\n## C\n\nthree\n";
    const b = await resolve(makeRepo({ "d.md": text }), "doc", anchor("d.md", "B", ""));
    expect(b.text).toBe("## B\n\ntwo");
  });

  it("uses a LaTeX label as a symbol and ignores comments", async () => {
    const tex = "Text.\n\n\\begin{equation}\\label{eq:v}\n  v = 1\n\\end{equation}\n\nEnd.\n";
    const a = anchor("p.tex", "eq:v", "");
    const result = await afterChange({ "p.tex": tex }, "doc", a, { "p.tex": tex.replace("v = 1", "v = 1 % note") });
    expect(result.state).toBe("fresh");
    const changed = await afterChange({ "p.tex": tex }, "doc", a, { "p.tex": tex.replace("v = 1", "v = 2") });
    expect(changed.state).toBe("queue");
  });

  it("anchors a Python docstring with its own text hash", async () => {
    const a = anchor("m.py", "f", "Returns twice a.");
    const result = await resolve(makeRepo({ "m.py": PY }), "doc", a);
    expect(result.hash).toBe(hashText("Returns twice a."));
    const codeOnly = await afterChange({ "m.py": PY }, "doc", a, { "m.py": PY.replace("a * 2", "a * 3") });
    expect(codeOnly.state).toBe("fresh");
    const docEdit = await afterChange({ "m.py": PY }, "doc", a, { "m.py": PY.replace("twice", "thrice") });
    expect(docEdit.state).toBe("queue");
  });

  it("anchors a Rust doc comment", async () => {
    const source = "/// Returns twice a.\n/// Always.\npub fn f(a: f64) -> f64 { a * 2.0 }\n";
    const a = anchor("m.rs", "f", "Returns twice a.");
    const result = await resolve(makeRepo({ "m.rs": source }), "doc", a);
    expect(result.text).toBe("Returns twice a.\nAlways.");
    expect(result.line).toBe(1);
    const changed = await afterChange({ "m.rs": source }, "doc", a, { "m.rs": source.replace("Always", "Never") });
    expect(changed.state).toBe("queue");
  });

  it("finds a docstring by quote when no symbol is given", async () => {
    const result = await resolve(makeRepo({ "m.py": PY }), "doc", anchor("m.py", null, "twice a"));
    expect(result.text).toBe("Returns twice a.");
  });
});

describe("before and after", () => {
  it("keeps only the lines that differ", () => {
    expect(changedLines("a\nb\nc", "a\nx\nc")).toEqual({ before: "b", after: "x" });
  });

  it("falls back to the whole span when no line differs", () => {
    expect(changedLines("a", "a")).toEqual({ before: "a", after: "a" });
  });
});

const CENSUS_PY = `
from enum import Enum
from typing import Literal

ALPHA = 0.05
MODES = ("fast", "slow")
Kind = Literal["a", "b"]
_private = 1

class Color(Enum):
    RED = 1
    BLUE = 2

class Model:
    def __init__(self, rate):
        self.rate = rate

    def fit(self, data, *, ridge=0.0):
        return data

    def _hidden(self):
        pass

def public(x, y=1):
    def nested():
        pass
    return x

def _private_fn():
    pass
`;

const CENSUS_RS = `
pub const LIMIT: f64 = 1.0;
const HIDDEN: f64 = 2.0;
pub enum Mode { Fast, Slow(i32) }
enum Inner { A }
pub struct S;
impl S {
    pub fn get(&self, key: usize, mut other: i32) -> i32 { 1 }
    fn private(&self) {}
}
pub fn free(a: f64) -> f64 { a }
fn hidden() {}
pub mod inner { pub fn g() {} fn h() {} }
mod closed { pub fn unreachable() {} }
pub trait T { fn t(&self); }
impl T for S { fn t(&self) {} }
`;

function census(root: string, nodes: MapFile["nodes"]): MapFile {
  initRepo(root);
  const map: MapFile = { schema: 1, baseline: null, chains: [], contracts: [], nodes, inventory: {} };
  writeMap(root, map);
  return map;
}

describe("census", () => {
  it("inventories Python public functions, parameters and members", async () => {
    const root = makeRepo({ "m.py": CENSUS_PY });
    const map = census(root, [node({ id: "n", code: [anchor("m.py", "public", "")] })]);
    const ws = new Workspace(new RepoFiles(root));
    const inventory = (await currentInventory(map, ws))["m.py"];
    await ws.dispose();
    expect(inventory?.functions).toEqual(["Model.fit", "public"]);
    expect(inventory?.parameters).toEqual([
      "ALPHA",
      "MODES",
      "Model.__init__.rate",
      "Model.fit.data",
      "Model.fit.ridge",
      "public.x",
      "public.y",
    ]);
    expect(inventory?.members).toEqual(["Color.BLUE", "Color.RED", "Kind.a", "Kind.b", "MODES.fast", "MODES.slow"]);
  });

  it("inventories Rust public items only", async () => {
    const root = makeRepo({ "m.rs": CENSUS_RS });
    const map = census(root, [node({ id: "n", code: [anchor("m.rs", "free", "")] })]);
    const ws = new Workspace(new RepoFiles(root));
    const inventory = (await currentInventory(map, ws))["m.rs"];
    await ws.dispose();
    expect(inventory?.functions).toEqual(["S::get", "T::t", "free", "inner::g"]);
    expect(inventory?.parameters).toEqual(["LIMIT", "S::get.key", "S::get.other", "free.a"]);
    expect(inventory?.members).toEqual(["Mode::Fast", "Mode::Slow"]);
  });

  it("reports additions to a mapped module as gaps, of the three kinds", async () => {
    const root = makeRepo({ "m.py": "def a(x):\n    return x\n" });
    census(root, [node({ id: "n", code: [anchor("m.py", "a", "")] })]);
    await freezeMap(root);
    writeFiles(root, {
      "m.py": 'from enum import Enum\nN = 1\nclass E(Enum):\n    A = 1\ndef a(x, y):\n    return x\ndef b():\n    pass\n',
    });
    const ws = new Workspace(new RepoFiles(root));
    const gaps = await computeGaps(loadMap(root), ws);
    await ws.dispose();
    expect(gaps).toEqual(
      expect.arrayContaining([
        { path: "m.py", symbol: "b", kind: "function" },
        { path: "m.py", symbol: "a.y", kind: "parameter" },
        { path: "m.py", symbol: "N", kind: "parameter" },
        { path: "m.py", symbol: "E.A", kind: "member" },
      ]),
    );
    expect(gaps).toHaveLength(4);
  });

  it("does not report modules nobody mapped as gaps", async () => {
    const root = makeRepo({ "m.py": "def a():\n    pass\n", "other.py": "def z():\n    pass\n" });
    census(root, [node({ id: "n", code: [anchor("m.py", "a", "")] })]);
    await freezeMap(root);
    const ws = new Workspace(new RepoFiles(root));
    expect(await computeGaps(loadMap(root), ws)).toEqual([]);
    await ws.dispose();
  });

  it("reports unmapped source files with their share", () => {
    const root = makeRepo({
      "a.py": "1\n2\n3\n",
      "b.py": "1\n",
      "c.rs": "fn f() {}\n",
      "README.md": "not source\n",
      "tests/t.py": "1\n",
    });
    const map = census(root, [
      node({ id: "n", code: [anchor("a.py", null, "1")], verified_by: ["tests/t.py::test_x"] }),
    ]);
    const { uncharted, share } = computeUncharted(map, new RepoFiles(root));
    expect(uncharted).toEqual([
      { path: "b.py", lines: 1 },
      { path: "c.rs", lines: 1 },
    ]);
    expect(share).toBeCloseTo(2 / 6, 3);
  });

  it("does not chart the contracts directory or ignored files", () => {
    const root = makeRepo({ ".gitignore": "build/\n", "build/gen.py": "1\n", "a.py": "1\n" });
    const map = census(root, []);
    writeFiles(root, { ".mathkeel/contracts/c.py": "1\n" });
    const { uncharted } = computeUncharted(map, new RepoFiles(root));
    expect(uncharted.map((u) => u.path)).toEqual(["a.py"]);
  });
});

describe("map lint", () => {
  it("accepts a good map", async () => {
    const root = makeRepo({ "m.py": PY, "README.md": README, "tests/test_m.py": "def test_f():\n    pass\n" });
    census(root, [
      node({
        id: "n",
        doc: anchor("README.md", null, "The variance is"),
        code: [anchor("m.py", "f", "")],
        verified_by: ["tests/test_m.py::test_f"],
      }),
    ]);
    expect(await lintMap(root)).toEqual([]);
  });

  it("reports broken links, cycles and unresolved anchors together", async () => {
    const root = makeRepo({ "m.py": PY });
    initRepo(root);
    const map: MapFile = {
      schema: 1,
      baseline: null,
      chains: [],
      contracts: [],
      inventory: {},
      nodes: [
        node({ id: "a", depends_on: ["b", "missing"], contracts: ["nope"], code: [anchor("m.py", "gone", "")] }),
        node({ id: "b", depends_on: ["a"], verified_by: ["tests/none.py::t", "m.py::absent"] }),
      ],
    };
    writeMap(root, map);
    const issues = (await lintMap(root)).join("\n");
    expect(issues).toContain("unknown node missing");
    expect(issues).toContain("undeclared contract nope");
    expect(issues).toContain("depends_on cycle");
    expect(issues).toContain("symbol gone");
    expect(issues).toContain("tests/none.py not found");
    expect(issues).toContain("m.py::absent not found");
  });

  it("does not let formally_checked stand without a checked proof", () => {
    const map: MapFile = {
      schema: 1,
      baseline: null,
      chains: [],
      contracts: [],
      inventory: {},
      nodes: [node({ id: "a", status: "formally_checked" })],
    };
    expect(linkIssues(map).join()).toContain("needs a checked proof");
  });
});

describe("map freeze", () => {
  it("records hashes, inventory and the baseline commit", async () => {
    const root = makeRepo({ "m.py": PY, "README.md": README });
    census(root, [node({ id: "n", doc: anchor("README.md", null, "The variance is"), code: [anchor("m.py", "f", "")] })]);
    const result = await freezeMap(root);
    const stored = loadMap(root);
    expect(result.frozen).toBe(2);
    expect(stored.nodes[0]?.doc?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.nodes[0]?.code[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.inventory["m.py"]?.functions).toEqual(["f"]);
    expect(stored.baseline).toBe(result.baseline);
  });

  it("keeps hashes, baseline and inventory out of the file an agent reads", async () => {
    const root = makeRepo({ "m.py": PY, "README.md": README });
    census(root, [node({ id: "n", doc: anchor("README.md", null, "The variance is"), code: [anchor("m.py", "f", "")] })]);
    await freezeMap(root);
    const text = readFileSync(mapPath(root), "utf8");
    expect(path.basename(mapPath(root))).toBe("map.toon");
    expect(text).not.toMatch(/hash|baseline|inventory|quote: ""|pinned_to_code|depends_on/);
    expect(readFileSync(lockPath(root), "utf8")).toMatch(/baseline/);
  });

  it("lets the locator of an anchor change without losing its frozen hash", async () => {
    const root = makeRepo({ "m.py": PY, "README.md": README });
    census(root, [node({ id: "n", doc: anchor("README.md", null, "The variance is"), code: [anchor("m.py", "f", "")] })]);
    await freezeMap(root);
    const before = loadMap(root).nodes[0]?.doc?.hash;
    writeFiles(root, { ".mathkeel/map.toon": readFileSync(mapPath(root), "utf8").replace("The variance is", "variance is") });
    expect(loadMap(root).nodes[0]?.doc?.hash).toBe(before);
  });

  it("lets no hash in map.toon override the lock", async () => {
    const root = makeRepo({ "m.py": PY, "README.md": README });
    census(root, [node({ id: "n", code: [anchor("m.py", "f", "")] })]);
    await freezeMap(root);
    const frozen = loadMap(root).nodes[0]?.code[0]?.hash;
    const forged = "a".repeat(64);
    const text = readFileSync(mapPath(root), "utf8");
    const tampered = text.replace(/code\[1\]\{path,symbol\}:(\s+)m\.py,f/, `code[1]{path,symbol,hash}:$1m.py,f,${forged}`);
    expect(tampered).toContain(forged);
    writeFiles(root, { ".mathkeel/map.toon": tampered });
    expect(loadMap(root).nodes[0]?.code[0]?.hash).toBe(frozen);
  });

  it("refuses a blank or cut lock", async () => {
    const root = makeRepo({ "m.py": PY });
    census(root, [node({ id: "n", code: [anchor("m.py", "f", "")] })]);
    await freezeMap(root);
    writeFiles(root, { ".mathkeel/map.lock.toon": "" });
    expect(() => loadMap(root)).toThrow("map.lock.toon does not match the schema");
    writeFiles(root, { ".mathkeel/map.lock.toon": "baseline: null\nanchors[2]{node,anchor,hash}:\n  n,doc,x\ninventory:\n" });
    expect(() => loadMap(root)).toThrow("map.lock.toon is not valid TOON");
  });

  it("warns about a quote that a symbol makes unused, and accepts a map without one", () => {
    const quoted = node({ id: "n", code: [anchor("m.py", "f", "return 1")] });
    const bare = node({ id: "m", code: [anchor("m.py", "f", "")] });
    const onlyQuote = node({ id: "q", code: [anchor("m.py", null, "return 1")] });
    const map = { schema: 1, baseline: null, chains: [], contracts: [], inventory: {}, nodes: [quoted, bare, onlyQuote] } as MapFile;
    expect(mapWarnings(map)).toEqual([expect.stringContaining("n.code[0]")]);
  });

  it("refuses unresolved anchors and writes nothing", async () => {
    const root = makeRepo({ "m.py": PY });
    census(root, [node({ id: "n", code: [anchor("m.py", "gone", "")] })]);
    const before = readFileSync(mapPath(root), "utf8");
    await expect(freezeMap(root)).rejects.toThrow("unresolved");
    expect(readFileSync(mapPath(root), "utf8")).toBe(before);
  });

  it("never rebaselines a changed anchor: that takes accept", async () => {
    const root = makeRepo({ "m.py": PY });
    census(root, [node({ id: "n", code: [anchor("m.py", "f", "")] })]);
    await freezeMap(root);
    commitAll(root);
    const frozen = loadMap(root).nodes[0]?.code[0]?.hash;
    writeFiles(root, { "m.py": PY.replace("a * 2", "a * 3") });
    const result = await freezeMap(root);
    expect(result.kept).toEqual(["n.code[0]"]);
    expect(loadMap(root).nodes[0]?.code[0]?.hash).toBe(frozen);
  });

  it("stores forward slashes when a map uses backslashes", async () => {
    const root = makeRepo({ "src/m.py": PY });
    census(root, [node({ id: "n", code: [anchor("src\\m.py", "f", "")] })]);
    await freezeMap(root);
    expect(loadMap(root).nodes[0]?.code[0]?.path).toBe("src/m.py");
    expect(path.isAbsolute(loadMap(root).nodes[0]?.code[0]?.path ?? "")).toBe(false);
  });
});
