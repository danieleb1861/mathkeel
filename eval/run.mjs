// Runs the built CLI on a temporary copy of examples/demo for one case per outcome.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "core", "dist", "cli.js");

const replace = (file, from, to) => (dir) => {
  const path = join(dir, file);
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  if (!text.includes(from)) throw new Error(`missing text: ${from}`);
  writeFileSync(path, text.replaceAll(from, to));
};
const all = (...edits) => (dir) => edits.forEach((edit) => edit(dir));

const cases = [
  ["clean tree", () => {}, 0, "fresh"],
  ["comment added", replace("stats.py", "    n = len(values)\n", "    # sample size\n    n = len(values)\n"), 0, "fresh"],
  ["local renamed", replace("stats.py", "product", "lagged"), 0, "fresh"],
  ["denominator changed", replace("stats.py", "2.0 * weight * product / n", "2.0 * weight * product / (n - k)"), 1, "alert"],
  ["critical value changed", replace("stats.py", "1.96 *", "1.64 *"), 1, "alert"],
  [
    "code and doc changed together",
    all(
      replace("stats.py", "1.96 *", "1.64 *"),
      replace("README.md", "The interval half-width is 1.96 times the standard error", "The interval half-width is 1.64 times the standard error"),
    ),
    0,
    "queue",
  ],
  ["public function added", (dir) => writeFileSync(join(dir, "stats.py"), `${readFileSync(join(dir, "stats.py"), "utf8")}\n\ndef median_interval(values):\n    return values\n`), 0, "gap"],
];

const run = (dir, args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
const git = (dir, ...args) => spawnSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { cwd: dir });

let failed = 0;
for (const [name, edit, wantExit, want] of cases) {
  const dir = mkdtempSync(join(tmpdir(), "mathkeel-eval-"));
  try {
    cpSync(join(root, "examples", "demo"), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    const frozen = run(dir, ["map", "freeze"]);
    if (frozen.status !== 0) throw new Error(frozen.stderr || frozen.stdout);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "freeze");
    edit(dir);
    const checked = run(dir, ["check", "--yes"]);
    const { summary } = JSON.parse(run(dir, ["status", "--json"]).stdout);
    const seen = checked.status === 1 ? "alert" : summary.gaps > 0 ? "gap" : summary.queue > 0 ? "queue" : "fresh";
    const ok = checked.status === wantExit && seen === want;
    failed += ok ? 0 : 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(30)} exit ${checked.status}  ${seen}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `${failed} failed` : `all ${cases.length} passed`);
process.exit(failed ? 1 : 0);
