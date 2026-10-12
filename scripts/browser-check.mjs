import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { createApp } from "../server.js";
const item = {
  title: "Quarterly results",
  content: "Revenue rose 12% YoY.",
  summary: "Revenue rose 12% YoY.",
  growth: 12,
  category: "results",
  url: "https://example.com/results",
  published: new Date().toISOString(),
  source: "NSE",
  note: "Browser test fixture",
};
const app = createApp({
  dbPath: ":memory:",
  sources: {
    companyDirectory: async () => [
      { symbol: "INFY", name: "Infosys Limited", series: "EQ" },
    ],
    announcements: async () => [
      item,
      {
        ...item,
        title: "Trading window closure",
        content: "Routine notice",
        summary: "Routine notice",
        category: "filing",
        url: "https://example.com/routine",
      },
    ],
    news: async () => [],
  },
});
await app.directory();
app.server.listen(0, "127.0.0.1");
await once(app.server, "listening");
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const apiRequests = [];
  page.on("request", (request) => {
    if (/\/api\/(watchlist|status|items)(?:\?|$)/.test(request.url()))
      apiRequests.push(request.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page
    .getByPlaceholder("Search NSE companies by name or symbol…")
    .fill("Infosys");
  await page.getByRole("button", { name: "+ Follow", exact: true }).click();
  await page.getByRole("button", { name: /Refresh data/ }).click();
  await page
    .getByRole("heading", { name: "Quarterly results", exact: true })
    .waitFor();
  assert.match(await page.locator("#feed").innerText(), /12% YoY/);
  assert.doesNotMatch(
    await page.locator("#feed").innerText(),
    /Trading window/,
  );
  assert.equal(app.db.prepare("SELECT count(*) n FROM items").get().n, 1);
  // Wait beyond the former five-second interval to catch idle polling.
  await page.waitForTimeout(300);
  const idleCount = apiRequests.length;
  await page.waitForTimeout(6000);
  assert.equal(
    apiRequests.length,
    idleCount,
    "Idle dashboard must not poll its API",
  );
  // A collection started outside this browser (like the daily scheduler)
  // must still update the page through the persistent event connection.
  item.title = "Updated quarterly results";
  item.url = "https://example.com/new-results";
  await app.refresh("INFY");
  await page
    .getByRole("heading", { name: "Updated quarterly results", exact: true })
    .waitFor();
  await page.locator("#category").selectOption("press release");
  await page
    .getByRole("heading", { name: "Your next update will appear here." })
    .waitFor();
  await page.locator("#category").selectOption("");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.getByRole("button", { name: "Unfollow INFY" }).click();
  await page
    .getByRole("heading", { name: "Your companies, in focus." })
    .waitFor();
  assert.equal(
    (
      await page.request.get(
        `http://127.0.0.1:${app.server.address().port}/api/items`,
      )
    ).status(),
    200,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: importance retention, no idle polling, server-pushed updates, search, follow, refresh, filters and mobile layout.",
  );
} finally {
  await browser?.close();
  app.close();
}
