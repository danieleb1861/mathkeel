import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseContractMessage, runContract, runContracts } from "../src/contracts.js";
import { renderExport, inlineJson } from "../src/export.js";
import { lintMap, loadMap, writeMap } from "../src/mapio.js";
import { RepoFiles, isSensitivePath, toRepoPath } from "../src/repo.js";
import { resolveStaticPath, startServer, type RunningServer } from "../src/server.js";
import { buildSnapshot } from "../src/snapshot.js";
import type { Snapshot } from "../src/types.js";
import { commitAll, contract, frozenRepo, git, letEventLoopRun, makeRepo, node, PASSING, removeRepos, runCli, writeFiles } from "./helpers.js";

afterAll(removeRepos);
afterEach(letEventLoopRun);

const PY = "def f(a):\n    return a * 2\n";
const anchor = { path: "m.py", symbol: "f", quote: "", hash: null };

describe("contracts", () => {
  it("passes on exit 0 and reads the message", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    expect(await runContract(root, contract("c", PASSING))).toEqual({ id: "c", state: "pass", msg: "ok" });
  });

  it("fails on a non-zero exit, with or without a message", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    const noisy = 'console.log(JSON.stringify({msg:"too far"}));process.exit(3)';
    expect(await runContract(root, contract("c", noisy))).toEqual({ id: "c", state: "fail", msg: "too far" });
    expect(await runContract(root, contract("c", "process.exit(4)"))).toEqual({
      id: "c",
      state: "fail",
      msg: "exit code 4",
    });
  });

  it("kills a contract at its timeout", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    const start = Date.now();
    const result = await runContract(root, contract("c", "setTimeout(()=>{}, 60000)", 0.3));
    expect(result.state).toBe("fail");
    expect(result.msg).toContain("timed out");
    expect(Date.now() - start).toBeLessThan(10000);
  });

  it("uses no shell: metacharacters stay plain arguments", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    const marker = "pwned.txt";
    const c = {
      id: "c",
      kind: "literal" as const,
      command: [process.execPath, "-e", "console.log(JSON.stringify({msg:process.argv[1]}))", `x; echo hi > ${marker}`],
      timeout_s: 10,
    };
    const result = await runContract(root, c);
    expect(result.msg).toBe(`x; echo hi > ${marker}`);
    expect(existsSync(path.join(root, marker))).toBe(false);
  });

  it("reports a command that cannot start", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    const result = await runContract(root, { id: "c", kind: "numeric", command: ["no-such-binary-xyz"], timeout_s: 5 });
    expect(result.state).toBe("fail");
    expect(result.msg).toContain("could not start");
  });

  it("hides secret environment variables from a contract", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    process.env.MATHKEEL_TEST_SECRET = "hidden";
    process.env.MATHKEEL_TEST_PLAIN = "seen";
    const script =
      "console.log(JSON.stringify({msg:String(process.env.MATHKEEL_TEST_SECRET)+'/'+process.env.MATHKEEL_TEST_PLAIN}))";
    const result = await runContract(root, contract("c", script));
    delete process.env.MATHKEEL_TEST_SECRET;
    delete process.env.MATHKEEL_TEST_PLAIN;
    expect(result.msg).toBe("undefined/seen");
  });

  it("takes the last JSON line carrying a msg", () => {
    expect(parseContractMessage('noise\n{"msg":"first"}\n{"other":1}\n{"msg":"second"}\ntrailing\n')).toBe("second");
    expect(parseContractMessage('{"msg":5}\nnot json\n')).toBeNull();
  });

  it("runs each contract once in map order", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    const seen: string[] = [];
    const results = await runContracts(root, [contract("a", PASSING), contract("b", PASSING)], (r) => seen.push(r.id));
    expect(seen).toEqual(["a", "b"]);
    expect(results.size).toBe(2);
  });
});

