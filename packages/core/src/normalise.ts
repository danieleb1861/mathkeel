import { createHash } from "node:crypto";
import { childrenOf, namedChildrenOf, type CodeLanguage, type Node } from "./treesitter.js";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A trailing comma that changes meaning, as in the one-tuple `(a,)`. */
const KEPT_COMMA = ",\u0001";
const TUPLE_LIKE = new Set(["tuple", "tuple_pattern", "tuple_expression", "tuple_type"]);

class Emitter {
  readonly tokens: string[] = [];
  private counter = 0;

  push(token: string): void {
    if (token !== "") this.tokens.push(token);
  }

  fresh(): string {
    return `$${this.counter++}`;
  }

  /** Runs `body`, returning its tokens instead of appending them. */
  capture(body: () => void): string[] {
    const start = this.tokens.length;
    body();
    return this.tokens.splice(start);
  }

  finish(): string {
    const out: string[] = [];
    this.tokens.forEach((token, i) => {
      const next = this.tokens[i + 1];
      if (token === "," && (next === ")" || next === "]" || next === "}")) return;
      out.push(token === KEPT_COMMA ? "," : token);
    });
    return out.join(" ");
  }
}

class Scope {
  /** null marks a name the scope owns but has not numbered yet. */
  readonly names = new Map<string, string | null>();
  private readonly verbatim = new Set<string>();

  constructor(readonly parent: Scope | null) {}

  declare(name: string): void {
    if (!this.names.has(name)) this.names.set(name, null);
  }

  declareVerbatim(name: string): void {
    this.verbatim.add(name);
  }

  /** The canonical name, or the name itself for a global, builtin or import. */
  resolve(name: string, em: Emitter): string {
    for (let scope: Scope | null = this; scope !== null; scope = scope.parent) {
      if (scope.verbatim.has(name)) return name;
      if (scope.names.has(name)) {
        const known = scope.names.get(name);
        if (known !== null && known !== undefined) return known;
        const assigned = em.fresh();
        scope.names.set(name, assigned);
        return assigned;
      }
    }
    return name;
  }
}

function emitVerbatim(node: Node, em: Emitter): void {
  if (node.childCount === 0) {
    em.push(node.text);
    return;
  }
  for (const child of childrenOf(node)) emitVerbatim(child, em);
}

function isComment(node: Node): boolean {
  return node.type === "comment" || node.type === "line_comment" || node.type === "block_comment";
}

function emitComma(parent: Node, em: Emitter): void {
  const elements = namedChildrenOf(parent).filter((c) => !isComment(c));
  const meaningful = parent.type === "subscript" || (TUPLE_LIKE.has(parent.type) && elements.length === 1);
  em.push(meaningful ? KEPT_COMMA : ",");
}

/** Drops parentheses a formatter may add or remove, keeping those that group operators. */
function emitParenthesised(
  node: Node,
  safeParents: ReadonlySet<string>,
  atoms: ReadonlySet<string>,
  emitChild: (child: Node) => void,
): void {
  const inner = namedChildrenOf(node).filter((c) => !isComment(c));
  const only = inner.length === 1 ? inner[0] : undefined;
  const parentType = node.parent?.type ?? "";
  const redundant = only !== undefined && (safeParents.has(parentType) || atoms.has(only.type));
  for (const child of childrenOf(node)) {
    if (redundant && (child.type === "(" || child.type === ")")) continue;
    if (!isComment(child)) emitChild(child);
  }
}

// ---------------------------------------------------------------- Python

const PY_NON_EXPRESSION_INNER = new Set(["yield", "named_expression"]);
const PY_PAREN_SAFE_PARENTS = new Set([
  "assignment",
  "augmented_assignment",
  "return_statement",
  "expression_statement",
  "argument_list",
  "keyword_argument",
  "parenthesized_expression",
  "if_statement",
  "elif_clause",
  "while_statement",
  "assert_statement",
  "list",
  "set",
  "pair",
]);
const PY_ATOMS = new Set([
  "identifier",
  "integer",
  "float",
  "string",
  "true",
  "false",
  "none",
  "call",
  "attribute",
  "subscript",
  "list",
  "set",
  "dictionary",
  "tuple",
  "parenthesized_expression",
]);

