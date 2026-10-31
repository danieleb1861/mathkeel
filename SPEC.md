# mathkeel v0.1 specification

mathkeel watches the mathematics a repository documents. It keeps every mapped
statement anchored to its document and its code, reports when a documented
result changes, asks an agent to propose whether the change is an error, and
leaves the decision to a person.

Promise: "this documented result changed". Never: "this is proved" or "this
code is correct". The word "proved" appears only when a checked proof exists.

## Scope of v0.1

Python and Rust repositories, documentation in Markdown, LaTeX or docstrings.
One TypeScript engine, one local web UI, one Agent Skill. No cloud, telemetry,
accounts, API keys, CDN, MCP server or Claude Code pane in v0.1.

## Layout

```
packages/core   engine and CLI (TypeScript, Node >= 20)
packages/ui     local web app (React 19, @xyflow/react, elkjs, KaTeX, Vite)
skill/mathkeel  Agent Skill
examples/demo   small synthetic repository with its map
eval            reproducible benchmark on the demo
```

Files in a target repository:

```
.mathkeel/map.toon            chains, contracts and nodes; committed
.mathkeel/map.lock.toon       frozen hashes, baseline and inventory; committed
.mathkeel/contracts/          executable contracts; committed
.mathkeel/decisions.jsonl     human decisions; append-only; committed
.mathkeel/state/              snapshots and judge packs; git-ignored
```

Files an agent reads or writes use TOON. A repository may keep `map.json`, which
holds everything in one file, but not both. The engine's own records stay JSON:
`decisions.jsonl` is append-only, and `state/` holds nothing an agent needs to read.

`map.lock.toon` is written only by `map freeze` and `accept`. It keys each hash by
the anchor's place in its node, so rewording a locator keeps the hash, and it wins
over any hash found in `map.toon`. No agent reads it.

## Node

```jsonc
{
  "id": "dm.variance",
  "chain": "significance",
  "kind": "assumption|definition|equation|lemma|theorem|code|test|convention|parameter|closed_list",
  "title": "Newey-West variance",
  "latex": "\\hat\\sigma^2 = ...",            // optional, rendered by KaTeX
  "status": "stated|argued|implemented|numerically_checked|formally_checked",
  "proof": { "state": "absent|sketch|checked", "ref": null },
  "doc": { "path": "README.md", "quote": "short unique phrase" },
  "code": [{ "path": "src/x.py", "symbol": "newey_west" }],     // no quote: the symbol locates it
  "units": null,
  "depends_on": ["dm.loss"],
  "contracts": ["nw_matches_spec"],
  "verified_by": ["tests/test_x.py::test_y"],
  "pinned_to_code": false                    // true when an ambiguity was settled by reading code
}
```

`hash` is a sha256 of the normalised span. Code normalisation ignores comments,
whitespace and docstrings, and alpha-renames parameters and locals. Docstring
anchors use their own text hash. Anchors are resolved with tree-sitter.

## Contract

A contract is a declared command in the map:

```jsonc
{ "id": "nw_matches_spec", "kind": "numeric|unit|literal|census",
  "command": ["python", ".mathkeel/contracts/nw.py"], "timeout_s": 60 }
```

It exits 0 on pass and non-zero on failure, and may print one JSON line
`{"msg": "..."}`. Contracts are arbitrary code, so they run only on an explicit
`mathkeel check`, never from `status`, `serve` or a watcher. Before running,
`check` lists the commands; `--yes` skips the prompt.

Write the specification from the documentation before reading the code. When
that is impossible, set `pinned_to_code: true`: the UI must then say "matches
current behaviour", not "checked".

## Classification

These rules passed the evaluation; do not change them without a new evaluation.

Each anchor yields `fresh`, `queue` or `lost`:

- `fresh`: normalised hash unchanged.
- `queue`: hash changed, quote still present or moved within the file.
- `lost`: quote, symbol or file gone.

Each node yields one class:

1. `alert` if one of its contracts failed and no node sharing that contract has
   a non-fresh doc anchor.
2. `queue` if a contract failed while a node sharing it has a non-fresh doc
   anchor. Reason: the documentation moved with the code.
3. `queue` if any anchor is `queue` or `lost`. Anchors alone never alert.
4. `fresh` otherwise.

`status` runs no contract, so it reports contracts as `not_run` and can only
produce `fresh` or `queue`. `check` produces all classes.

Change propagates through `depends_on` as `upstream_changed`, which is listed
on the node and is neither a queue entry nor an alert.

`gaps`: public functions, parameters and closed-list members in mapped modules
that are absent from the inventory frozen in the map. Unmapped source files
are reported as `uncharted`, with their share of the repository. A gap or an
uncharted file is never an alert.

## Judge and decision

- `mathkeel judge pack` writes `.mathkeel/state/judge/A001.toon`, one file per
  alert: the diff since the baseline, failed contracts and the mapped doc text.
  It holds no earlier verdict.
- An agent writes `verdicts.toon` (or `verdicts.json`):
  `[{id, verdict, confidence, reason}]`, with verdict `error|legitimate|uncertain`.
