import { XMLParser } from "fast-xml-parser";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const parsePdf = require("pdf-parse/lib/pdf-parse.js");
const headers = {
  "User-Agent": "Mozilla/5.0 (compatible; MarketTracker/0.1)",
  Accept: "application/json,text/html,*/*",
};
export async function request(url, { binary = false, cookie = "" } = {}) {
  const r = await fetch(url, {
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`Source returned HTTP ${r.status}`);
  const limit = binary ? 30_000_000 : 8_000_000;
  if (Number(r.headers.get("content-length")) > limit)
    throw new Error("Source response too large");
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Source response too large");
    }
    chunks.push(value);
  }
  const data = Buffer.concat(chunks);
  return binary ? data : data.toString("utf8");
}
export function csvRows(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if (c === "\n" && !quoted) {
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
export function parseCompanies(text) {
  const rows = csvRows(text);
  const h = rows.shift() || [];
  const symbol = h.indexOf("SYMBOL"),
    name = h.indexOf("NAME OF COMPANY"),
    series = h.indexOf("SERIES");
  if (symbol < 0 || name < 0)
    throw new Error("Unexpected NSE company-directory format");
  return rows
    .filter((r) => r[symbol] && r[name])
    .map((r) => ({
      symbol: r[symbol],
      name: r[name],
      series: r[series] || "",
    }));
}
export function plain(text = "") {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
export function summarize(text) {
  const clean = plain(text);
  if (!clean) return "No text available. Open the original source for details.";
  const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [clean];
  return sentences
    .slice(0, 3)
    .map((s) => s.trim())
    .join(" ")
    .trim()
    .slice(0, 650);
}
export function salesGrowth(text) {
  const m = plain(text).match(
    /(?:revenue|sales)(?:\s+from\s+operations)?\s+(?:grew|growth|increased|rose)[^.;]{0,65}?(\d+(?:\.\d+)?)\s*%\s*(?:year.on.year|yoy|YoY)/i,
  );
  return m ? Number(m[1]) : null;
}
const date = (d) =>
  `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
async function nseJson(url) {
  let cookie = "";
  try {
    const r = await fetch("https://www.nseindia.com", {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    await r.body?.cancel();
  } catch {}
  return JSON.parse(await request(url, { cookie }));
}
export async function companyDirectory() {
  return parseCompanies(
    await request(
      "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
    ),
  );
}
export async function announcements(company, since) {
  const end = new Date();
  const params = new URLSearchParams({
    index: "equities",
    symbol: company.symbol,
    from_date: date(since),
    to_date: date(end),
  });
  const rows = await nseJson(
    `https://www.nseindia.com/api/corporate-announcements?${params}`,
  );
  if (!Array.isArray(rows))
    throw new Error("Unexpected NSE announcement response");
  const items = [];
  for (const row of rows) {
    const title = plain(row.desc || row.subject || "Corporate announcement");
    const body = plain(row.attchmntText || row.anndesc || "");
    let attachment = row.attchmntFile || "";
    try {
      const u = new URL(attachment);
      if (
        u.protocol !== "https:" ||
        ![
          "nsearchives.nseindia.com",
          "www.nseindia.com",
          "archives.nseindia.com",
        ].includes(u.hostname)
      )
        attachment = "";
    } catch {
      attachment = "";
    }
    const rawDate = row.an_dt || row.sort_date;
    const published = nseDate(rawDate);
    if (!rawDate || !published) continue;
    const category = classifyAnnouncement(title, body);
    let content = body || title;
    let note = "Announcement text";
    if (attachment && category !== "filing") {
      try {
        const pdf = await parsePdf(
          await request(attachment, { binary: true }),
          { max: 30 },
        );
        if (pdf.text.trim()) {
          content = pdf.text;
          note = "Extract from attachment";
        }
      } catch (e) {
        note = `Attachment text unavailable: ${e.message}`;
      }
    }
    items.push({
      title,
      content,
      summary: summarize(content),
      growth: salesGrowth(content),
      category,
      url:
        attachment ||
        `https://www.nseindia.com/companies-listing/corporate-filings-announcements`,
      published: published.toISOString(),
      source: "NSE",
      note,
    });
  }
  return items;
}
export function parseNews(xml) {
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  if (!parsed.rss?.channel) throw new Error("Unexpected news feed format");
  let rows = parsed.rss.channel.item || [];
  if (!Array.isArray(rows)) rows = [rows];
  return rows
    .map((r) => {
      const published = new Date(r.pubDate);
      return {
        title: plain(r.title),
        content: plain(r.description),
        summary: summarize(r.description || r.title),
        growth: null,
        category: "news & research",
        url: typeof r.link === "string" ? r.link : "",
        published: Number.isFinite(published.getTime())
          ? published.toISOString()
          : null,
        source:
          typeof r.source === "object"
            ? r.source["#text"] || "Google News"
            : r.source || "Google News",
        note: "Publisher feed excerpt; full article not scraped",
      };
    })
    .filter((r) => r.published && r.title && /^https:\/\//.test(r.url));
}
export async function news(company, since) {
  const q = `"${company.name.replace(/ Limited$/i, "")}" after:${since.toISOString().slice(0, 10)}`;
  return parseNews(
    await request(
      `https://news.google.com/rss/search?${new URLSearchParams({ q, hl: "en-IN", gl: "IN", ceid: "IN:en" })}`,
    ),
  );
}

export function nseDate(value) {
  if (!value) return null;
  const text = String(value);
  const d = new Date(
    /(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : text + " GMT+0530",
  );
  return Number.isFinite(d.getTime()) ? d : null;
}
export function classifyAnnouncement(title, body) {
  const text = title + " " + body;
  return /financial results|financial statements|quarterly results|annual results/i.test(
    text,
  )
    ? "results"
    : /press|release|investor presentation/i.test(text)
      ? "press release"
      : "filing";
}
export function parseFinancialXbrl(xml, record) {
  const x = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  }).parse(xml).xbrl;
  if (!x) throw new Error("Unexpected XBRL format");
  const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const contexts = list(x.context);
  // NSE's OneD context is the current standalone reporting period; do not
  // accidentally use cumulative FourD values or dimensional segment facts.
  const current = contexts.find((c) => c["@_id"] === "OneD" && !c.scenario);
  if (!current) throw new Error("Current-quarter XBRL context unavailable");
  const start = current.period?.startDate,
    end = current.period?.endDate;
  // Dates without a time are civil dates, so compare by a UTC date parse here.
  const civil = (v) => new Date(v + " UTC").toISOString().slice(0, 10);
  if (start !== civil(record.fromDate) || end !== civil(record.toDate))
    throw new Error("XBRL period does not match filing");
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days < 75 || days > 105)
    throw new Error("Filing does not describe a single quarter");
  const get = (key) => {
    const facts = list(x[key]).filter(
      (f) =>
        f["@_contextRef"] === current["@_id"] &&
        f["@_unitRef"] === "INR" &&
        f["@_nil"] !== "true",
    );
    if (facts.length !== 1) return null;
    const value = Number(facts[0]["#text"]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    revenue: get("RevenueFromOperations"),
    profit: get("ProfitLossForPeriod"),
    start,
    end,
  };
}
export async function financialResults(company, since) {
  const rows = await nseJson(
    `https://www.nseindia.com/api/corporates-financial-results?${new URLSearchParams({ index: "equities", symbol: company.symbol, period: "Quarterly" })}`,
  );
  if (!Array.isArray(rows))
    throw new Error("Unexpected NSE financial-results response");
  const oldest = new Date(since.getTime() - 366 * 86400000);
  const filings = rows
    .filter(
      (r) =>
        r.symbol === company.symbol &&
        r.period === "Quarterly" &&
        nseDate(r.broadCastDate) >= oldest &&
        /^https:\/\/nsearchives\.nseindia\.com\/.*\.xml$/i.test(r.xbrl || ""),
    )
    .sort((a, b) => nseDate(b.broadCastDate) - nseDate(a.broadCastDate));
  const unique = new Map();
  for (const r of filings) {
    const key = r.toDate + "|" + r.consolidated;
    if (!unique.has(key)) unique.set(key, r);
  }
  const records = [];
  for (const row of [...unique.values()].slice(0, 20)) {
    try {
      const metrics = parseFinancialXbrl(await request(row.xbrl), row);
      records.push({ row, metrics, error: null });
    } catch (e) {
      records.push({ row, metrics: null, error: e.message });
    }
  }
  const crore = (v) =>
    (v / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const items = records
    .filter((r) => nseDate(r.row.broadCastDate) >= since)
    .map(({ row, metrics, error }) => {
      let growth = null;
      const previous =
        metrics &&
        records.find(
          (r) =>
            r.metrics &&
            r.row.consolidated === row.consolidated &&
            r.metrics.end.slice(5) === metrics.end.slice(5) &&
            Number(r.metrics.end.slice(0, 4)) ===
              Number(metrics.end.slice(0, 4)) - 1,
        );
      if (previous?.metrics.revenue > 0 && metrics.revenue !== null)
        growth =
          Math.round((metrics.revenue / previous.metrics.revenue - 1) * 10000) /
          100;
      const parts = [
        `${row.companyName}: ${row.consolidated.toLowerCase()} quarterly results for the period ended ${row.toDate}.`,
      ];
      if (metrics?.revenue !== null && metrics?.revenue !== undefined)
        parts.push(
          `Revenue from operations: ₹${crore(metrics.revenue)} crore${growth !== null ? `, ${growth >= 0 ? "up" : "down"} ${Math.abs(growth)}% year on year` : ""}.`,
        );
      if (metrics?.profit !== null && metrics?.profit !== undefined)
        parts.push(`Net profit / loss: ₹${crore(metrics.profit)} crore.`);
      return {
        title: `${row.relatingTo || "Quarterly"} results · ${row.toDate} · ${row.consolidated}`,
        content: JSON.stringify({ filing: row, metrics }),
        summary: parts.join(" "),
        growth,
        category: "results",
        url: row.xbrl,
        published: nseDate(row.broadCastDate).toISOString(),
        source: "NSE financials",
        note: error
          ? `Structured figures unavailable: ${error}`
          : "NSE XBRL figures · YoY compares the same reporting basis",
      };
    });
  const latest = rows
    .map((r) => nseDate(r.broadCastDate))
    .filter(Boolean)
    .sort((a, b) => b - a)[0];
  if (latest && latest < since)
    items.warning = `No structured filings in the requested period. Latest source filing: ${latest.toISOString().slice(0, 10)}. Recent result announcements are collected separately.`;
  return items;
}
