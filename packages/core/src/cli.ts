import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { encode } from "@toon-format/toon";
import { runContracts } from "./contracts.js";
import { acceptNode } from "./decisions.js";
import { MapError, UsageError } from "./errors.js";
import { findUiDir, renderExport } from "./export.js";
import { impact, trace } from "./impact.js";
import { judgeApply, judgePack } from "./judge.js";
import { freezeMap, initRepo, lintMap, loadMap, mapWarnings } from "./mapio.js";
import { findRepoRoot } from "./repo.js";
import { startServer } from "./server.js";
import { buildSnapshot } from "./snapshot.js";
import { saveLastCheck } from "./state.js";
import type { Snapshot } from "./types.js";

const VERSION = "0.1.0";

const HELP = `mathkeel ${VERSION}: watches the mathematics a repository documents

  mathkeel init                     create .mathkeel/
  mathkeel status [--json|--toon]   anchors, gaps, uncharted; no execution, no LLM
  mathkeel check [--yes] [--json|--toon]
                                    status plus contracts, listed before they run
  mathkeel map lint                 schema, links, unresolved anchors
  mathkeel map freeze               record hashes and inventory
  mathkeel impact <file|symbol> [--json|--toon]
                                    mapped nodes affected and their downstream
  mathkeel trace <node> [--json|--toon]
                                    assumption -> equation -> code -> test path
  mathkeel judge pack               one file per alert in .mathkeel/state/judge/
  mathkeel judge apply [file]       record verdicts as proposals
  mathkeel accept <id> --reason R   rebaseline a node; a person's decision
  mathkeel serve [--port N]         local UI, 127.0.0.1 only
  mathkeel export <file.html>       single offline HTML snapshot

Exit codes: 0 clean, 1 alerts present or awaiting review, 2 usage or map error.
`;

/** Repository text reaches the terminal as data: it cannot carry escape sequences. */
function plain(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?");
}

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/** Machine output: `--json` for tools and the UI contract, `--toon` for agents. */
function printData(value: unknown, values: { json?: boolean; toon?: boolean }): boolean {
  if (values.toon) print(encode(value));
  else if (values.json) print(JSON.stringify(value, null, 2));
  else return false;
  return true;
}

