// Bundles the CLI into one file and copies only the wasm it needs into dist/wasm.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(packageDir, "dist");
const wasmOut = path.join(dist, "wasm");
const require = createRequire(path.join(packageDir, "package.json"));

function copyWasm() {
  mkdirSync(wasmOut, { recursive: true });
  const grammars = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
  const loader = path.dirname(require.resolve("web-tree-sitter"));
  const sources = [
    path.join(grammars, "tree-sitter-python.wasm"),
    path.join(grammars, "tree-sitter-rust.wasm"),
    path.join(loader, "tree-sitter.wasm"),
  ];
  for (const source of sources) copyFileSync(source, path.join(wasmOut, path.basename(source)));
}

rmSync(dist, { recursive: true, force: true });
copyWasm();
await build({
  entryPoints: [path.join(packageDir, "src", "cli.ts")],
  outfile: path.join(dist, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __mathkeelRequire } from "node:module";',
      "const require = __mathkeelRequire(import.meta.url);",
    ].join("\n"),
  },
});
const size = statSync(path.join(dist, "cli.js")).size;
process.stdout.write(`dist/cli.js ${(size / 1024).toFixed(0)} KiB\n`);
