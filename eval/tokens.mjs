// Measures what an agent must read to answer fixed questions about a repository,
// with mathkeel and without it, ending on the same evidence in every arm:
//
//   exact    a search that already knows the right terms, so an unbeatable rival
//   keyword  one word of the question, over the whole repository, capped at 250 lines
//   whole    reading each file that holds the evidence
//
//   node eval/tokens.mjs                       the demo, on a temporary copy
//   node eval/tokens.mjs <tasks.json> <repo>   your own questions on your own repository
//
// It counts text, not an agent: it says what the cheapest honest route costs, not
// what a given agent would spend. Tokens are cl100k_base, a stand-in for any model.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEncoding } from "js-tiktoken";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "core", "dist", "cli.js");
const GREP_LINES = 250; // the default cap of the search tool of a coding agent
const encoder = getEncoding("cl100k_base");
const tokens = (text) => encoder.encode(text, "all").length;

function run(repo, [command, ...args]) {
  const argv = command === "mathkeel" ? [process.execPath, cli, ...args] : [command, ...args];
  const result = spawnSync(argv[0], argv.slice(1), { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
  return result.stdout ?? "";
}

const read = (repo, path) => readFileSync(join(repo, path), "utf8").replace(/\r\n/g, "\n");

function section(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.replace(/^#+\s+/, "") === heading);
  if (start === -1) throw new Error(`no heading ${heading}`);
  const level = lines[start].match(/^#+/)[0].length;
  const rest = lines.slice(start + 1).findIndex((line) => {
    const mark = line.match(/^(#{1,6})\s/);
    return mark !== null && mark[1].length <= level;
  });
  return lines.slice(start, rest === -1 ? undefined : start + 1 + rest).join("\n");
}

/** The body of a function or class, found by name: `A::b` and `A.b` both end at `b`. */
function symbol(text, name) {
  const last = name.split(/::|\./).pop();
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^\\s*(pub(\\(crate\\))? )?(async )?(fn|def|class) ${last}\\b`).test(line));
  if (start === -1) throw new Error(`no symbol ${name}`);
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  if (/\bfn\b/.test(lines[start])) {
    for (let depth = 0, open = false, at = start; at < lines.length; at += 1) {
      for (const ch of lines[at]) {
        if (ch === "{") [depth, open] = [depth + 1, true];
        if (ch === "}") depth -= 1;
      }
      if (open && depth === 0) {
        end = at + 1;
        break;
      }
    }
  } else {
    while (end < lines.length && (lines[end].trim() === "" || lines[end].search(/\S/) > indent)) end += 1;
  }
  return lines.slice(start, end).join("\n");
}

function evidence(repo, item) {
  const text = read(repo, item.path);
  if (item.heading) return section(text, item.heading);
  if (item.symbol) return symbol(text, item.symbol);
  return text;
}

function measure(repo, task) {
  const seen = task.evidence.reduce((sum, item) => sum + tokens(evidence(repo, item)), 0);
  const steps = (commands) => (commands ?? []).reduce((sum, command) => sum + tokens(run(repo, command)), 0);
  const search = steps(task.search);
  const files = [...new Set(task.evidence.map((item) => item.path))];
  const found = run(repo, ["git", "grep", "-n", "-I", "-i", "-F", task.keyword]);
  const keyword = tokens(found.split("\n").slice(0, GREP_LINES).join("\n"));
  return {
    id: task.id,
    kind: task.kind,
    mathkeel: steps(task.mathkeel) + seen + (task.kind === "unmapped" ? keyword : 0),
    keyword: keyword + seen,
    search: search + seen,
    whole: search + files.reduce((sum, file) => sum + tokens(read(repo, file)), 0),
  };
}

/** One-off cost: what is written, plus reading each documented file and anchored symbol once. */
function setup(repo) {
  const skill = tokens(read(root, "skill/mathkeel/SKILL.md"));
  const guide = tokens(read(root, "skill/mathkeel/references/mapping.md"));
  const map = tokens(read(repo, ".mathkeel/map.toon"));
  const contracts = readdirSync(join(repo, ".mathkeel", "contracts"))
    .filter((file) => !file.startsWith("__"))
    .reduce((sum, file) => sum + tokens(read(repo, `.mathkeel/contracts/${file}`)), 0);
  const { nodes } = JSON.parse(run(repo, ["mathkeel", "status", "--json"]));
  const anchors = new Map(nodes.flatMap((node) => node.anchors).map((a) => [`${a.path}#${a.symbol}`, a]));
  let reading = 0;
  for (const anchor of anchors.values()) {
    const code = anchor.kind === "code" && anchor.symbol !== null;
    if (code) reading += tokens(symbol(read(repo, anchor.path), anchor.symbol));
  }
  for (const file of new Set(nodes.flatMap((node) => node.anchors.filter((a) => a.kind === "doc").map((a) => a.path)))) {
    reading += tokens(read(repo, file));
  }
  return { skill, written: map + contracts, reading: reading + guide, total: map + contracts + reading + guide };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percent = (part, whole) => `${Math.round(100 * (1 - part / whole))}%`;
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

function report(repo, tasks) {
  const rows = tasks.map((task) => measure(repo, task));
  console.log(`${"task".padEnd(14)}${"kind".padEnd(10)}${"mathkeel".padStart(9)}${"exact".padStart(8)}${"keyword".padStart(9)}${"whole".padStart(8)}`);
  for (const row of rows) {
    console.log(`${row.id.padEnd(14)}${row.kind.padEnd(10)}${String(row.mathkeel).padStart(9)}${String(row.search).padStart(8)}${String(row.keyword).padStart(9)}${String(row.whole).padStart(8)}`);
  }
  const mapped = rows.filter((row) => row.kind === "mapped" || row.kind === "impact");
  const control = rows.filter((row) => row.kind === "unmapped");
  const cost = setup(repo);
  console.log(`\nmapped questions: ${mapped.length}, mathkeel ${sum(mapped, "mathkeel")} tokens`);
  for (const [name, key] of [["exact search", "search"], ["keyword search", "keyword"], ["whole files", "whole"]]) {
    const ratios = mapped.map((row) => row.mathkeel / row[key]);
    const gain = median(mapped.map((row) => row[key] - row.mathkeel));
    const even = gain > 0 ? `${Math.ceil(cost.total / gain)} questions` : "never";
    console.log(`  vs ${name.padEnd(14)} total ${String(sum(mapped, key)).padStart(6)} saved ${percent(sum(mapped, "mathkeel"), sum(mapped, key)).padStart(4)}, median ${percent(median(ratios), 1).padStart(4)}, range ${percent(Math.max(...ratios), 1)} to ${percent(Math.min(...ratios), 1)}, median gain ${gain}, break-even ${even}`);
  }
  if (control.length > 0) console.log(`unmapped questions: ${control.length}, mathkeel ${sum(control, "mathkeel")}, keyword search ${sum(control, "keyword")}, extra ${sum(control, "mathkeel") - sum(control, "keyword")} tokens`);
  console.log(`one-off: written ${cost.written}, read ${cost.reading}, total ${cost.total}; skill ${cost.skill} per session`);
}

const [tasksFile, repoArg] = process.argv.slice(2);
if (tasksFile && repoArg) {
  report(repoArg, JSON.parse(readFileSync(tasksFile, "utf8")));
} else {
  const dir = mkdtempSync(join(tmpdir(), "mathkeel-tokens-"));
  const git = (...args) => spawnSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { cwd: dir });
  try {
    cpSync(join(root, "examples", "demo"), dir, { recursive: true });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "base");
    run(dir, ["mathkeel", "map", "freeze"]);
    report(dir, JSON.parse(readFileSync(join(root, "eval", "tokens.demo.json"), "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