function flags<T extends Record<string, { type: "boolean" | "string" }>>(args: string[], options: T) {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    const { json, toon } = parsed.values as { json?: boolean; toon?: boolean };
    if (json && toon) throw new Error("choose one of --json and --toon");
    return parsed;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function noPositionals(positionals: string[]): void {
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
}

function exitCodeFor(snapshot: Snapshot): number {
  return snapshot.summary.alert > 0 || snapshot.summary.review > 0 ? 1 : 0;
}

function printSnapshot(snapshot: Snapshot): void {
  const s = snapshot.summary;
  const head = snapshot.repo.head === "" ? "no commit" : snapshot.repo.head.slice(0, 12);
  print(`${plain(snapshot.repo.name)} at ${head}${snapshot.repo.dirty ? " (dirty)" : ""}`);
  print(
    `fresh ${s.fresh}  queue ${s.queue}  alert ${s.alert}  review ${s.review}  ` +
      `gaps ${s.gaps}  uncharted ${(s.unchartedShare * 100).toFixed(1)}%`,
  );
  print(`contracts: ${snapshot.contractsRun ? "run" : "not_run"}`);
  for (const wanted of ["alert", "review", "queue"] as const) {
    for (const node of snapshot.nodes.filter((n) => n.class === wanted)) {
      print(`${wanted.padEnd(7)}${plain(node.id)}  ${plain(node.title)}`);
      for (const reason of node.reasons) print(`       - ${plain(reason)}`);
      if (node.upstreamChanged.length > 0) print(`       - upstream_changed: ${node.upstreamChanged.map(plain).join(", ")}`);
      if (node.verdict !== null) {
        print(`       - judge proposal: ${plain(node.verdict.verdict)}, ${plain(node.verdict.reason)}`);
      }
    }
  }
  for (const gap of snapshot.gaps) print(`gap    ${gap.kind} ${plain(gap.symbol)} in ${plain(gap.path)}`);
  for (const file of snapshot.uncharted) print(`uncharted ${plain(file.path)} (${file.lines} lines)`);
}

async function confirm(count: number): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new UsageError("contracts are arbitrary code: pass --yes to run them without a prompt");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Run these ${count} commands? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function cmdCheck(root: string, args: string[]): Promise<number> {
  const { values, positionals } = flags(args, { yes: { type: "boolean" }, json: { type: "boolean" }, toon: { type: "boolean" } });
  noPositionals(positionals);
  const map = loadMap(root);
  const say = (line: string): void => {
    (values.json || values.toon ? process.stderr : process.stdout).write(`${line}\n`);
  };
  if (map.contracts.length > 0) {
    say("Contracts are arbitrary code. These commands will run in the repository root, without a shell:");
    for (const contract of map.contracts) {
      say(`  ${plain(contract.id)}: ${plain(JSON.stringify(contract.command))} (timeout ${contract.timeout_s} s)`);
    }
    if (!values.yes && !(await confirm(map.contracts.length))) {
      say("Not run.");
      return 2;
    }
  }
  const results = await runContracts(root, map.contracts, (r) => {
    say(`${r.state.padEnd(5)}${plain(r.id)}${r.msg === "" ? "" : `: ${plain(r.msg)}`}`);
  });
  saveLastCheck(root, map, results);
  const snapshot = await buildSnapshot(root, { contractResults: results });
  if (!printData(snapshot, values)) printSnapshot(snapshot);
  return exitCodeFor(snapshot);
}

async function cmdStatus(root: string, args: string[]): Promise<number> {
  const { values, positionals } = flags(args, { json: { type: "boolean" }, toon: { type: "boolean" } });
  noPositionals(positionals);
  const snapshot = await buildSnapshot(root);
  if (!printData(snapshot, values)) printSnapshot(snapshot);
  return exitCodeFor(snapshot);
}

async function cmdMap(root: string, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  noPositionals(rest);
  if (sub === "lint") {
    const issues = await lintMap(root);
    if (issues.length > 0) throw new MapError(`map lint found ${issues.length} issues`, issues);
    for (const warning of mapWarnings(loadMap(root))) print(`warning ${plain(warning)}`);
    print("map ok");
    return 0;
  }
  if (sub === "freeze") {
    const result = await freezeMap(root);
    print(`frozen ${result.frozen} anchors at ${result.baseline.slice(0, 12)}; inventory recorded`);
    for (const where of result.kept) {
      print(`kept ${plain(where)}: it changed since its hash was frozen; only accept rebaselines it`);
    }
    return 0;
  }
  throw new UsageError("usage: mathkeel map lint|freeze");
}

function cmdImpact(root: string, args: string[]): number {
  const { values, positionals } = flags(args, { json: { type: "boolean" }, toon: { type: "boolean" } });
  const [target, ...rest] = positionals;
  if (target === undefined) throw new UsageError("usage: mathkeel impact <file|symbol>");
  noPositionals(rest);
  const result = impact(loadMap(root), target);
  if (printData(result, values)) return 0;
  print(`${plain(target)}: ${result.direct.length} mapped, ${result.downstream.length} downstream`);
  for (const id of result.direct) print(`mapped      ${plain(id)}`);
  for (const id of result.downstream) print(`downstream  ${plain(id)}`);
  return 0;
}

function cmdTrace(root: string, args: string[]): number {
  const { values, positionals } = flags(args, { json: { type: "boolean" }, toon: { type: "boolean" } });
  const [id, ...rest] = positionals;
  if (id === undefined) throw new UsageError("usage: mathkeel trace <node>");
  noPositionals(rest);
  const steps = trace(loadMap(root), id);
  if (printData(steps, values)) return 0;
  for (const step of steps) {
    print(`${step.stage.padEnd(11)}${plain(step.id)}  ${plain(step.title)}`);
    for (const anchor of step.anchors) print(`           ${plain(anchor)}`);
    for (const test of step.verifiedBy) print(`           verified_by ${plain(test)}`);
  }
  return 0;
}

async function cmdJudge(root: string, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "pack") {
    noPositionals(rest);
    const { packs, snapshot } = await judgePack(root);
    print(`${packs.length} packs in .mathkeel/state/judge/`);
    for (const pack of packs) print(`${pack.id}  ${plain(pack.node)}`);
    return exitCodeFor(snapshot);
  }
  if (sub === "apply") {
    const [file, ...extra] = rest;
    noPositionals(extra);
    const result = await judgeApply(root, file === undefined ? undefined : path.resolve(process.cwd(), file));
    for (const item of result.applied) print(`${item.id}  ${plain(item.node)}: proposed ${item.verdict}`);
    for (const item of result.skipped) print(`skipped ${plain(item)}`);
    const s = result.snapshot.summary;
    print(`alert ${s.alert}  review ${s.review}. A verdict is a proposal; a person decides with mathkeel accept.`);
    return exitCodeFor(result.snapshot);
  }
  throw new UsageError("usage: mathkeel judge pack|apply");
}