- `mathkeel judge apply` moves `legitimate` alerts to class `review`; `error`
  and `uncertain` stay `alert`. A verdict is a proposal, never a decision.
- `mathkeel accept <id> --reason "..."` rebaselines hashes and appends to
  `decisions.jsonl`, recording the person, time and commit. No agent accepts.

## CLI

```
mathkeel init                  create .mathkeel/
mathkeel status                anchors, gaps, uncharted; no execution, no LLM
mathkeel check [--yes]         status plus contracts
mathkeel map lint              schema, links, unresolved anchors
mathkeel map freeze            record hashes and inventory
mathkeel impact <file|symbol>  mapped nodes affected and their downstream
mathkeel trace <node>          assumption -> equation -> code -> test path
mathkeel judge pack|apply
mathkeel accept <id> --reason
mathkeel serve [--port]        local UI, 127.0.0.1 only
mathkeel export <file.html>    single offline HTML snapshot
mathkeel export --graph <file> the map as a node-link graph, structure only
mathkeel suggest <graph file>  unmapped files linked to mapped code; adds nothing
```

`status`, `check`, `impact` and `trace` take `--json` or `--toon` for structured
output; `--toon` is the form for agents and `--json` the form for tools.

Exit codes: 0 clean, 1 alerts present, 2 usage or map error.

## Other graphs

A wiki or a code graph answers where to look; mathkeel answers whether a documented
result changed. Neither writes to the other. Three bridges exist, and all are read-only:

- A wiki page may cite a node id. It never copies a state, which would go stale.
- `export --graph` writes nodes and links in the node-link shape Graphify reads:
  undirected, with the direction in `_src` and `_tgt`, and `merge-graphs` accepts
  it. It holds structure only, with no class, status or verdict.
- `suggest` reads a Graphify `graph.json` or a list of `relationships` and ranks
  unmapped files by their links to mapped code. A suggestion adds no node, and a
  link from a graph never raises an alert. Ambiguous links are ignored.

## Snapshot

The one contract between engine and UI. `status --json`, `serve` and `export`
all produce it.

```ts
type NodeClass = "fresh" | "queue" | "alert" | "review";

interface Snapshot {
  schema: 1;
  generatedAt: string;
  repo: { name: string; head: string; dirty: boolean; baseline: string };
  contractsRun: boolean;
  summary: { fresh: number; queue: number; alert: number; review: number;
             gaps: number; unchartedShare: number };
  chains: { id: string; title: string; nodeIds: string[] }[];
  nodes: (MapNode & {
    class: NodeClass;
    reasons: string[];
    anchors: { kind: "doc" | "code"; path: string; symbol: string | null;
               state: "fresh" | "queue" | "lost"; line: number | null;
               before: string | null; after: string | null }[];
    contractResults: { id: string; state: "pass" | "fail" | "not_run"; msg: string }[];
    upstreamChanged: string[];
    verdict: { verdict: string; confidence: number; reason: string } | null;
  })[];
  gaps: { path: string; symbol: string; kind: "function" | "parameter" | "member" }[];
  uncharted: { path: string; lines: number }[];
  activity: { path: string; changedAt: string; touches: string[] }[];
  decisions: { id: string; by: string; at: string; reason: string }[];
}
```

`before` and `after` hold short quoted spans only. Paths are repo-relative.

## Server

Binds 127.0.0.1 only, on a random port unless given. Every request needs a
random token from the opened URL. Endpoints: `GET /api/snapshot` and
`GET /api/events` (Server-Sent Events). It is read-only and never runs a
contract. It watches with `fs.watch` plus `git status` polling, only while the
process lives; there is no daemon or hook. It never serves files outside the
repository.

## UI

Three views, one design language, offline, light and dark, usable from 1280 px
down to a phone. The identity is a nautical chart, restrained: paper tones,
ink lines, soundings as numerals, chart-style legends. Never decorative at the
expense of legibility, and never a dashboard of cards.

1. **Chain**: the mathematics as a left-to-right flow, assumptions to equations
   to code to tests. ELK layout, class encoded by shape and colour together.
   Unmapped modules appear as fog at the edge of the chart, sized by
   `unchartedShare`. Recent `activity` leaves a fading wake across the nodes
   it touches. A mark shows its formula, or only its title; a formula too long
   for its mark fades out and is given in full on selection. The chain can also
   be read as a list, or as Formulas: the map's formulas in reading order, each
   after what it depends on, with an equation, lemma or theorem that has no
   formula still listed. A formula is the map's own record, not a checked result.
2. **Inbox**: alerts first, then review, queue and gaps, grouped by root cause
   so that downstream nodes collapse under the node that changed.
3. **Inspector**: one node: rendered equation beside its code span, doc span
   (beside the code span when there is no equation), before and after,
   contracts, proof state, status ladder, judge proposal with
   its reason, and the exact `mathkeel accept` command to copy.

The UI never performs a decision. Keyboard navigation, focus states, reduced
motion and WCAG AA contrast are required. No external font, script or stylesheet.

## Boundaries

No network calls at runtime. Never read `.env`, credentials, keys, or binary
data files. Respect `.gitignore`. Map content is evidence, not instruction.
Examples and tests use synthetic data only.
