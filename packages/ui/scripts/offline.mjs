// Runs the two delivery modes of the one file: npm run build && npm run offline
//  1. inlined snapshot over file:// with the network disabled;
//  2. served over http with a token, snapshot fetch and one live event.
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { demo, distFile, launch, VIEWPORTS } from "./harness.mjs";

const html = readFileSync(distFile, "utf8");
const browser = await launch();
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

// 1. Offline. This is the replacement `mathkeel export` must perform.
const payload = JSON.stringify(demo).replace(/</g, "\\u003c");
expect(html.includes("<!--mathkeel:snapshot-->"), "snapshot marker missing from the build");
const inlined = html.replace(
  "<!--mathkeel:snapshot-->",
  () => `<script>window.__MATHKEEL_SNAPSHOT__=${payload}</script>`,
);
const file = join(tmpdir(), `mathkeel-offline-${process.pid}.html`);
writeFileSync(file, inlined);

const offline = await browser.newContext({ viewport: VIEWPORTS.desktop, offline: true });
const page = await offline.newPage();
const external = [];
const errors = [];
page.on("request", (request) => {
  if (/^(https?|wss?):/.test(request.url())) external.push(request.url());
});
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(`${pathToFileURL(file).href}#/chain`);
await page.waitForSelector(".mark", { timeout: 20_000 });
await page.evaluate(() => document.fonts.ready);
const marks = await page.locator(".mark").count();
expect(marks === demo.nodes.length, `chart shows ${marks} of ${demo.nodes.length} marks`);
await page.evaluate(() => {
  window.location.hash = "#/node/dm.variance";
});
await page.waitForSelector(".katex-display");
await page.evaluate(() => document.fonts.ready);
const fonts = await page.evaluate(() => ({
  serif: document.fonts.check('16px "Source Serif"'),
  mono: document.fonts.check('13px "Source Code"'),
  math: document.fonts.check('16px "KaTeX_Main"'),
  loaded: [...document.fonts].filter((face) => face.status === "loaded").length,
}));
expect(fonts.serif && fonts.mono && fonts.math, `fonts did not load: ${JSON.stringify(fonts)}`);
expect(external.length === 0, `network requests: ${external.join(", ")}`);
expect(errors.length === 0, `console errors: ${errors.join(" | ")}`);
await offline.close();
rmSync(file);
console.log(`offline: ${marks} marks, ${fonts.loaded} font faces, ${external.length} network requests`);

// 2. Served, with the token rule of SPEC.md.
const TOKEN = "t0ken";
let stream = null;
const seen = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  seen.push(`${url.pathname}?token=${url.searchParams.get("token") ?? ""}`);
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html" }).end(html);
    return;
  }
  if (url.searchParams.get("token") !== TOKEN) {
    response.writeHead(401).end();
    return;
  }
  if (url.pathname === "/api/snapshot") {
    const body = stream ? { ...demo, repo: { ...demo.repo, name: "after-event" } } : demo;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  } else if (url.pathname === "/api/events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.write(": open\n\n");
    stream = response;
  } else {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const served = await browser.newContext({ viewport: VIEWPORTS.desktop });
const live = await served.newPage();
const serveErrors = [];
live.on("pageerror", (error) => serveErrors.push(error.message));
await live.goto(`http://127.0.0.1:${port}/?token=${TOKEN}#/inbox`);
await live.waitForSelector(".cause");
await live.waitForFunction(() => document.querySelector(".strip__link dd")?.textContent.startsWith("Live"));
expect(seen.includes(`/api/snapshot?token=${TOKEN}`), "snapshot request lost the token");
expect(seen.includes(`/api/events?token=${TOKEN}`), "event stream lost the token");
stream.write('data: {"type":"change"}\n\n');
await live.waitForFunction(() => document.querySelector(".titleblock__repo")?.textContent.startsWith("after-event"));
await live.goto(`http://127.0.0.1:${port}/?token=nope`);
await live.waitForSelector(".standby__title");
const denied = await live.locator(".standby__title").textContent();
expect(denied === "This chart needs its link", `token refusal shows: ${denied}`);
expect(serveErrors.length === 0, `served page errors: ${serveErrors.join(" | ")}`);
stream.end();
await served.close();
server.closeAllConnections();
server.close();
console.log("served: token sent, live event refreshed the page, refused token has its own page");

await browser.close();
console.log(`single file: ${(statSync(distFile).size / 1_048_576).toFixed(2)} MiB`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
