import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;

const SENSITIVE_NAME =
  /^(\.env(\..*)?|.*\.env|\.envrc|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials?(\..*)?|secrets?(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|asc|gpg))$/i;
const SENSITIVE_DIR = /^(\.git|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker)$/i;
const BINARY_EXTENSION =
  /\.(png|jpe?g|gif|bmp|webp|ico|pdf|zip|gz|bz2|xz|tar|7z|rar|npy|npz|pt|pth|ckpt|h5|hdf5|parquet|feather|arrow|pkl|pickle|joblib|db|sqlite3?|mat|bin|dat|exe|dll|so|dylib|wasm|class|o|a|lib|onnx|safetensors|xlsx?|docx?|pptx?|woff2?|ttf|otf|mp[34]|wav|avi|mov)$/i;

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/**
 * Runs git without a shell. The overrides stop a repository's local git config
 * from starting a program during a read-only command.
 */
function gitRaw(root: string, args: string[]): Buffer {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args], {
    cwd: root,
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

export function git(root: string, args: string[]): string {
  return gitRaw(root, args).toString("utf8");
}

/** As `git`, returning null instead of throwing. */
export function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

export function findRepoRoot(cwd: string): string {
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null) throw new UsageError("mathkeel needs a git repository; run it inside one");
  return realpathSync(top.trim());
}

export function headCommit(root: string): string {
  return tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() ?? "";
}

/** Paths git sees as changed, untracked included. A rename counts as its new path. */
export function changedPaths(root: string): { path: string; entry: string }[] {
  const fields = (tryGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "").split("\0");
  const changed: { path: string; entry: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry === "") continue;
    changed.push({ path: entry.slice(3), entry });
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return changed;
}

/** Repo-relative forward-slash form of a path, or null when it leaves the repository. */
export function toRepoPath(raw: string): string | null {
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.includes("\0") || slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const parts = slashed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  return parts.join("/");
}

export function isSensitivePath(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";
  return SENSITIVE_NAME.test(base) || parts.slice(0, -1).some((p) => SENSITIVE_DIR.test(p));
}

export function isBinaryPath(rel: string): boolean {
  return BINARY_EXTENSION.test(rel);
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** LF endings and no BOM, so that a file hashes the same on every platform. */
export function normaliseNewlines(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Decoded text of a readable file, or null for anything the engine must not read. */
function decode(bytes: Buffer): string | null {
  if (bytes.length > MAX_FILE_BYTES || looksBinary(bytes)) return null;
  return normaliseNewlines(bytes.toString("utf8"));
}

/** Every file git would track, minus ignored, sensitive and binary files. */
export function listRepoFiles(root: string): string[] {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const files = new Set<string>();
  for (const rel of out.split("\0")) {
    if (rel !== "" && !isSensitivePath(rel) && !isBinaryPath(rel)) files.add(rel);
  }
  return [...files].sort();
}

/**
 * The only way the engine reads target-repository text. It sees the working
 * tree, or one commit when `commit` is given. Anything outside the visible file
 * list reads as absent, so a map cannot reach ignored files, secrets, or a path
 * outside the repository.
 */
export class RepoFiles {
  private visible: Set<string> | null = null;
  private readonly cache = new Map<string, string | null>();

  constructor(
    readonly root: string,
    readonly commit: string | null = null,
  ) {}

  private files(): Set<string> {
    if (this.visible === null) {
      if (this.commit === null) {
        this.visible = new Set(listRepoFiles(this.root));
      } else {
        const listed = tryGit(this.root, ["ls-tree", "-r", "-z", "--name-only", this.commit]) ?? "";
        this.visible = new Set(
          listed.split("\0").filter((f) => f !== "" && !isSensitivePath(f) && !isBinaryPath(f)),
        );
      }
    }
    return this.visible;
  }

  list(): string[] {
    return [...this.files()].sort();
  }

  has(raw: string): boolean {
    const rel = toRepoPath(raw);
    return rel !== null && this.files().has(rel);
  }

  read(raw: string): string | null {
    const rel = toRepoPath(raw);
    if (rel === null) return null;
    if (this.cache.has(rel)) return this.cache.get(rel) ?? null;
    const text = this.files().has(rel) ? this.load(rel) : null;
    this.cache.set(rel, text);
    return text;
  }

  private load(rel: string): string | null {
    try {
      if (this.commit !== null) return decode(gitRaw(this.root, ["show", `${this.commit}:${rel}`]));
      const full = path.join(this.root, ...rel.split("/"));
      const real = realpathSync(full);
      const inside = path.relative(this.root, real);
      if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
      const stat = lstatSync(real);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      return decode(readFileSync(real));
    } catch {
      return null;
    }
  }
}