const PY_COMPREHENSIONS = new Set([
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
]);

const PY_DEFAULTED = new Set(["default_parameter", "typed_default_parameter"]);

function pyTargetNames(node: Node | null, out: string[]): void {
  if (node === null) return;
  if (node.type === "identifier") {
    out.push(node.text);
  } else if (
    node.type === "pattern_list" ||
    node.type === "tuple_pattern" ||
    node.type === "list_pattern" ||
    node.type === "list_splat_pattern" ||
    node.type === "as_pattern_target"
  ) {
    for (const child of namedChildrenOf(node)) pyTargetNames(child, out);
  }
}

/** Names of the parameters of a `parameters` or `lambda_parameters` node, in order. */
export function pyParameterNames(params: Node | null): string[] {
  if (params === null) return [];
  const names: string[] = [];
  for (const param of namedChildrenOf(params)) {
    switch (param.type) {
      case "identifier":
        names.push(param.text);
        break;
      case "default_parameter":
      case "typed_default_parameter":
        pyTargetNames(param.childForFieldName("name"), names);
        break;
      case "typed_parameter": {
        const first = param.namedChild(0);
        if (first !== null) pyParameterTarget(first, names);
        break;
      }
      case "list_splat_pattern":
      case "dictionary_splat_pattern":
        pyParameterTarget(param, names);
        break;
      case "tuple_pattern":
        pyTargetNames(param, names);
        break;
    }
  }
  return names;
}

function pyParameterTarget(node: Node, out: string[]): void {
  if (node.type === "identifier") {
    out.push(node.text);
    return;
  }
  const inner = node.namedChild(0);
  if (inner?.type === "identifier") out.push(inner.text);
}

/** Records what a function body binds, stopping at nested scopes. */
function pyCollectBindings(node: Node, scope: Scope): void {
  for (const child of namedChildrenOf(node)) {
    switch (child.type) {
      case "function_definition":
      case "class_definition": {
        const name = child.childForFieldName("name");
        if (name !== null) scope.declare(name.text);
        continue;
      }
      case "lambda":
        continue;
      case "global_statement":
        for (const id of namedChildrenOf(child)) scope.declareVerbatim(id.text);
        continue;
      case "nonlocal_statement":
        continue;
      case "assignment":
      case "augmented_assignment":
      case "for_statement": {
        const names: string[] = [];
        pyTargetNames(child.childForFieldName("left"), names);
        names.forEach((n) => scope.declare(n));
        break;
      }
      case "named_expression": {
        const name = child.childForFieldName("name");
        if (name !== null) scope.declare(name.text);
        break;
      }
      case "as_pattern": {
        const names: string[] = [];
        pyTargetNames(child.childForFieldName("alias"), names);
        names.forEach((n) => scope.declare(n));
        break;
      }
    }
    if (!PY_COMPREHENSIONS.has(child.type)) pyCollectBindings(child, scope);
  }
}

/** The docstring expression of a body, when its first statement is one. */
export function pyDocstringNode(body: Node | null): Node | null {
  if (body === null) return null;
  const first = namedChildrenOf(body).find((c) => !isComment(c));
  if (first?.type !== "expression_statement") return null;
  const parts = namedChildrenOf(first);
  const only = parts[0];
  if (parts.length !== 1 || only === undefined) return null;
  if (only.type !== "string" && only.type !== "concatenated_string") return null;
  return first;
}

function emitPyBlock(block: Node, scope: Scope, em: Emitter, skipDocstring: boolean): void {
  const docstring = skipDocstring ? pyDocstringNode(block) : null;
  for (const child of childrenOf(block)) {
    if (docstring !== null && child.id === docstring.id) continue;
    emitPy(child, scope, em);
  }
}

