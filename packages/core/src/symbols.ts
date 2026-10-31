import { collapseWhitespace, hashCode, pyDocstringNode, pyParameterNames } from "./normalise.js";
import { childrenOf, namedChildrenOf, parseCode, type CodeLanguage, type Node, type Tree } from "./treesitter.js";
import type { GapKind } from "./types.js";

export interface DocSpan {
  text: string;
  line: number;
}

export interface CodeSymbol {
  name: string;
  node: Node;
  line: number;
  doc: DocSpan | null;
}

export interface CensusItem {
  symbol: string;
  kind: GapKind;
}

/** One parsed file. Its syntax nodes live until `dispose`. */
export class ParsedCode {
  readonly symbols = new Map<string, CodeSymbol[]>();
  readonly docstrings: DocSpan[] = [];
  readonly census: CensusItem[] = [];

  constructor(
    readonly language: CodeLanguage,
    readonly tree: Tree,
  ) {}

  add(symbol: CodeSymbol): void {
    const known = this.symbols.get(symbol.name);
    if (known === undefined) this.symbols.set(symbol.name, [symbol]);
    else known.push(symbol);
    if (symbol.doc !== null) this.docstrings.push(symbol.doc);
  }

  /** Accepts `A.b` and `A::b` alike, so a map need not know which language it names. */
  lookup(symbol: string): CodeSymbol[] {
    return this.symbols.get(symbol.replace(/::/g, this.separator).replace(/\./g, this.separator)) ?? [];
  }

  private get separator(): string {
    return this.language === "python" ? "." : "::";
  }

  /** The innermost definition or top-level statement around a character offset. */
  spanAt(start: number, end: number): Node | null {
    let node: Node | null = this.tree.rootNode.descendantForIndex(start, end);
    while (node !== null) {
      if (node.type === "function_item") return node;
      if (node.type === "function_definition" || node.type === "class_definition") {
        return node.parent?.type === "decorated_definition" ? node.parent : node;
      }
      if (node.parent === null || node.parent.parent === null) return node;
      node = node.parent;
    }
    return null;
  }

  hash(node: Node): string {
    return hashCode(node, this.language);
  }

