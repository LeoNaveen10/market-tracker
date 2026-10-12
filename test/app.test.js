import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";
import {
  parseCompanies,
  parseNews,
  summarize,
  salesGrowth,
} from "../sources.js";
import { openStore } from "../store.js";
test("NSE directory preserves quoted company names and special symbols", () => {
  assert.deepEqual(
    parseCompanies(
      'SYMBOL,NAME OF COMPANY,SERIES\nM&M,"Mahindra, Limited",EQ\n',
    ),
    [{ symbol: "M&M", name: "Mahindra, Limited", series: "EQ" }],
  );
  assert.throws(() => parseCompanies("wrong,format\n"));
});
test("RSS extracts source attribution, dates and plain summary", () => {
  const rows = parseNews(
    '<rss><channel><item><title>Results &amp; growth</title><description>&lt;b&gt;Revenue rose 12% YoY.&lt;/b&gt;</description><link>https://example.com/news</link><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate><source url="https://example.com">Publisher</source></item></channel></rss>',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "Publisher");
  assert.equal(rows[0].summary, "Revenue rose 12% YoY.");
  assert.equal(salesGrowth(rows[0].summary), 12);
  assert.equal(salesGrowth("Revenue: 500. Profit growth 20%."), null);
  assert.equal(summarize("One. Two. Three. Four."), "One. Two. Three.");
});
test("watchlist refresh, one-year backfill, deduplication, history retention and error status", async () => {
  const calls = [];
  let fail = false;
  const item = {
    title: "Quarterly results",
    content: "Revenue rose 12% YoY.",
    summary: "Revenue rose 12% YoY.",
    growth: 12,
    category: "results",
    url: "https://example.com/result",
    published: "2026-10-10T00:00:00.000Z",
    source: "NSE",
    note: "Test source",
  };
  const app = createApp({
    dbPath: ":memory:",
    sources: {
      companyDirectory: async () => [
        { symbol: "M&M", name: "Mahindra Limited", series: "EQ" },
      ],
      announcements: async (c, since) => {
        calls.push(since);
        if (fail) throw new Error("Source denied access");
        return [item];
      },
      news: async () => [],
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (p, method = "GET") => {
    const r = await fetch(base + p, { method });
    return { status: r.status, data: await r.json() };
  };
  try {
    await app.directory();
    assert.equal((await request("/api/companies?q=Mahindra")).data.length, 1);
    assert.equal((await request("/api/watchlist/M%26M", "POST")).status, 201);
    await app.refresh();
    assert.ok(
      Math.abs(Date.now() - calls[0].getTime() - 365 * 86400000) < 5000,
    );
    assert.equal((await request("/api/items")).data.length, 1);
    await app.refresh();
    assert.equal((await request("/api/items")).data.length, 1);
    fail = true;
    await app.refresh();
    const status = (await request("/api/status")).data;
    assert.equal(status.runs.find((r) => r.source === "NSE").status, "failed");
    assert.equal(
      status.runs.find((r) => r.source === "NSE").error,
      "Source denied access",
    );
    assert.equal(
      (await request("/api/refresh?symbol=UNKNOWN", "POST")).status,
      404,
    );
    await request("/api/watchlist/M%26M", "DELETE");
    assert.equal((await request("/api/watchlist")).data.length, 0);
    assert.equal((await request("/api/items?symbol=M%26M")).data.length, 1);
    const home = await fetch(base);
    assert.match(await home.text(), /Your companies, in focus/);
    const blocked = await fetch(base + "/api/directory/refresh", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(blocked.status, 403);
  } finally {
    app.close();
  }
});
test("historical items and watchlists survive reopening SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-test-"));
  const path = join(dir, "test.db");
  try {
    let s = openStore(path);
    s.saveCompanies([{ symbol: "INFY", name: "Infosys", series: "EQ" }]);
    s.db
      .prepare("INSERT INTO watchlist(symbol,added_at) VALUES(?,?)")
      .run("INFY", new Date().toISOString());
    s.saveItems("INFY", [
      {
        title: "Result",
        content: "text",
        summary: "text",
        growth: null,
        category: "results",
        url: "https://example.com",
        published: new Date().toISOString(),
        source: "NSE",
        note: "extract",
      },
    ]);
    s.db.close();
    s = openStore(path);
    assert.equal(s.db.prepare("SELECT count(*) n FROM items").get().n, 1);
    assert.equal(s.db.prepare("SELECT count(*) n FROM watchlist").get().n, 1);
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("financial XBRL uses quarterly INR facts and excludes cumulative values", async () => {
  const { parseFinancialXbrl, classifyAnnouncement, nseDate } =
    await import("../sources.js");
  const xml =
    '<xbrl><context id="OneD"><period><startDate>2025-10-01</startDate><endDate>2025-12-31</endDate></period></context><RevenueFromOperations contextRef="OneD" unitRef="INR">349150000000</RevenueFromOperations><RevenueFromOperations contextRef="FourD" unitRef="INR">1024550000000</RevenueFromOperations><ProfitLossForPeriod contextRef="OneD" unitRef="INR">63580000000</ProfitLossForPeriod></xbrl>';
  const record = { fromDate: "01-Oct-2025", toDate: "31-Dec-2025" };
  const facts = parseFinancialXbrl(xml, record);
  assert.equal(facts.revenue, 349150000000);
  assert.equal(facts.profit, 63580000000);
  assert.throws(
    () =>
      parseFinancialXbrl(xml, {
        fromDate: "01-Apr-2025",
        toDate: "31-Dec-2025",
      }),
    /period/,
  );
  assert.equal(
    classifyAnnouncement("Shareholders meeting", "Voting results of AGM"),
    "filing",
  );
  assert.equal(
    classifyAnnouncement(
      "Outcome of Board Meeting",
      "quarterly financial results",
    ),
    "results",
  );
  assert.equal(
    nseDate("12-Oct-2026 10:00:00").toISOString(),
    "2026-10-12T04:30:00.000Z",
  );
});