function emitPyParameters(params: Node, inner: Scope, outer: Scope, em: Emitter): void {
  for (const child of childrenOf(params)) {
    if (child.type === ",") {
      emitComma(params, em);
    } else if (PY_DEFAULTED.has(child.type)) {
      const value = child.childForFieldName("value");
      for (const part of childrenOf(child)) {
        emitPy(part, value !== null && part.id === value.id ? outer : inner, em);
      }
    } else {
      emitPy(child, inner, em);
    }
  }
}

function emitPyFunction(node: Node, outer: Scope, em: Emitter): void {
  const inner = new Scope(outer);
  const params = node.childForFieldName("parameters");
  const body = node.childForFieldName("body");
  const name = node.childForFieldName("name");
  pyParameterNames(params).forEach((n) => inner.declare(n));
  if (body !== null) pyCollectBindings(body, inner);
  for (const child of childrenOf(node)) {
    if (name !== null && child.id === name.id) emitPy(child, outer, em);
    else if (params !== null && child.id === params.id) emitPyParameters(child, inner, outer, em);
    else if (body !== null && child.id === body.id) emitPyBlock(child, inner, em, true);
    else emitPy(child, inner, em);
  }
}

function emitPyLambda(node: Node, outer: Scope, em: Emitter): void {
  const inner = new Scope(outer);
  const params = node.childForFieldName("parameters");
  pyParameterNames(params).forEach((n) => inner.declare(n));
  for (const child of childrenOf(node)) {
    if (params !== null && child.id === params.id) emitPyParameters(child, inner, outer, em);
    else emitPy(child, inner, em);
  }
}

function emitPyComprehension(node: Node, outer: Scope, em: Emitter): void {
  const inner = new Scope(outer);
  for (const child of namedChildrenOf(node)) {
    if (child.type !== "for_in_clause") continue;
    const names: string[] = [];
    pyTargetNames(child.childForFieldName("left"), names);
    names.forEach((n) => inner.declare(n));
  }
  emitChildrenPy(node, inner, em);
}

function emitChildrenPy(node: Node, scope: Scope, em: Emitter): void {
  for (const child of childrenOf(node)) {
    if (child.type === ",") emitComma(node, em);
    else emitPy(child, scope, em);
  }
}

function emitPy(node: Node, scope: Scope, em: Emitter): void {
  switch (node.type) {
    case "comment":
    case "line_continuation":
      return;
    case "identifier":
      em.push(scope.resolve(node.text, em));
      return;
    case "integer":
    case "float":
      em.push(node.text.toLowerCase());
      return;
    case "string_start":
      em.push(`${node.text.replace(/['"]/g, "").toLowerCase()}"`);
      return;
    case "string_end":
      em.push('"');
      return;
    case "string_content":
    case "format_specifier":
      em.push(node.text);
      return;
    case "dotted_name":
    case "import_statement":
    case "import_from_statement":
    case "future_import_statement":
      emitVerbatim(node, em);
      return;
    case "attribute": {
      const object = node.childForFieldName("object");
      if (object !== null) emitPy(object, scope, em);
      em.push(".");
      em.push(node.childForFieldName("attribute")?.text ?? "");
      return;
    }
    case "keyword_argument": {
      em.push(node.childForFieldName("name")?.text ?? "");
      em.push("=");
      const value = node.childForFieldName("value");
      if (value !== null) emitPy(value, scope, em);
      return;
    }
    case "function_definition":
      emitPyFunction(node, scope, em);
      return;
    case "lambda":
      emitPyLambda(node, scope, em);
      return;
    case "class_definition":
      for (const child of childrenOf(node)) {
        if (child.type === "block") emitPyBlock(child, scope, em, true);
        else emitPy(child, scope, em);
      }
      return;
    case "parenthesized_expression": {
      const inner = namedChildrenOf(node).filter((c) => !isComment(c));
      if (inner.some((c) => PY_NON_EXPRESSION_INNER.has(c.type))) {
        emitChildrenPy(node, scope, em);
        return;
      }
      emitParenthesised(node, PY_PAREN_SAFE_PARENTS, PY_ATOMS, (child) => emitPy(child, scope, em));
      return;
    }
  }
  if (PY_COMPREHENSIONS.has(node.type)) {
    emitPyComprehension(node, scope, em);
    return;
  }
  if (node.childCount === 0) {
    em.push(node.text);
    return;
  }
  emitChildrenPy(node, scope, em);
}

