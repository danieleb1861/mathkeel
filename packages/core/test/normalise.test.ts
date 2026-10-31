import { describe, expect, it } from "vitest";
import { hashText, normaliseCode } from "../src/normalise.js";
import { normaliseNewlines } from "../src/repo.js";
import { analyseCode } from "../src/symbols.js";
import type { CodeLanguage } from "../src/treesitter.js";

async function normal(language: CodeLanguage, source: string, symbol: string): Promise<string> {
  const parsed = await analyseCode(language, normaliseNewlines(source), "src/m");
  try {
    const found = parsed.lookup(symbol)[0];
    if (found === undefined) throw new Error(`no symbol ${symbol}`);
    return normaliseCode(found.node, language);
  } finally {
    parsed.dispose();
  }
}

const py = (source: string, symbol = "f"): Promise<string> => normal("python", source, symbol);
const rs = (source: string, symbol = "f"): Promise<string> => normal("rust", source, symbol);

const PY_BASE = `
def f(values, lag=1):
    """Sum of the lagged products."""
    total = 0.0
    for index, value in enumerate(values):
        total += value * values[index - lag]
    return total / len(values)
`;

describe("python normalisation", () => {
  it("ignores reformatting", async () => {
    const reformatted = `
def f(values,
      lag = 1):
    """Sum of the lagged products."""

    total=0.0

    for index,value in enumerate( values ):
        total += ( value*values[ index-lag ] )
    return ( total/len(values) )
`;
    expect(await py(reformatted)).toBe(await py(PY_BASE));
  });

  it("ignores trailing commas and redundant parentheses a formatter touches", async () => {
    expect(await py("def f(a, b):\n    return g(a, b)\n")).toBe(await py("def f(a, b,):\n    return (\n        g(a, b,)\n    )\n"));
    expect(await py('X = {"a": 1}\n', "X")).toBe(await py('X = {\n    "a": 1,\n}\n', "X"));
  });

  it("ignores the quote style of strings", async () => {
    expect(await py("def f():\n    return 'a'\n")).toBe(await py('def f():\n    return "a"\n'));
  });

  it("ignores comment edits", async () => {
    const commented = PY_BASE.replace("total = 0.0", "total = 0.0  # running sum\n    # a whole line of comment");
    expect(await py(commented)).toBe(await py(PY_BASE));
  });

  it("ignores docstring edits", async () => {
    const changed = PY_BASE.replace("Sum of the lagged products.", "Something else entirely.");
    expect(await py(changed)).toBe(await py(PY_BASE));
    expect(await py("def f():\n    return 1\n")).toBe(await py('def f():\n    """Doc."""\n    return 1\n'));
  });

  it("alpha-renames parameters and locals", async () => {
    const renamed = `
def f(series, shift=1):
    acc = 0.0
    for k, x in enumerate(series):
        acc += x * series[k - shift]
    return acc / len(series)
`;
    expect(await py(renamed)).toBe(await py(PY_BASE));
  });

  it("alpha-renames nested scopes: lambdas, comprehensions, inner functions", async () => {
    const a = `
def f(xs):
    def inner(y):
        return y + 1
    g = lambda z: z * 2
    return [inner(g(i)) for i in xs]
`;
    const b = `
def f(data):
    def helper(q):
        return q + 1
    h = lambda w: w * 2
    return [helper(h(n)) for n in data]
`;
    expect(await py(a)).toBe(await py(b));
  });

  it("detects a real expression change", async () => {
    expect(await py(PY_BASE.replace("index - lag", "index + lag"))).not.toBe(await py(PY_BASE));
    expect(await py(PY_BASE.replace("0.0", "1.0"))).not.toBe(await py(PY_BASE));
    expect(await py(PY_BASE.replace("/ len(values)", "/ (len(values) - 1)"))).not.toBe(await py(PY_BASE));
  });

  it("sees swapped operands, which a rename must not hide", async () => {
    expect(await py("def f(a, b):\n    return a - b\n")).not.toBe(await py("def f(a, b):\n    return b - a\n"));
  });

  it("sees swapped parameters", async () => {
    expect(await py("def f(a, b):\n    return a - b\n")).not.toBe(await py("def f(b, a):\n    return a - b\n"));
  });

  it("keeps parentheses that group operators", async () => {
    expect(await py("def f(a, b, c):\n    return (a + b) * c\n")).not.toBe(await py("def f(a, b, c):\n    return a + b * c\n"));
  });

  it("keeps the comma of a one-tuple", async () => {
    expect(await py("def f(a):\n    return (a,)\n")).not.toBe(await py("def f(a):\n    return (a)\n"));
  });

  it("does not rename globals, attributes, keyword arguments or calls", async () => {
    const text = await py("def f(a):\n    return G * a.size + h(size=a)\n");
    expect(text).toContain("G");
    expect(text).toContain(". size");
    expect(text).toContain("size =");
    expect(text).toContain("h (");
    expect(text).toBe("def f ( $0 ) : return G * $0 . size + h ( size = $0 )");
  });

  it("sees a change in a name it does not rename", async () => {
    expect(await py("def f(a):\n    return G * a\n")).not.toBe(await py("def f(a):\n    return H * a\n"));
    expect(await py("def f(a):\n    return a.mean()\n")).not.toBe(await py("def f(a):\n    return a.median()\n"));
  });

  it("does not rename a name declared global", async () => {
    expect(await py("def f():\n    global N\n    N = 1\n    return N\n")).toContain("N = 1");
  });

  it("evaluates a default value in the enclosing scope", async () => {
    expect(await py("def f(a, b=a):\n    return b\n")).toContain("= a");
  });

  it("alpha-renames through f-strings", async () => {
    expect(await py('def f(a):\n    return f"{a!r:>10}"\n')).toBe(await py('def f(b):\n    return f"{b!r:>10}"\n'));
  });

  it("normalises a method inside a class and ignores the class docstring", async () => {
    const a = 'class C:\n    """Doc."""\n    K = 1\n    def m(self, x):\n        return self.k * x\n';
    const b = 'class C:\n    K = 1\n    def m(this, y):\n        # note\n        return this.k * y\n';
    expect(await py(a, "C")).toBe(await py(b, "C"));
    expect(await py(a, "C.m")).toBe(await py(b, "C.m"));
  });

  it("binds with-as and except-as names", async () => {
    const a = "def f(p):\n    with open(p) as h:\n        return h.read()\n";
    const b = "def f(q):\n    with open(q) as k:\n        return k.read()\n";
    expect(await py(a)).toBe(await py(b));
    const c = "def f():\n    try:\n        return 1\n    except E as e:\n        return e\n";
    const d = "def f():\n    try:\n        return 1\n    except E as err:\n        return err\n";
    expect(await py(c)).toBe(await py(d));
  });

  it("hashes CRLF files the same as LF", async () => {
    expect(await py(PY_BASE.replace(/\n/g, "\r\n"))).toBe(await py(PY_BASE));
  });
});

