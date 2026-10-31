# mathkeel

**Know when the mathematics your code documents has changed.**

mathkeel anchors each documented statement to its text and its code, runs
independent checks on request, and keeps a chart of what still holds. When a
documented result changes, an agent proposes whether it is an error, and you
decide. It works beside a coding agent without entering its context.

![The chain view of mathkeel](packages/ui/screenshots/chain-day-desktop.png)

mathkeel says "this documented result changed". It never says "this is proved"
or "this code is correct".

mathkeel is built to be driven by a coding agent such as Claude Code or Codex.
The agent writes the map and the contracts under `.mathkeel/`, queries the chain
and proposes verdicts on alerts. You choose which chain to map, review the map,
and make the decisions. You do not write the map by hand. What an agent reads or
writes is [TOON](https://github.com/toon-format/toon) rather than JSON, to spend
fewer tokens.

## How it works

1. **Controls** see that a documented result changed. Anchors survive comments,
   formatting and local renames, and an anchor change alone never raises an alert.
2. **An independent agent** proposes `error`, `legitimate` or `uncertain`, with
   its reason.
3. **You decide** with `mathkeel accept`. No agent and no UI control does this.

Code that nobody has mapped stays visible as fog on the chart, because mathkeel
protects only what is mapped.

## Quickstart

mathkeel is not on npm yet, so build it from source. You need Node 20 or later,
and the demo also needs Python and Git.

```bash
git clone <this repository> mathkeel
cd mathkeel
npm install
npm run build
npm link --workspace packages/core
node eval/run.mjs
```

The last command runs seven demo cases. In your own repository, you normally ask
your agent to map a chain and it runs the commands below. They are listed so you
can see what it does, or run them yourself:

```bash
mathkeel init
# Describe one chain in .mathkeel/map.toon. See skill/mathkeel/references/mapping.md
mathkeel map lint
mathkeel map freeze
mathkeel status
mathkeel check
mathkeel serve
```

Copy `skill/mathkeel` into your agent's skills folder (for example
`~/.claude/skills` or `~/.codex/skills`) to map and query a chain from Claude
Code, Codex or another Agent Skills client. The skill is the intended way to use
mathkeel; the `mathkeel` command must still be on your `PATH`.

## Commands

| Command | Purpose | Runs code |
| --- | --- | --- |
| `status` | Anchors, gaps and uncharted share | No |
| `check` | Status plus your declared contracts | Yes, after listing them |
| `map lint`, `map freeze` | Validate and record the map | No |
| `impact`, `trace` | Follow a file, symbol or node | No |
| `judge pack`, `judge apply` | Prepare alerts for an agent, then apply its proposals | No |
| `accept` | Record your decision and rebaseline | No |
| `serve`, `export` | Local live chart or offline HTML | No |
| `export --graph` | The map as a graph that Graphify can merge | No |
| `suggest <graph>` | Unmapped files linked to mapped code; adds nothing | No |

`status`, `check`, `impact` and `trace` take `--toon` or `--json` for structured
output. `check` and `judge apply` exit 1 while alerts or reviews remain, so an
agent cannot turn continuous integration green by itself.

## Evaluation

The design went through blinded benchmarks on one Python forecasting repository.
One agent built the map and a separate agent wrote labelled code changes. Results
on the 137 changes unseen by the rule set, with thresholds fixed in advance:

| Measure | Controls alone | With judge | Target |
| --- | --- | --- | --- |
| Alert precision | 0.84 | 0.98 | 0.90 |
| Mathematical errors found | 71% | 71% | 70% |
| Subtle errors found | 68% | 68% | 50% |
| Neutral changes without an alert | 100% | 100% | 95% |
| Legitimate changes without an alert | 67% | 100% | 80% |

These results have clear limits. The changes were artificial, there was one
repository and one judge run, and the judge targets were set after the controls
failed their own gate. A wrong change documented with care was not tested.
Errors found reached 43 of 44 in mapped modules and 4 of 22 in barely mapped ones.

## Privacy and security

mathkeel makes no network calls at runtime and has no telemetry. It skips `.env`,
keys and binary data, and respects `.gitignore`. Contracts are code, so review
them like code: they run only on `mathkeel check`. `serve` binds to 127.0.0.1,
requires a random token, and stops with its process.

## Status

v0.1, tested on Windows with Node 24 and on Chromium. Python and Rust anchors;
Rust parsing uses an older grammar, so recent syntax may be unsupported. macOS,
Linux, Node 20, Firefox and Safari are not yet tested.

## License

MIT
