import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { analyseCode } from "../src/symbols.js";

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("no network at runtime", () => {
  it("loads the grammars from local files, with fetch unavailable", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    for (const [language, text] of [
      ["python", "def f():\n    pass\n"],
      ["rust", "fn f() {}\n"],
    ] as const) {
      const parsed = await analyseCode(language, text, "m");
      expect(parsed.lookup("f")).toHaveLength(1);
      parsed.dispose();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses no network client in the engine source", () => {
    const src = path.resolve(__dirname, "..", "src");
    for (const file of readdirSync(src)) {
      const text = readFileSync(path.join(src, file), "utf8");
      expect(text, file).not.toMatch(/\bfetch\(|https?\.request|node:https|node:dgram|node:dns|node:tls/);
      if (file !== "server.ts") expect(text, file).not.toMatch(/node:http|node:net/);
    }
  });
});
