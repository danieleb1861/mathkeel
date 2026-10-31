import { z } from "zod";
import type { Contract, MapChain, MapFile, MapNode } from "./types.js";

/**
 * Ids reach a command the UI offers to copy (`mathkeel accept <id>`), and map
 * contents are untrusted, so an id may hold nothing a shell would interpret.
 */
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "id may hold letters, digits and _ . : - only");

export const anchorSchema = z.strictObject({
  path: z.string().min(1),
  symbol: z.string().min(1).nullable().default(null),
  quote: z.string().default(""),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "hash must be a lowercase sha256")
    .nullable()
    .default(null),
});

export const nodeSchema = z.strictObject({
  id: idSchema,
  chain: z.string().min(1),
  kind: z.enum([
    "assumption",
    "definition",
    "equation",
    "lemma",
    "theorem",
    "code",
    "test",
    "convention",
    "parameter",
    "closed_list",
  ]),
  title: z.string().min(1),
  latex: z.string().optional(),
  status: z.enum(["stated", "argued", "implemented", "numerically_checked", "formally_checked"]),
  proof: z
    .strictObject({ state: z.enum(["absent", "sketch", "checked"]), ref: z.string().nullable().default(null) })
    .default({ state: "absent", ref: null }),
  doc: anchorSchema.nullable().default(null),
  code: z.array(anchorSchema).default([]),
  units: z.string().nullable().default(null),
  depends_on: z.array(z.string()).default([]),
  contracts: z.array(z.string()).default([]),
  verified_by: z.array(z.string()).default([]),
  pinned_to_code: z.boolean().default(false),
});

export const contractSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["numeric", "unit", "literal", "census"]),
  command: z.array(z.string().min(1)).min(1),
  timeout_s: z.number().positive().max(3600).default(60),
});

export const chainSchema = z.strictObject({ id: z.string().min(1), title: z.string() });

const inventoryEntrySchema = z.strictObject({
  functions: z.array(z.string()).default([]),
  parameters: z.array(z.string()).default([]),
  members: z.array(z.string()).default([]),
});

export const mapSchema = z.object({
  schema: z.literal(1).default(1),
  baseline: z.string().nullable().default(null),
  chains: z.array(chainSchema).default([]),
  contracts: z.array(contractSchema).default([]),
  nodes: z.array(nodeSchema).default([]),
  inventory: z.record(z.string(), inventoryEntrySchema).default({}),
});

/** What only the engine writes: no field has a default, so a blank or cut lock is refused. */
export const lockSchema = z.strictObject({
  baseline: z.string().nullable(),
  anchors: z.array(
    z.strictObject({
      node: z.string(),
      anchor: z.string(),
      hash: z.string().regex(/^[0-9a-f]{64}$/, "hash must be a lowercase sha256"),
    }),
  ),
  inventory: z.record(z.string(), inventoryEntrySchema),
});

export const verdictSchema = z.strictObject({
  id: z.string().min(1),
  verdict: z.enum(["error", "legitimate", "uncertain"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export const verdictsSchema = z.array(verdictSchema);

export const decisionSchema = z.object({
  id: z.string(),
  by: z.string(),
  at: z.string(),
  reason: z.string(),
  commit: z.string(),
});

/** Keeps the zod schemas and the hand-written types in `types.ts` from drifting. */
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type SchemaMatchesTypes = [
  Assert<Same<z.output<typeof nodeSchema>, MapNode>>,
  Assert<Same<z.output<typeof contractSchema>, Contract>>,
  Assert<Same<z.output<typeof chainSchema>, MapChain>>,
  Assert<Same<z.output<typeof mapSchema>, MapFile>>,
];
