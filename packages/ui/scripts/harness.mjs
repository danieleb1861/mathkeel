// Shared by the browser checks: opens the production file with a chosen state.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { stateFor } from "../fixtures/states.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const uiRoot = join(here, "..");
export const distFile = join(uiRoot, "dist", "index.html");
export const demo = JSON.parse(readFileSync(join(uiRoot, "fixtures", "demo.snapshot.json"), "utf8"));

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 375, height: 812 },
};

export const launch = () => chromium.launch();

/** A page with console, error and network watchers, loading dist/index.html. */
export async function openState(browser, { state = "demo", theme = "day", viewport, hash = "#/chain", snapshot }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: viewport.width < 500 ? 2 : 1.5,
    colorScheme: theme === "night" ? "dark" : "light",
    hasTouch: viewport.width < 500,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("file:") && !url.startsWith("data:") && !url.startsWith("blob:")) {
      problems.push(`network: ${url}`);
    }
  });
  const payload = snapshot ?? stateFor(state, demo);
  await page.addInitScript((value) => {
    window.__MATHKEEL_SNAPSHOT__ = value;
  }, payload);
  await page.goto(`${pathToFileURL(distFile).href}${hash}`);
  await page.waitForFunction(() => document.fonts.status === "loaded");
  return { context, page, problems };
}

/** Waits for the chain chart, if this page has one, to finish its layout. */
export async function settle(page) {
  await page.waitForFunction(
    () => !document.querySelector(".chart__laying") && document.querySelector(".instrument, .standby"),
  );
  await page.waitForTimeout(350);
}

/** True when the page itself scrolls sideways. */
export async function sideScroll(page) {
  return page.evaluate(() => {
    // The frame clips rather than scrolls, so measure what it would have to clip.
    const root = document.documentElement;
    const shell = document.querySelector(".instrument") ?? root;
    const scrollWidth = Math.max(root.scrollWidth, shell.scrollWidth);
    return { scrollWidth, clientWidth: root.clientWidth, overflow: scrollWidth > root.clientWidth };
  });
}
