import test from "node:test";
import assert from "node:assert/strict";
import { extractHighlights, presentItem } from "../highlights.js";
test("filing highlights exclude cover letters and select business outcomes", () => {
  const text = `TO ALL STOCK EXCHANGES\nBSE LIMITED\nDear Sir/Madam,\nPlease find enclosed our press release.\nRevenue grew 12.5% year on year to Rs. 500 crore. Net profit increased 8% to 60 crore. The board approved a dividend of Rs. 5 per share.\nThis is for your information and records.\nThanking you.`;
  const points = extractHighlights(text);
  assert.equal(points.length, 3);
  assert.match(points[0], /12.5%/);
  assert.match(points[2], /dividend/);
  assert.doesNotMatch(points.join(" "), /enclosed|Dear|EXCHANGES|records/);
});
test("highlights preserve negative facts, deduplicate and cap at three", () => {
  const points = extractHighlights(
    "Sales declined 15% year on year. Sales declined 15% year on year. Net profit fell to 25 crore. The board approved a 10 crore investment. The company launched a new product.",
  );
  assert.equal(points.length, 3);
  assert.equal(points.filter((p) => p.includes("declined")).length, 1);
  assert.match(points[0], /declined 15%/);
});
test("unextractable or administrative filings do not fabricate highlights", () => {
  assert.deepEqual(
    extractHighlights(
      "Please find enclosed the attachment. This is for your information.",
    ),
    [],
  );
  const item = presentItem({
    source: "NSE",
    title: "General Updates",
    content: "Unreadable scan",
    summary: "old boilerplate",
  });
  assert.match(item.summary, /could not be reliably extracted/);
  assert.equal("content" in item, false);
});
test("previously saved source content is presented as highlights without deleting history", () => {
  const stored = {
    source: "NSE",
    title: "Results",
    content: "Dear Sir/Madam,\nNet profit increased 10% year on year.",
    summary: "Dear Sir/Madam",
  };
  const item = presentItem(stored);
  assert.deepEqual(item.highlights, ["Net profit increased 10% year on year."]);
  assert.equal(
    stored.content,
    "Dear Sir/Madam,\nNet profit increased 10% year on year.",
  );
});
