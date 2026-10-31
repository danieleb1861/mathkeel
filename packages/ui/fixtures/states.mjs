/**
 * Synthetic states derived from the demo fixture. Used by the preview harness
 * and the screenshot scripts, so a human and the checks look at the same data.
 */

const clone = (value) => JSON.parse(JSON.stringify(value));

export function emptyState(demo) {
  return {
    ...clone(demo),
    repo: { name: "new-repository", head: "a1b2c3d", dirty: false, baseline: "a1b2c3d" },
    contractsRun: false,
    summary: { fresh: 0, queue: 0, alert: 0, review: 0, gaps: 0, unchartedShare: 1 },
    chains: [],
    nodes: [],
    gaps: [],
    uncharted: [],
    activity: [],
    decisions: [],
  };
}

const KINDS = ["assumption", "definition", "equation", "lemma", "code", "code", "test"];

/** A deterministic 500-node map: twelve chains with a repeating failure pattern. */
export function hugeState(demo) {
  const base = clone(demo);
  const template = base.nodes.find((node) => node.id === "dm.loss");
  const nodes = [];
  const chains = [];
  const total = 500;
  const chainCount = 12;
  for (let c = 0; c < chainCount; c += 1) {
    const id = `chain_${String(c + 1).padStart(2, "0")}`;
    const size = Math.floor(total / chainCount) + (c < total % chainCount ? 1 : 0);
    const nodeIds = [];
    for (let i = 0; i < size; i += 1) {
      const nodeId = `${id}.n${String(i).padStart(3, "0")}`;
      const kind = KINDS[Math.min(KINDS.length - 1, Math.floor((i / size) * KINDS.length))];
      const parents = i === 0 ? [] : [`${id}.n${String(Math.floor((i * 7) % i)).padStart(3, "0")}`];
      if (i > 2 && i % 3 === 0) parents.push(`${id}.n${String(i - 2).padStart(3, "0")}`);
      const cls = i % 53 === 7 ? "alert" : i % 37 === 11 ? "review" : i % 17 === 5 ? "queue" : "fresh";
      nodes.push({
        ...clone(template),
        id: nodeId,
        chain: id,
        kind,
        title: `${kind.replace("_", " ")} ${c + 1}.${i}`,
        latex: undefined,
        depends_on: [...new Set(parents)],
        class: cls,
        reasons: cls === "fresh" ? [] : [`Synthetic ${cls} reason for ${nodeId}`],
        contracts: [],
        contractResults: [],
        upstreamChanged: [],
        verdict: null,
      });
      nodeIds.push(nodeId);
    }
    chains.push({ id, title: `Chain ${c + 1}`, nodeIds });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const upstream = new Set();
    const stack = [...node.depends_on];
    while (stack.length > 0) {
      const parent = byId.get(stack.pop());
      if (!parent || upstream.has(parent.id)) continue;
      if (parent.class !== "fresh") upstream.add(parent.id);
      stack.push(...parent.depends_on);
    }
    node.upstreamChanged = [...upstream];
  }
  const count = (cls) => nodes.filter((node) => node.class === cls).length;
  base.nodes = nodes;
  base.chains = chains;
  base.activity = [
    {
      path: "src/chain_03/module.py",
      changedAt: new Date(Date.parse(base.generatedAt) - 240_000).toISOString(),
      touches: nodes.filter((node) => node.chain === "chain_03").slice(0, 20).map((node) => node.id),
    },
  ];
  base.decisions = [];
  base.summary = {
    ...base.summary,
    fresh: count("fresh"),
    queue: count("queue"),
    alert: count("alert"),
    review: count("review"),
  };
  return base;
}

export const STATE_NAMES = ["demo", "empty", "huge"];

export function stateFor(name, demo) {
  if (name === "empty") return emptyState(demo);
  if (name === "huge") return hugeState(demo);
  return demo;
}