const RS_BASE = `
/// Sum of the lagged products.
pub fn f(values: &[f64], lag: usize) -> f64 {
    let mut total = 0.0;
    for (index, value) in values.iter().enumerate() {
        total += value * values[index - lag];
    }
    total / values.len() as f64
}
`;

describe("rust normalisation", () => {
  it("ignores reformatting", async () => {
    const reformatted = `
pub fn f(
    values: &[f64],
    lag: usize,
) -> f64
{
    let mut total=0.0;
    for (index,value) in values.iter().enumerate()
    {
        total += value*values[index-lag];
    }

    total/values.len() as f64
}
`;
    expect(await rs(reformatted)).toBe(await rs(RS_BASE));
  });

  it("ignores trailing commas", async () => {
    expect(await rs("fn f(a: i32) -> i32 { g(a, 1) }")).toBe(await rs("fn f(a: i32,) -> i32 {\n    g(\n        a,\n        1,\n    )\n}"));
  });

  it("ignores comment edits", async () => {
    const commented = RS_BASE.replace("let mut total = 0.0;", "let mut total = 0.0; // running\n    /* block */");
    expect(await rs(commented)).toBe(await rs(RS_BASE));
  });

  it("ignores doc comments and doc attributes", async () => {
    const changed = RS_BASE.replace("/// Sum of the lagged products.", "/// Other text.\n/// More.");
    expect(await rs(changed)).toBe(await rs(RS_BASE));
    const body = 'fn f() {\n    #[doc = "x"]\n    let a = 1;\n}';
    expect(await rs(body)).toBe(await rs('fn f() {\n    #[doc = "y"]\n    let a = 1;\n}'));
  });

  it("alpha-renames parameters and locals", async () => {
    const renamed = `
pub fn f(series: &[f64], shift: usize) -> f64 {
    let mut acc = 0.0;
    for (k, x) in series.iter().enumerate() {
        acc += x * series[k - shift];
    }
    acc / series.len() as f64
}
`;
    expect(await rs(renamed)).toBe(await rs(RS_BASE));
  });

  it("alpha-renames patterns, closures, match arms and if-let", async () => {
    const a = `
fn f(p: P, o: Option<i32>) -> i32 {
    let P { x, y: w } = p;
    let g = |v: i32| v * x;
    if let Some(k) = o { return k; }
    match w { 0 => 1, FOO => 2, n if n > 1 => g(n), _ => 3 }
}
`;
    const b = `
fn f(q: P, r: Option<i32>) -> i32 {
    let P { x: a, y: b } = q;
    let h = |c: i32| c * a;
    if let Some(d) = r { return d; }
    match b { 0 => 1, FOO => 2, e if e > 1 => h(e), _ => 3 }
}
`;
    expect(await rs(a)).toBe(await rs(b));
  });

  it("treats a struct shorthand like the explicit field", async () => {
    expect(await rs("fn f(a: i32) -> S { S { a } }")).toBe(await rs("fn f(b: i32) -> S { S { a: b } }"));
  });

  it("resolves shadowing in order", async () => {
    const shadowed = "fn f(a: i32) -> i32 {\n    let a = a + 1;\n    let a = a * 2;\n    a\n}";
    const distinct = "fn f(p: i32) -> i32 {\n    let q = p + 1;\n    let r = q * 2;\n    r\n}";
    expect(await rs(shadowed)).toBe(await rs(distinct));
  });

  it("renames inside macro arguments", async () => {
    expect(await rs('fn f(a: i32) { println!("{}", a); }')).toBe(await rs('fn f(b: i32) { println!("{}", b); }'));
  });

  it("detects a real expression change", async () => {
    expect(await rs(RS_BASE.replace("index - lag", "index + lag"))).not.toBe(await rs(RS_BASE));
    expect(await rs(RS_BASE.replace("0.0", "1.0"))).not.toBe(await rs(RS_BASE));
  });

  it("sees swapped operands", async () => {
    expect(await rs("fn f(a: i32, b: i32) -> i32 { a - b }")).not.toBe(await rs("fn f(a: i32, b: i32) -> i32 { b - a }"));
  });

  it("keeps grouping parentheses and the comma of a one-tuple", async () => {
    expect(await rs("fn f(a: i32, b: i32) -> i32 { (a + b) * 2 }")).not.toBe(await rs("fn f(a: i32, b: i32) -> i32 { a + b * 2 }"));
    expect(await rs("fn f(a: i32) -> (i32,) { (a,) }")).not.toBe(await rs("fn f(a: i32) -> i32 { (a) }"));
  });

  it("does not rename fields, paths or types", async () => {
    const text = await rs("fn f(a: Thing) -> f64 { std::f64::consts::PI * a.size }");
    expect(text).toContain("std :: f64 :: consts :: PI");
    expect(text).toContain("$0 . size");
    expect(text).toContain("Thing");
  });

  it("hashes CRLF files the same as LF", async () => {
    expect(await rs(RS_BASE.replace(/\n/g, "\r\n"))).toBe(await rs(RS_BASE));
  });

  it("resolves impl methods, trait methods, enum variants and module items", async () => {
    const source = `
struct S;
impl S { fn m(&self) -> i32 { 1 } }
trait T { fn t(&self) -> i32; }
enum E { A, B }
mod inner { pub fn g() {} }
const K: f64 = 1.0;
`;
    expect(await rs(source, "S::m")).toContain("fn m");
    expect(await rs(source, "S.m")).toContain("fn m");
    expect(await rs(source, "T::t")).toContain("fn t");
    expect(await rs(source, "E::B")).toBe("B");
    expect(await rs(source, "inner::g")).toContain("fn g");
    expect(await rs(source, "K")).toContain("1.0");
  });
});

describe("text normalisation", () => {
  it("ignores layout", () => {
    expect(hashText("a  b\n c", "markdown")).toBe(hashText("a b c", "markdown"));
  });

  it("ignores comments in Markdown and LaTeX", () => {
    expect(hashText("a <!-- note --> b", "markdown")).toBe(hashText("a b", "markdown"));
    expect(hashText("a % note\nb", "latex")).toBe(hashText("a b", "latex"));
    expect(hashText("5\\% of a", "latex")).not.toBe(hashText("5", "latex"));
  });

  it("sees a change of content", () => {
    expect(hashText("a b", "markdown")).not.toBe(hashText("a c", "markdown"));
  });
});
