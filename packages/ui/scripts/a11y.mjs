// axe on the production build, contrast included: npm run build && npm run a11y
import { AxeBuilder } from "@axe-core/playwright";
import { launch, openState, settle, VIEWPORTS } from "./harness.mjs";

const PAGES = [
  { name: "chain", hash: "#/chain" },
  { name: "chain-selected", hash: "#/chain/dm.variance" },
  { name: "inbox", hash: "#/inbox" },
  { name: "inspector", hash: "#/node/dm.variance" },
  { name: "pinned", hash: "#/node/dm.hln" },
  { name: "empty", hash: "#/chain", state: "empty" },
];

const browser = await launch();
let total = 0;
let checked = 0;

for (const theme of ["day", "night"]) {
  for (const [device, viewport] of Object.entries(VIEWPORTS)) {
    for (const { name, hash, state } of PAGES) {
      const { context, page } = await openState(browser, { theme, viewport, hash, state });
      await settle(page);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
        .analyze();
      checked += 1;
      for (const violation of results.violations) {
        total += violation.nodes.length;
        console.log(`${name}/${theme}/${device}: ${violation.id} (${violation.nodes.length})`);
        for (const node of violation.nodes.slice(0, 2)) {
          console.log(`  ${node.target.join(" ")}: ${node.failureSummary?.split("\n")[1]?.trim() ?? ""}`);
        }
      }
      await context.close();
    }
  }
}

await browser.close();
console.log(`${checked} pages checked, ${total} violations`);
if (total > 0) process.exitCode = 1;