// ------------------------------------------------------------------ Rust

const RS_PAREN_SAFE_PARENTS = new Set([
  "let_declaration",
  "return_expression",
  "expression_statement",
  "arguments",
  "block",
  "field_initializer",
  "match_arm",
  "parenthesized_expression",
]);
const RS_ATOMS = new Set([
  "identifier",
  "integer_literal",
  "float_literal",
  "string_literal",
  "boolean_literal",
  "self",
  "scoped_identifier",
  "call_expression",
  "field_expression",
  "index_expression",
  "parenthesized_expression",
]);

const RS_ATOMIC = new Set(["string_literal", "raw_string_literal", "char_literal"]);
const RS_VERBATIM = new Set([
  "scoped_identifier",
  "scoped_type_identifier",
  "use_declaration",
  "type_identifier",
  "primitive_type",
  "lifetime",
]);

function isDocAttribute(node: Node): boolean {
  const attribute = namedChildrenOf(node).find((c) => c.type === "attribute");
  return attribute?.namedChild(0)?.text === "doc";
}

function bindRust(name: string, scope: Scope, em: Emitter): void {
  const canonical = em.fresh();
  scope.names.set(name, canonical);
  em.push(canonical);
}

/** A leading capital means a constant or a variant, which a pattern tests and does not bind. */
function isRustBinding(name: string): boolean {
  return !/^[A-Z]/.test(name);
}

function emitRustPattern(node: Node, scope: Scope, em: Emitter): void {
  if (isComment(node)) return;
  switch (node.type) {
    case "identifier":
      if (isRustBinding(node.text)) bindRust(node.text, scope, em);
      else em.push(node.text);
      return;
    case "shorthand_field_identifier":
      em.push(node.text);
      em.push(":");
      bindRust(node.text, scope, em);
      return;
    case "tuple_struct_pattern":
    case "struct_pattern": {
      const type = node.childForFieldName("type");
      for (const child of childrenOf(node)) {
        if (type !== null && child.id === type.id) emitVerbatim(child, em);
        else if (child.type === ",") emitComma(node, em);
        else emitRustPattern(child, scope, em);
      }
      return;
    }
  }
  if (RS_ATOMIC.has(node.type) || RS_VERBATIM.has(node.type) || node.type === "field_identifier") {
    em.push(node.text);
    return;
  }
  if (node.childCount === 0) {
    em.push(node.text);
    return;
  }
  for (const child of childrenOf(node)) {
    if (child.type === ",") emitComma(node, em);
    else emitRustPattern(child, scope, em);
  }
}

/**
 * Emits `pattern = value` forms. The value is resolved first, so that the
 * right-hand side of `let x = x + 1;` still means the previous `x`.
 */
function emitRustBinding(node: Node, outer: Scope, bindInto: Scope, em: Emitter): void {
  const pattern = node.childForFieldName("pattern");
  const value = node.childForFieldName("value");
  const valueTokens = value !== null ? em.capture(() => emitRust(value, outer, em)) : [];
  for (const child of childrenOf(node)) {
    if (pattern !== null && child.id === pattern.id) emitRustPattern(child, bindInto, em);
    else if (value !== null && child.id === value.id) valueTokens.forEach((t) => em.push(t));
    else emitRust(child, bindInto, em);
  }
}

function emitRustMatchArm(node: Node, outer: Scope, em: Emitter): void {
  const inner = new Scope(outer);
  for (const child of childrenOf(node)) {
    if (child.type !== "match_pattern") {
      emitRust(child, inner, em);
      continue;
    }
    const condition = child.childForFieldName("condition");
    for (const part of childrenOf(child)) {
      if (condition !== null && part.id === condition.id) emitRust(part, inner, em);
      else if (part.type === "if") em.push("if");
      else emitRustPattern(part, inner, em);
    }
  }
}

