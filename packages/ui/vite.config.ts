import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vitest/config";

/**
 * The build is one self-contained file, so the engine can serve it and
 * `mathkeel export` can inline a snapshot into it. The policy below makes the
 * "no network at runtime" boundary enforced by the browser, not just promised.
 * Dev mode skips it because Vite's module graph and HMR socket need more.
 */
const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data:",
  "connect-src 'self'",
  "worker-src blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentPolicy(): Plugin {
  return {
    name: "mathkeel-content-policy",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace(
        "<!--mathkeel:policy-->",
        `<meta http-equiv="Content-Security-Policy" content="${POLICY}" />`,
      ),
  };
}

/** KaTeX ships woff2, woff and ttf. Every browser here reads woff2. */
function katexWoff2Only(): Plugin {
  return {
    name: "mathkeel-katex-woff2",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0]?.endsWith("katex.min.css")) return null;
      return code.replace(/,url\([^)]*\.(woff|ttf)\) format\("(woff|truetype)"\)/g, "");
    },
  };
}

export default defineConfig({
  plugins: [react(), katexWoff2Only(), contentPolicy(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: "es2022",
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8_000,
    reportCompressedSize: false,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
