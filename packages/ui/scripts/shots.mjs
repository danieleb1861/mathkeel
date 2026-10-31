// Real screenshots of the production build: npm run build && npm run shots
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, openState, settle, sideScroll, uiRoot, VIEWPORTS } from "./harness.mjs";

const out = join(uiRoot, "screenshots");
mkdirSync(out, { recursive: true });

const VIEWS = [
  { name: "chain", hash: "#/chain" },
  { name: "chain-selected", hash: "#/chain/dm.variance", only: "desktop" },
  { name: "inbox", hash: "#/inbox" },
  { name: "inspector", hash: "#/node/dm.variance" },
  { name: "inspector-pinned", hash: "#/node/dm.hln", only: "desktop" },
];
const STATES = [
  { state: "empty", hash: "#/chain" },
  { state: "huge", hash: "#/chain" },
];

const filter = process.argv[2] ?? "";
const browser = await launch();
const failures = [];

async function shoot(label, options) {
  if (filter && !label.includes(filter)) return;
  const { context, page, problems } = await openState(browser, options);
  await settle(page);
  await page.screenshot({ path: join(out, `${label}.png`) });
  const scroll = await sideScroll(page);
  if (scroll.overflow) failures.push(`${label}: page scrolls sideways (${scroll.scrollWidth} > ${scroll.clientWidth})`);
  for (const problem of problems) failures.push(`${label}: ${problem}`);
  await context.close();
  console.log("shot", label);
}

for (const theme of ["day", "night"]) {
  for (const [device, viewport] of Object.entries(VIEWPORTS)) {
    // One phone pass, in the day theme.
    if (device === "phone" && theme === "night") continue;
    for (const view of VIEWS) {
      if (view.only && view.only !== device) continue;
      await shoot(`${view.name}-${theme}-${device}`, { theme, viewport, hash: view.hash });
    }
    for (const { state, hash } of STATES) {
      await shoot(`state-${state}-${theme}-${device}`, { state, theme, viewport, hash });
    }
  }
}

await browser.close();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("no console errors, no sideways page scroll");
}