function emitRustParameter(node: Node, scope: Scope, em: Emitter): void {
  const pattern = node.childForFieldName("pattern");
  for (const child of childrenOf(node)) {
    if (pattern !== null && child.id === pattern.id) emitRustPattern(child, scope, em);
    else emitRust(child, scope, em);
  }
}

function emitChildrenRust(node: Node, scope: Scope, em: Emitter): void {
  for (const child of childrenOf(node)) {
    if (child.type === ",") emitComma(node, em);
    else emitRust(child, scope, em);
  }
}

function emitRust(node: Node, scope: Scope, em: Emitter): void {
  if (isComment(node)) return;
  if (RS_ATOMIC.has(node.type) || RS_VERBATIM.has(node.type)) {
    if (RS_ATOMIC.has(node.type)) em.push(node.text);
    else emitVerbatim(node, em);
    return;
  }
  switch (node.type) {
    case "identifier":
      em.push(scope.resolve(node.text, em));
      return;
    case "integer_literal":
    case "float_literal":
      em.push(node.text.toLowerCase());
      return;
    case "attribute_item":
    case "inner_attribute_item":
      if (!isDocAttribute(node)) emitVerbatim(node, em);
      return;
    case "function_item": {
      const inner = new Scope(null);
      const name = node.childForFieldName("name");
      for (const child of childrenOf(node)) {
        if (name !== null && child.id === name.id) em.push(child.text);
        else emitRust(child, inner, em);
      }
      return;
    }
    case "parameter":
      emitRustParameter(node, scope, em);
      return;
    case "closure_expression":
      emitChildrenRust(node, new Scope(scope), em);
      return;
    case "closure_parameters":
      for (const child of childrenOf(node)) {
        if (child.type === "parameter") emitRustParameter(child, scope, em);
        else if (child.type === "|") em.push("|");
        else if (child.type === ",") emitComma(node, em);
        else emitRustPattern(child, scope, em);
      }
      return;
    case "let_declaration":
    case "let_condition":
      emitRustBinding(node, scope, scope, em);
      return;
    case "for_expression":
      emitRustBinding(node, scope, new Scope(scope), em);
      return;
    case "match_arm":
      emitRustMatchArm(node, scope, em);
      return;
    case "block":
    case "if_expression":
    case "while_expression":
      emitChildrenRust(node, new Scope(scope), em);
      return;
    case "shorthand_field_initializer": {
      const name = node.text;
      em.push(name);
      em.push(":");
      em.push(scope.resolve(name, em));
      return;
    }
    case "macro_invocation": {
      const macro = node.childForFieldName("macro");
      for (const child of childrenOf(node)) {
        if (macro !== null && child.id === macro.id) emitVerbatim(child, em);
        else emitRust(child, scope, em);
      }
      return;
    }
    case "parenthesized_expression":
      emitParenthesised(node, RS_PAREN_SAFE_PARENTS, RS_ATOMS, (child) => emitRust(child, scope, em));
      return;
  }
  if (node.childCount === 0) {
    em.push(node.text);
    return;
  }
  emitChildrenRust(node, scope, em);
}

// ------------------------------------------------------------------ API

/**
 * Canonical token text of a code span: no comments, whitespace or docstrings,
 * with parameters and locals renamed by order of first appearance.
 */
export function normaliseCode(node: Node, language: CodeLanguage): string {
  const em = new Emitter();
  const root = new Scope(null);
  if (language === "python") emitPy(node, root, em);
  else emitRust(node, root, em);
  return em.finish();
}

export function hashCode(node: Node, language: CodeLanguage): string {
  return sha256(normaliseCode(node, language));
}

export type TextLanguage = "markdown" | "latex" | "text";

function stripTextComments(text: string, language: TextLanguage): string {
  if (language === "markdown") return text.replace(/<!--[\s\S]*?-->/g, " ");
  if (language === "latex") return text.replace(/(^|[^\\])%.*$/gm, "$1");
  return text;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Normal form of prose: comments and layout ignored. */
export function normaliseText(text: string, language: TextLanguage = "text"): string {
  return collapseWhitespace(stripTextComments(text, language));
}

export function hashText(text: string, language: TextLanguage = "text"): string {
  return sha256(normaliseText(text, language));
}
