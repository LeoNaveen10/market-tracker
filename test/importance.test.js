import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importance } from "../importance.js";
import { openStore } from "../store.js";
const item = (title, extra = {}) => ({
  title,
  content: title,
  summary: title,
  source: "NSE",
  category: "filing",
  growth: null,
  url: "https://example.com/" + encodeURIComponent(title),
  published: "2026-10-12T00:00:00Z",
  note: "Fixture",
  ...extra,
});
test("keeps positive and negative business events, including generic exchange titles", () => {
  for (const title of [
    "Quarterly results",
    "Company declares dividend of Rs. 5 per share",
    "Company profit falls 20%",
    "Board approved a dividend of Rs. 5 per share",
    "Company acquired ABC Limited",
    "Company wins a 500 crore contract",
    "Chief financial officer resigns",
    "Credit rating downgraded to BB",
    "Company defaulted on loan payments",
    "Company cuts revenue guidance",
    "Company announces capacity expansion of 20%",
  ])
    assert.equal(importance(item(title)).important, true, title);
  assert.equal(
    importance(
      item("General Updates", {
        content:
          "The company has informed the Exchange about acquisition of ABC Limited.",
      }),
    ).important,
    true,
  );
});
test("discards routine wrappers even if attachments repeat results, plus unsupported promotional news", () => {
  for (const title of [
    "Closure of trading window",
    "Newspaper publication of financial results",
    "Voting results of AGM",
    "Compliance certificate",
    "Board meeting intimation",
    "Investor meeting schedule",
    "Duplicate share certificate",
  ])
    assert.equal(
      importance(
        item(title, {
          category: "results",
          content: "Revenue grew 15% year on year.",
        }),
      ).important,
      false,
      title,
    );
  assert.equal(
    importance(
      item("Updates", {
        category: "results",
        summary: "Report of auditors on financial statements with UDIN",
        content: "Report of auditors on financial statements with UDIN",
      }),
    ).important,
    false,
  );
  assert.equal(
    importance(
      item("Board meeting scheduled to consider financial results", {
        category: "results",
      }),
    ).important,
    false,
  );
  assert.equal(
    importance(
      item("Company launches an exciting campaign", {
        category: "news & research",
        content: "Other stories: Company acquired ABC Limited.",
      }),
    ).important,
    false,
  );
});
test("storage rejects unimportant updates; reimports cannot reintroduce them", () => {
  const s = openStore(":memory:");
  try {
    s.saveCompanies([{ symbol: "INFY", name: "Infosys", series: "EQ" }]);
    const rows = [item("Quarterly results"), item("Closure of trading window")];
    assert.deepEqual(s.saveItems("INFY", rows), { added: 1, skipped: 1 });
    assert.deepEqual(s.saveItems("INFY", rows), { added: 0, skipped: 1 });
    assert.deepEqual(
      s.db
        .prepare("SELECT title FROM items")
        .all()
        .map((r) => r.title),
      ["Quarterly results"],
    );
  } finally {
    s.db.close();
  }
});
test("upgrade permanently removes routine history once and preserves important records and watchlists", () => {
  const dir = mkdtempSync(join(tmpdir(), "importance-test-"));
  const path = join(dir, "db.sqlite");
  try {
    let s = openStore(path);
    s.saveCompanies([{ symbol: "INFY", name: "Infosys", series: "EQ" }]);
    s.saveItems("INFY", [item("Quarterly results")]);
    s.db
      .prepare("INSERT INTO watchlist(symbol,added_at) VALUES(?,?)")
      .run("INFY", "2026-10-12");
    s.db
      .prepare(
        "INSERT INTO items(id,symbol,title,content,category,source) VALUES(?,?,?,?,?,?)",
      )
      .run(
        "legacy",
        "INFY",
        "Trading window closure",
        "Notice",
        "filing",
        "NSE",
      );
    s.db.prepare("DELETE FROM metadata WHERE key='importance_policy'").run();
    s.db.close();
    s = openStore(path);
    assert.equal(s.db.prepare("SELECT count(*) n FROM items").get().n, 1);
    assert.equal(s.db.prepare("SELECT count(*) n FROM watchlist").get().n, 1);
    assert.equal(
      s.db
        .prepare(
          "SELECT value FROM metadata WHERE key='importance_cleanup_removed'",
        )
        .get().value,
      "1",
    );
    s.db.close();
    s = openStore(path);
    assert.equal(s.db.prepare("SELECT count(*) n FROM items").get().n, 1);
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