describe("contracts never run outside an explicit check", () => {
  const MARK = "require('fs').writeFileSync('ran.marker','x')";

  async function repo(): Promise<string> {
    return frozenRepo({ "m.py": PY }, [node({ id: "n", code: [anchor], contracts: ["c"] })], [contract("c", MARK)]);
  }

  it("status, lint, impact, trace and export run nothing", async () => {
    const root = await repo();
    for (const args of [["status"], ["status", "--json"], ["map", "lint"], ["impact", "m.py"], ["trace", "n"], ["export", "x.html"]]) {
      runCli(root, ...args);
      expect(existsSync(path.join(root, "ran.marker"))).toBe(false);
    }
  });

  it("the server and its watcher run nothing", async () => {
    const root = await repo();
    const server = await startServer({ root, uiDir: null, pollMs: 50 });
    try {
      await fetch(`http://127.0.0.1:${server.port}/api/snapshot?token=${server.token}`);
      writeFiles(root, { "m.py": `${PY}# touched\n` });
      await new Promise((r) => setTimeout(r, 500));
      await fetch(`http://127.0.0.1:${server.port}/api/snapshot?token=${server.token}`);
    } finally {
      await server.close();
    }
    expect(existsSync(path.join(root, "ran.marker"))).toBe(false);
  });

  it("check without --yes and without a terminal refuses, after listing", async () => {
    const root = await repo();
    const result = runCli(root, "check");
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(process.execPath.replace(/\\/g, "\\\\"));
    expect(existsSync(path.join(root, "ran.marker"))).toBe(false);
  });

  it("check --yes lists the commands before it runs them", async () => {
    const root = await repo();
    const result = runCli(root, "check", "--yes");
    expect(result.stdout.indexOf("arbitrary code")).toBeLessThan(result.stdout.indexOf("pass "));
    expect(existsSync(path.join(root, "ran.marker"))).toBe(true);
  });

  it("only cli.ts imports the contract runner", () => {
    const src = path.resolve(__dirname, "..", "src");
    const importers = readdirSync(src).filter((f) => readFileSync(path.join(src, f), "utf8").includes('"./contracts.js"'));
    expect(importers).toEqual(["cli.ts"]);
  });

  it("git commands cannot start a program from the repository's local config", async () => {
    const root = makeRepo({ "m.py": PY });
    const marker = path.join(root, "fsmonitor.marker").replace(/\\/g, "/");
    const hook = path.join(root, "hook.js");
    writeFileSync(hook, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
    const config = path.join(root, ".git", "config");
    writeFileSync(config, `${readFileSync(config, "utf8")}\n[core]\n\tfsmonitor = node ${hook.replace(/\\/g, "/")}\n`);
    await expect(buildSnapshot(root).catch(() => null)).resolves.toBeDefined();
    expect(existsSync(marker)).toBe(false);
  });
});

describe("reading the target repository", () => {
  it("rejects paths that leave the repository", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "C:\\x", "..\\x", "a\0b", ""]) {
      expect(toRepoPath(bad)).toBeNull();
    }
    expect(toRepoPath(".\\src\\m.py")).toBe("src/m.py");
    expect(toRepoPath("src//m.py")).toBe("src/m.py");
  });

  it("knows sensitive names", () => {
    for (const bad of [".env", ".env.local", "config/.env", "id_rsa", "server.key", "a.pem", "credentials.json", ".ssh/config", "secrets.yaml", ".git/config"]) {
      expect(isSensitivePath(bad)).toBe(true);
    }
    for (const good of ["src/env.py", "environment.md", "keys.py", "README.md"]) {
      expect(isSensitivePath(good)).toBe(false);
    }
  });

  it("never reads .env, keys, credentials, binaries or ignored files, even if a map names them", async () => {
    const secret = "VALUE_MUST_NOT_LEAK";
    const root = makeRepo({
      ".gitignore": "private.md\n",
      ".env": `TOKEN=${secret}\n`,
      "deploy.key": `${secret}\n`,
      "credentials.json": `${secret}\n`,
      "data.bin": `${secret}\n`,
      "private.md": `${secret}\n`,
    });
    writeFiles(root, { "blob.txt": `abc\0${secret}\n` });
    const files = new RepoFiles(root);
    for (const rel of [".env", "deploy.key", "credentials.json", "data.bin", "private.md", "blob.txt", "../outside.txt"]) {
      expect(files.read(rel)).toBeNull();
    }
    expect(files.list()).not.toContain(".env");
  });

  it("does not leak a sensitive file through the snapshot", async () => {
    const secret = "VALUE_MUST_NOT_LEAK";
    const root = await frozenRepo({ "m.py": PY, "private.md": `${secret}\n` }, [node({ id: "n", code: [anchor] })]);
    writeFiles(root, { ".gitignore": "private.md\n" });
    git(root, "rm", "-q", "--cached", "private.md");
    commitAll(root);
    const map = loadMap(root);
    (map.nodes[0] as (typeof map.nodes)[number]).doc = { path: "private.md", symbol: null, quote: secret, hash: null };
    writeMap(root, map);
    const snapshot = await buildSnapshot(root);
    expect(snapshot.nodes[0]?.anchors[0]?.state).toBe("lost");
    expect(snapshot.nodes[0]?.anchors[0]?.after).toBeNull();
  });

  it("rejects a map anchor on a secret or outside the repository", async () => {
    const root = makeRepo({ "m.py": PY, ".env": "A=1\n" });
    mkdirSync(path.join(root, ".mathkeel"), { recursive: true });
    const write = (p: string): void => {
      writeFileSync(
        path.join(root, ".mathkeel", "map.json"),
        JSON.stringify({ schema: 1, nodes: [node({ id: "n", code: [{ path: p, symbol: null, quote: "x", hash: null }] })] }),
      );
    };
    write(".env");
    expect((await lintMap(root)).join()).toContain("sensitive");
    write("../outside.py");
    expect((await lintMap(root)).join()).toContain("leaves the repository");
    expect(runCli(root, "status").code).toBe(2);
  });

  it("does not follow a symlink out of the repository", () => {
    const root = makeRepo({ "a.txt": "x\n" });
    const outside = path.join(tmpdir(), `mathkeel-outside-${process.pid}.txt`);
    writeFileSync(outside, "outside\n");
    try {
      symlinkSync(outside, path.join(root, "link.md"));
    } catch {
      return; // Creating a symlink needs a privilege Windows may withhold.
    }
    expect(new RepoFiles(root).read("link.md")).toBeNull();
  });

  it("treats a map id with shell syntax as a schema error", () => {
    const root = makeRepo({ "a.txt": "x\n" });
    mkdirSync(path.join(root, ".mathkeel"), { recursive: true });
    writeFileSync(path.join(root, ".mathkeel", "map.json"), JSON.stringify({ nodes: [node({ id: "a; rm -rf /" })] }));
    const result = runCli(root, "status");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("id may hold");
  });

  it("strips escape sequences from repository text on the terminal", async () => {
    const root = await frozenRepo({ "m.py": PY }, [node({ id: "n", title: "bad\u001b[31mtitle", code: [anchor] })]);
    writeFiles(root, { "m.py": PY.replace("a * 2", "a * 3") });
    const output = runCli(root, "status").stdout;
    expect(output).not.toContain("\u001b");
    expect(output).toContain("bad?[31mtitle");
  });
});

