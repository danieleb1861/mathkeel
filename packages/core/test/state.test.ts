import { afterAll, describe, expect, it } from "vitest";
import { treeKey } from "../src/state.js";
import type { MapFile } from "../src/types.js";
import { makeRepo, removeRepos, writeFiles } from "./helpers.js";

afterAll(removeRepos);

describe("treeKey", () => {
  const map = { contracts: [] } as unknown as MapFile;

  it("ignores stored state when the repository does not ignore it", () => {
    const root = makeRepo({ "a.py": "x = 1\n" });
    const before = treeKey(root, map);

    writeFiles(root, { ".mathkeel/state/last-check.json": "{}\n" });

    expect(treeKey(root, map)).toBe(before);
  });

  it("changes with a source file", () => {
    const root = makeRepo({ "a.py": "x = 1\n" });
    const before = treeKey(root, map);

    writeFiles(root, { "a.py": "x = 2\n" });

    expect(treeKey(root, map)).not.toBe(before);
  });
});