async function cmdAccept(root: string, args: string[]): Promise<number> {
  const { values, positionals } = flags(args, { reason: { type: "string" } });
  const [id, ...rest] = positionals;
  if (id === undefined || values.reason === undefined) {
    throw new UsageError('usage: mathkeel accept <id> --reason "..."');
  }
  noPositionals(rest);
  const decision = await acceptNode(root, id, values.reason);
  print(`accepted ${plain(decision.id)} by ${plain(decision.by)} at ${decision.commit.slice(0, 12) || "no commit"}`);
  return 0;
}

async function cmdServe(root: string, args: string[]): Promise<number> {
  const { values, positionals } = flags(args, { port: { type: "string" } });
  noPositionals(positionals);
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be a port number");
  loadMap(root);
  const server = await startServer({ root, port });
  print(`mathkeel serving ${plain(path.basename(root))}, read-only; contracts are not run.`);
  print(server.url);
  if (findUiDir() === null) print("The UI is not built; the page says so.");
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void server.close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function cmdExport(root: string, args: string[]): Promise<number> {
  const { positionals } = flags(args, {});
  const [file, ...rest] = positionals;
  if (file === undefined) throw new UsageError("usage: mathkeel export <file.html>");
  noPositionals(rest);
  const snapshot = await buildSnapshot(root, { useLastCheck: true });
  const target = path.resolve(process.cwd(), file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, renderExport(snapshot, findUiDir()));
  print(`wrote ${plain(target.replace(/\\/g, "/"))}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    print(HELP);
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-v") {
    print(VERSION);
    return 0;
  }
  const commands: Record<string, (root: string, args: string[]) => Promise<number> | number> = {
    status: cmdStatus,
    check: cmdCheck,
    map: cmdMap,
    impact: cmdImpact,
    trace: cmdTrace,
    judge: cmdJudge,
    accept: cmdAccept,
    serve: cmdServe,
    export: cmdExport,
  };
  if (command === "init") {
    noPositionals(args);
    const created = initRepo(findRepoRoot(process.cwd()));
    print(created.length === 0 ? "already initialised" : `created ${created.join(", ")}`);
    return 0;
  }
  const handler = commands[command];
  if (handler === undefined) throw new UsageError(`unknown command ${command}; try mathkeel --help`);
  return handler(findRepoRoot(process.cwd()), args);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof MapError) {
      process.stderr.write(`${plain(error.message)}\n`);
      for (const issue of error.issues) process.stderr.write(`  ${plain(issue)}\n`);
    } else {
      process.stderr.write(`mathkeel: ${plain(error instanceof Error ? error.message : String(error))}\n`);
    }
    process.exitCode = 2;
  },
);