/** Keeps one read pending across timeouts: a second read would lose what the first receives. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let pending = reader.read();
  const deadline = Date.now() + 15000;
  while (!text.includes(needle) && Date.now() < deadline) {
    const next = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 500))]);
    if (next === null) continue;
    if (next.value !== undefined) text += decoder.decode(next.value);
    if (next.done) break;
    pending = reader.read();
  }
  pending.catch(() => undefined);
  return text;
}

describe("server", () => {
  async function serving(uiDir: string | null = null): Promise<{ root: string; server: RunningServer }> {
    const root = await frozenRepo({ "m.py": PY }, [node({ id: "n", code: [anchor] })]);
    return { root, server: await startServer({ root, uiDir, pollMs: 50 }) };
  }

  /** A raw request, so that the path reaches the server exactly as written. */
  function raw(port: number, target: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: target, method, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("binds 127.0.0.1 and prints a tokenised URL", async () => {
    const { server } = await serving();
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/);
    } finally {
      await server.close();
    }
  });

  it("needs the token on every endpoint", async () => {
    const { server } = await serving();
    try {
      for (const target of ["/", "/api/snapshot", "/api/events", "/index.html", "/x.js"]) {
        expect((await raw(server.port, target)).status).toBe(401);
        expect((await raw(server.port, `${target}?token=wrong`)).status).toBe(401);
      }
      const ok = await raw(server.port, `/api/snapshot?token=${server.token}`);
      expect(ok.status).toBe(200);
      expect((JSON.parse(ok.body) as Snapshot).schema).toBe(1);
      const bearer = await raw(server.port, "/api/snapshot", { authorization: `Bearer ${server.token}` });
      expect(bearer.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("is read-only and refuses foreign hosts and origins", async () => {
    const { server } = await serving();
    const target = `/api/snapshot?token=${server.token}`;
    try {
      expect((await raw(server.port, target, {}, "POST")).status).toBe(405);
      expect((await raw(server.port, target, { host: "evil.example" })).status).toBe(403);
      expect((await raw(server.port, target, { origin: "http://evil.example" })).status).toBe(403);
      const same = { origin: `http://127.0.0.1:${server.port}` };
      expect((await raw(server.port, target, same)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("says plainly when the UI is not built", async () => {
    const { server } = await serving(null);
    try {
      const page = await raw(server.port, `/?token=${server.token}`);
      expect(page.status).toBe(200);
      expect(page.body).toContain("The UI is not built");
    } finally {
      await server.close();
    }
  });

  it("serves the built UI and sets a cookie for its assets", async () => {
    const root = makeRepo({ "a.txt": "x\n" });
    const ui = path.join(root, "ui-dist");
    writeFiles(root, { "ui-dist/index.html": "<!doctype html><script>let a=1</script><h1>built</h1>", "ui-dist/app.js": "1;\n" });
    writeMapEmpty(root);
    const server = await startServer({ root, uiDir: ui });
    try {
      const page = await fetch(`http://127.0.0.1:${server.port}/?token=${server.token}`);
      expect(await page.text()).toContain("built");
      expect(page.headers.get("content-security-policy")).toContain("'sha256-");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(page.headers.get("set-cookie")).toContain("HttpOnly");
      const asset = await raw(server.port, "/app.js", { cookie });
      expect(asset.status).toBe(200);
      expect((await raw(server.port, "/app.js", { cookie: "other=1" })).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("prevents path traversal, however it is encoded", async () => {
    const root = makeRepo({ "secret.txt": "TOP\n" });
    writeFiles(root, { "site/index.html": "<h1>ui</h1>", "site/a.js": "1\n" });
    writeMapEmpty(root);
    const ui = path.join(root, "site");
    const server = await startServer({ root, uiDir: ui });
    try {
      const attacks = [
        "/../secret.txt",
        "/..%2fsecret.txt",
        "/%2e%2e/secret.txt",
        "/%2e%2e%2fsecret.txt",
        "/..%5csecret.txt",
        "/a.js/../../secret.txt",
        "/....//secret.txt",
        "/%00.js",
        "/.git/config.js",
        "/%ff.js",
      ];
      for (const attack of attacks) {
        const separator = attack.includes("?") ? "&" : "?";
        const result = await raw(server.port, `${attack}${separator}token=${server.token}`);
        expect(result.body).not.toContain("TOP");
      }
      expect(resolveStaticPath(ui, "/../secret.txt")).toBeNull();
      expect(resolveStaticPath(ui, "/..%2fsecret.txt")).toBeNull();
      expect(resolveStaticPath(ui, "/%2e%2e%5csecret.txt")).toBeNull();
      expect(resolveStaticPath(ui, "/a.js")).not.toBeNull();
    } finally {
      await server.close();
    }
  });

  it("pushes an event when a check result is stored by another process", async () => {
    const root = await frozenRepo({ "m.py": PY }, [node({ id: "n", code: [anchor], contracts: ["c"] })], [
      contract("c", "process.exit(1)"),
    ]);
    const server = await startServer({ root, uiDir: null, pollMs: 50 });
    const controller = new AbortController();
    try {
      const api = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${api}/api/events?token=${server.token}`, { signal: controller.signal });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await new Promise((r) => setTimeout(r, 700));
      expect(runCli(root, "check", "--yes").code).toBe(1);
      const text = await readUntil(reader, "event: change");
      expect(text).toContain("event: change");
      const snapshot = (await (await fetch(`${api}/api/snapshot?token=${server.token}`)).json()) as Snapshot;
      expect(snapshot.contractsRun).toBe(true);
      expect(snapshot.nodes[0]?.class).toBe("alert");
    } finally {
      controller.abort();
      await server.close();
    }
  });

  it("pushes an event when a mapped file changes", async () => {
    const { root, server } = await serving();
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/events?token=${server.token}`, {
        signal: controller.signal,
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await new Promise((r) => setTimeout(r, 700));
      writeFiles(root, { "m.py": PY.replace("a * 2", "a * 3") });
      const text = await readUntil(reader, "event: change");
      expect(text).toContain("event: change");
      const after = (await (await fetch(`http://127.0.0.1:${server.port}/api/snapshot?token=${server.token}`)).json()) as Snapshot;
      expect(after.nodes[0]?.class).toBe("queue");
    } finally {
      controller.abort();
      await server.close();
    }
  });
});

function writeMapEmpty(root: string): void {
  writeMap(root, { schema: 1, baseline: null, chains: [], contracts: [], nodes: [], inventory: {} });
}

describe("export", () => {
  const snapshot = (title: string): Snapshot =>
    ({
      schema: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      repo: { name: "r", head: "abc", dirty: false, baseline: "abc" },
      contractsRun: false,
      summary: { fresh: 1, queue: 0, alert: 0, review: 0, gaps: 0, unchartedShare: 0 },
      chains: [],
      nodes: [{ ...node({ id: "n", title }), class: "fresh", reasons: [], anchors: [], contractResults: [], upstreamChanged: [], verdict: null }],
      gaps: [],
      uncharted: [],
      activity: [],
      decisions: [],
    }) as Snapshot;

  it("inlines the snapshot so that repository text cannot close the script", () => {
    const hostile = "</script><script>alert(1)</script> $& \u2028";
    const root = makeRepo({ "a.txt": "x\n" });
    writeFiles(root, { "ui/index.html": '<html><head><script type="module">run()</script></head><body></body></html>' });
    const html = renderExport(snapshot(hostile), path.join(root, "ui"));
    expect(html).not.toContain("</script><script>alert(1)");
    const inlined = /window\.__MATHKEEL_SNAPSHOT__=(.*?);<\/script>/s.exec(html)?.[1] ?? "";
    expect((JSON.parse(inlined) as Snapshot).nodes[0]?.title).toBe(hostile);
    expect(html.indexOf("__MATHKEEL_SNAPSHOT__")).toBeLessThan(html.indexOf("run()"));
  });

  it("folds separate assets into one file", () => {
    const root = makeRepo({ "a.txt": "x\n" });
    writeFiles(root, {
      "ui/index.html":
        '<html><head><link rel="stylesheet" href="./assets/a.css"><link rel="modulepreload" href="./assets/m.js">' +
        '<script type="module" crossorigin src="./assets/a.js"></script></head><body></body></html>',
      "ui/assets/a.js": 'const s = "$& </script>";\n',
      "ui/assets/a.css": "@font-face{src:url(./f.woff2)}",
      "ui/assets/f.woff2": "font",
    });
    const html = renderExport(snapshot("t"), path.join(root, "ui"));
    expect(html).not.toMatch(/src=|href=/);
    expect(html).toContain('const s = "$& <\\/script>"');
    expect(html).toContain("data:font/woff2;base64,");
  });

  it("escapes a plain report when the UI is not built", () => {
    const html = renderExport(snapshot("<b>x</b>"), null);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("The UI was not built");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("escapes every character that could end a script", () => {
    expect(inlineJson({ a: "<>&\u2028\u2029" })).not.toMatch(/[<>&\u2028\u2029]/);
  });
});
