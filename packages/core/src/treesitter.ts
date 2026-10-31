import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

export type { Node, Tree };
export type CodeLanguage = "python" | "rust";

const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_DIRS = [path.join(here, "wasm"), path.join(here, "..", "dist", "wasm")];

function wasmFile(name: string): string {
  for (const dir of CANDIDATE_DIRS) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  throw new Error(`grammar file ${name} is missing; run the build`);
}

let ready: Promise<void> | null = null;
const parsers = new Map<CodeLanguage, Promise<Parser>>();

async function loadParser(language: CodeLanguage): Promise<Parser> {
  ready ??= Parser.init({ locateFile: (name: string) => wasmFile(name) });
  await ready;
  const grammar = await Language.load(new Uint8Array(readFileSync(wasmFile(`tree-sitter-${language}.wasm`))));
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser;
}

export async function parseCode(language: CodeLanguage, text: string): Promise<Tree> {
  let parser = parsers.get(language);
  if (parser === undefined) {
    parser = loadParser(language);
    parsers.set(language, parser);
  }
  const tree = (await parser).parse(text);
  if (tree === null) throw new Error(`tree-sitter returned no tree for ${language}`);
  return tree;
}

export function childrenOf(node: Node): Node[] {
  return node.children.filter((c): c is Node => c !== null);
}

export function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

export function fieldText(node: Node, field: string): string | null {
  return node.childForFieldName(field)?.text ?? null;
}