  dispose(): void {
    this.tree.delete();
  }
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function isTestFile(path: string): boolean {
  return /(^|\/)(tests?\/|test_[^/]*$|[^/]*_test\.[a-z]+$)/.test(path);
}

// ---------------------------------------------------------------- Python

const PY_ENUM_BASE = /\b(Enum|IntEnum|StrEnum|Flag|IntFlag)\b/;
const PY_CONSTANT = /^[A-Z][A-Z0-9_]*$/;
const PY_COMPOUND = new Set(["if_statement", "try_statement", "with_statement"]);

type PyContext = "module" | "class" | "function";

function isPyPublic(name: string): boolean {
  return name.split(".").every((part) => !part.startsWith("_"));
}

function pyStringText(node: Node): string {
  const parts: string[] = [];
  const visit = (n: Node): void => {
    if (n.type === "string_content") parts.push(n.text);
    else childrenOf(n).forEach(visit);
  };
  visit(node);
  return parts.join("");
}

function pyDocSpan(body: Node | null): DocSpan | null {
  const statement = pyDocstringNode(body);
  return statement === null ? null : { text: pyStringText(statement), line: lineOf(statement) };
}

function pyLiteralMembers(value: Node, name: string): string[] {
  let source: Node | null = value;
  if (value.type === "subscript") {
    if (!/^(typing\.|t\.)?Literal$/.test(value.childForFieldName("value")?.text ?? "")) return [];
  } else if (value.type === "call") {
    if (value.childForFieldName("function")?.text !== "frozenset") return [];
    source = value.childForFieldName("arguments")?.namedChild(0) ?? null;
    if (source === null) return [];
  } else if (value.type !== "tuple" && value.type !== "list" && value.type !== "set") {
    return [];
  } else if (!PY_CONSTANT.test(name)) {
    return [];
  }
  const members: string[] = [];
  for (const child of namedChildrenOf(source)) {
    if (child.type === "string") members.push(pyStringText(child));
    else if (child.type === "integer") members.push(child.text);
  }
  return members;
}

function pyCensusAssignment(parsed: ParsedCode, name: string, value: Node | null): void {
  if (!isPyPublic(name)) return;
  const members = value === null ? [] : pyLiteralMembers(value, name);
  for (const member of members) parsed.census.push({ symbol: `${name}.${member}`, kind: "member" });
  if (PY_CONSTANT.test(name) && !name.includes(".")) parsed.census.push({ symbol: name, kind: "parameter" });
}

function pyCensusFunction(parsed: ParsedCode, name: string, def: Node, context: PyContext): void {
  if (context === "function") return;
  const base = name.split(".").pop() ?? name;
  const constructor = base === "__init__" && isPyPublic(name.split(".").slice(0, -1).join("."));
  if (!isPyPublic(name) && !constructor) return;
  if (!constructor) parsed.census.push({ symbol: name, kind: "function" });
  for (const param of pyParameterNames(def.childForFieldName("parameters"))) {
    if (param !== "self" && param !== "cls") parsed.census.push({ symbol: `${name}.${param}`, kind: "parameter" });
  }
}

function pyEnumMembers(parsed: ParsedCode, name: string, def: Node, body: Node): void {
  if (!isPyPublic(name) || !PY_ENUM_BASE.test(def.childForFieldName("superclasses")?.text ?? "")) return;
  for (const statement of namedChildrenOf(body)) {
    const assignment = statement.type === "expression_statement" ? statement.namedChild(0) : null;
    const left = assignment?.type === "assignment" ? assignment.childForFieldName("left") : null;
    if (left?.type === "identifier" && !left.text.startsWith("_")) {
      parsed.census.push({ symbol: `${name}.${left.text}`, kind: "member" });
    }
  }
}

function walkPython(container: Node, prefix: string, context: PyContext, parsed: ParsedCode, census: boolean): void {
  for (const child of namedChildrenOf(container)) {
    const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    if (def === null) continue;
    const name = def.childForFieldName("name")?.text ?? "";
    const qualified = `${prefix}${name}`;
    const body = def.childForFieldName("body");
    if (def.type === "function_definition") {
      parsed.add({ name: qualified, node: child, line: lineOf(child), doc: pyDocSpan(body) });
      if (census) pyCensusFunction(parsed, qualified, def, context);
      if (body !== null) walkPython(body, `${qualified}.`, "function", parsed, census);
    } else if (def.type === "class_definition") {
      parsed.add({ name: qualified, node: child, line: lineOf(child), doc: pyDocSpan(body) });
      if (body !== null) {
        if (census) pyEnumMembers(parsed, qualified, def, body);
        walkPython(body, `${qualified}.`, "class", parsed, census);
      }
    } else if (context === "function") {
      continue;
    } else if (def.type === "expression_statement") {
      const assignment = def.namedChild(0);
      if (assignment?.type !== "assignment") continue;
      const targets: string[] = [];
      collectPyTargets(assignment.childForFieldName("left"), targets);
      for (const target of targets) {
        parsed.add({ name: `${prefix}${target}`, node: child, line: lineOf(child), doc: null });
        if (census && context === "module") {
          pyCensusAssignment(parsed, target, assignment.childForFieldName("right"));
        }
      }
    } else if (PY_COMPOUND.has(def.type)) {
      for (const part of namedChildrenOf(def)) {
        if (part.type === "block") walkPython(part, prefix, context, parsed, census);
        else if (part.type.endsWith("_clause")) {
          for (const inner of namedChildrenOf(part)) {
            if (inner.type === "block") walkPython(inner, prefix, context, parsed, census);
          }
        }
      }
    }
  }
}

function collectPyTargets(node: Node | null, out: string[]): void {
  if (node === null) return;
  if (node.type === "identifier") out.push(node.text);
  else if (node.type === "pattern_list" || node.type === "tuple_pattern") {
    for (const child of namedChildrenOf(node)) collectPyTargets(child, out);
  }
}

// ------------------------------------------------------------------ Rust

function isRustPublic(node: Node): boolean {
  return childrenOf(node).some((c) => c.type === "visibility_modifier" && c.text === "pub");
}

function rustDocSpan(item: Node): DocSpan | null {
  const lines: string[] = [];
  let first = item;
  for (let prev = item.previousNamedSibling; prev !== null; prev = prev.previousNamedSibling) {
    if (prev.type === "attribute_item") {
      const value = /^#\[\s*doc\s*=\s*"(.*)"\s*\]$/s.exec(prev.text);
      if (value?.[1] === undefined) continue;
      lines.unshift(value[1]);
    } else if (prev.type === "line_comment" && /^\/\/\/(?!\/)/.test(prev.text)) {
      lines.unshift(prev.text.replace(/^\/\/\/ ?/, "").trimEnd());
    } else if (prev.type === "block_comment" && /^\/\*\*(?!\*)/.test(prev.text)) {
      lines.unshift(prev.text.replace(/^\/\*\*/, "").replace(/\*\/$/, ""));
    } else {
      break;
    }
    first = prev;
  }
  return lines.length === 0 ? null : { text: lines.join("\n"), line: lineOf(first) };
}

function rustTypeName(node: Node | null): string {
  if (node === null) return "";
  if (node.type === "generic_type") return rustTypeName(node.childForFieldName("type"));
  if (node.type === "reference_type") return rustTypeName(node.childForFieldName("type"));
  return node.text.replace(/\s+/g, "");
}

function rustParameterNames(fn: Node): string[] {
  const params = fn.childForFieldName("parameters");
  if (params === null) return [];
  const names: string[] = [];
  for (const param of namedChildrenOf(params)) {
    if (param.type !== "parameter") continue;
    const pattern = param.childForFieldName("pattern");
    if (pattern === null) continue;
    if (pattern.type === "identifier") names.push(pattern.text);
    else if (pattern.type === "mut_pattern") {
      const inner = pattern.namedChild(0);
      if (inner?.type === "identifier") names.push(inner.text);
    }
  }
  return names;
}

function walkRust(
  container: Node,
  prefix: string,
  parsed: ParsedCode,
  census: boolean,
  options: { implicitPublic: boolean; reachable: boolean },
): void {
  for (const item of namedChildrenOf(container)) {
    const name = item.childForFieldName("name")?.text ?? "";
    const qualified = `${prefix}${name}`;
    const isPublic = options.reachable && (options.implicitPublic || isRustPublic(item));
    const add = (): void => {
      parsed.add({ name: qualified, node: item, line: lineOf(item), doc: rustDocSpan(item) });
    };
    switch (item.type) {
      case "function_item":
      case "function_signature_item":
        add();
        if (census && isPublic) {
          parsed.census.push({ symbol: qualified, kind: "function" });
          for (const param of rustParameterNames(item)) {
            parsed.census.push({ symbol: `${qualified}.${param}`, kind: "parameter" });
          }
        }
        break;
      case "struct_item":
      case "union_item":
      case "type_item":
      case "macro_definition":
        add();
        break;
      case "const_item":
      case "static_item":
        add();
        if (census && isPublic) parsed.census.push({ symbol: qualified, kind: "parameter" });
        break;
      case "enum_item": {
        add();
        const variants = item.childForFieldName("body");
        for (const variant of variants === null ? [] : namedChildrenOf(variants)) {
          if (variant.type !== "enum_variant") continue;
          const member = `${qualified}::${variant.childForFieldName("name")?.text ?? ""}`;
          parsed.add({ name: member, node: variant, line: lineOf(variant), doc: rustDocSpan(variant) });
          if (census && isPublic) parsed.census.push({ symbol: member, kind: "member" });
        }
        break;
      }
      case "trait_item": {
        add();
        const body = item.childForFieldName("body");
        if (body !== null) {
          walkRust(body, `${qualified}::`, parsed, census, { implicitPublic: true, reachable: isPublic });
        }
        break;
      }
      case "mod_item": {
        add();
        const body = item.childForFieldName("body");
        if (body !== null) {
          walkRust(body, `${qualified}::`, parsed, census, { implicitPublic: false, reachable: isPublic });
        }
        break;
      }
      case "impl_item": {
        const base = rustTypeName(item.childForFieldName("type"));
        const body = item.childForFieldName("body");
        if (body !== null) {
          const inherent = item.childForFieldName("trait") === null;
          walkRust(body, `${prefix}${base}::`, parsed, census, {
            implicitPublic: false,
            reachable: options.reachable && inherent,
          });
        }
        break;
      }
    }
  }
}

function rustModuleDoc(root: Node): DocSpan | null {
  const lines: string[] = [];
  let line = 0;
  for (const child of namedChildrenOf(root)) {
    if (child.type !== "line_comment" || !child.text.startsWith("//!")) break;
    if (lines.length === 0) line = lineOf(child);
    lines.push(child.text.replace(/^\/\/! ?/, "").trimEnd());
  }
  return lines.length === 0 ? null : { text: lines.join("\n"), line };
}

// ------------------------------------------------------------------ API

export async function analyseCode(language: CodeLanguage, text: string, path: string): Promise<ParsedCode> {
  const tree = await parseCode(language, text);
  const parsed = new ParsedCode(language, tree);
  const census = !isTestFile(path);
  if (language === "python") {
    const moduleDoc = pyDocSpan(tree.rootNode);
    if (moduleDoc !== null) parsed.docstrings.push(moduleDoc);
    walkPython(tree.rootNode, "", "module", parsed, census);
  } else {
    const moduleDoc = rustModuleDoc(tree.rootNode);
    if (moduleDoc !== null) parsed.docstrings.push(moduleDoc);
    walkRust(tree.rootNode, "", parsed, census, { implicitPublic: false, reachable: true });
  }
  return parsed;
}

/** Docstring text compared by content, whatever its indentation or line breaks. */
export function docstringContains(doc: DocSpan, quote: string): boolean {
  return collapseWhitespace(doc.text).includes(collapseWhitespace(quote));
}
