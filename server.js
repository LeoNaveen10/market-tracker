import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "./store.js";
import * as live from "./sources.js";
const root = fileURLToPath(new URL(".", import.meta.url));
export function createApp({
  dbPath = process.env.DB_PATH || join(root, "data/market.db"),
  sources = live,
} = {}) {
  const store = openStore(dbPath),
    db = store.db;
  const state = { busy: false, directoryBusy: false, directoryError: null };
  async function directory() {
    if (state.directoryBusy) return;
    state.directoryBusy = true;
    try {
      const rows = await sources.companyDirectory();
      if (!rows.length)
        throw new Error("NSE returned an empty company directory");
      store.saveCompanies(rows);
      state.directoryError = null;
    } catch (e) {
      state.directoryError = e.message;
    } finally {
      state.directoryBusy = false;
    }
  }
  async function refresh(symbol) {
    if (state.busy) return false;
    state.busy = true;
    try {
      const companies = db
        .prepare(
          "SELECT c.*,w.last_success FROM watchlist w JOIN companies c USING(symbol) WHERE (? IS NULL OR symbol=?)",
        )
        .all(symbol || null, symbol || null);
      for (const company of companies) {
        const now = new Date().toISOString();
        db.prepare("UPDATE watchlist SET last_attempt=? WHERE symbol=?").run(
          now,
          company.symbol,
        );
        const since = company.last_success
          ? new Date(Date.parse(company.last_success) - 3 * 86400000)
          : new Date(Date.now() - 365 * 86400000);
        let ok = true;
        for (const [source, fn] of [
          ["NSE", sources.announcements],
          ["Google News", sources.news],
          ...(sources.financialResults
            ? [["NSE financials", sources.financialResults]]
            : []),
        ]) {
          try {
            const items = await fn(company, since);
            const added = store.saveItems(company.symbol, items);
            db.prepare(
              "INSERT INTO runs(symbol,source,status,error,added,finished) VALUES(?,?,?,?,?,?)",
            ).run(
              company.symbol,
              source,
              items.warning ? "limited" : "success",
              items.warning || null,
              added,
              new Date().toISOString(),
            );
          } catch (e) {
            ok = false;
            db.prepare(
              "INSERT INTO runs(symbol,source,status,error,added,finished) VALUES(?,?,?,?,?,?)",
            ).run(
              company.symbol,
              source,
              "failed",
              e.message,
              0,
              new Date().toISOString(),
            );
          }
        }
        if (ok)
          db.prepare("UPDATE watchlist SET last_success=? WHERE symbol=?").run(
            new Date().toISOString(),
            company.symbol,
          );
      }
    } finally {
      state.busy = false;
    }
    return true;
  }
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host)
          return json(res, 403, {
            error: "Cross-origin requests are not allowed",
          });
      }
      if (u.pathname === "/api/status")
        return json(res, 200, {
          ...state,
          companyCount: db.prepare("SELECT count(*) n FROM companies").get().n,
          directoryUpdated:
            db
              .prepare(
                "SELECT value FROM metadata WHERE key='directory_updated'",
              )
              .get()?.value || null,
          runs: db
            .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 30")
            .all(),
        });
      if (u.pathname === "/api/companies" && req.method === "GET") {
        const q = (u.searchParams.get("q") || "").slice(0, 100);
        return json(
          res,
          200,
          db
            .prepare(
              "SELECT * FROM companies WHERE symbol LIKE ? OR name LIKE ? ORDER BY symbol LIMIT 50",
            )
            .all("%" + q + "%", "%" + q + "%"),
        );
      }
      if (u.pathname === "/api/watchlist" && req.method === "GET")
        return json(
          res,
          200,
          db
            .prepare(
              "SELECT c.*,w.added_at,w.last_attempt,w.last_success FROM watchlist w JOIN companies c USING(symbol) ORDER BY c.name",
            )
            .all(),
        );
      if (u.pathname === "/api/items" && req.method === "GET") {
        const symbol = u.searchParams.get("symbol"),
          category = u.searchParams.get("category");
        return json(
          res,
          200,
          db
            .prepare(
              "SELECT * FROM items WHERE (? IS NULL OR symbol=?) AND (? IS NULL OR category=?) ORDER BY published DESC LIMIT 300",
            )
            .all(symbol, symbol, category, category),
        );
      }
      if (u.pathname === "/api/directory/refresh" && req.method === "POST") {
        if (state.directoryBusy)
          return json(res, 409, { error: "Directory refresh already running" });
        void directory();
        return json(res, 202, { message: "Directory refresh started" });
      }
      if (u.pathname === "/api/refresh" && req.method === "POST") {
        if (state.busy)
          return json(res, 409, { error: "Refresh already running" });
        const symbol = u.searchParams.get("symbol");
        if (
          symbol &&
          !db.prepare("SELECT symbol FROM watchlist WHERE symbol=?").get(symbol)
        )
          return json(res, 404, { error: "Company not followed" });
        void refresh(symbol);
        return json(res, 202, { message: "Refresh started" });
      }
      const match = decodeURIComponent(u.pathname).match(
        /^\/api\/watchlist\/([A-Za-z0-9&_.-]+)$/,
      );
      if (match && ["POST", "DELETE"].includes(req.method)) {
        const symbol = decodeURIComponent(match[1]);
        if (req.method === "POST") {
          if (
            !db
              .prepare("SELECT symbol FROM companies WHERE symbol=?")
              .get(symbol)
          )
            return json(res, 404, { error: "Unknown NSE symbol" });
          db.prepare(
            "INSERT OR IGNORE INTO watchlist(symbol,added_at) VALUES(?,?)",
          ).run(symbol, new Date().toISOString());
          return json(res, 201, {
            message: "Company followed; use Refresh to backfill",
          });
        }
        db.prepare("DELETE FROM watchlist WHERE symbol=?").run(symbol);
        return json(res, 200, {
          message: "Unfollowed; historical data retained",
        });
      }
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(u.pathname)
      ) {
        const filename =
          u.pathname === "/" ? "index.html" : u.pathname.slice(1);
        res.writeHead(200, {
          "Content-Type": filename.endsWith(".html")
            ? "text/html"
            : filename.endsWith(".js")
              ? "text/javascript"
              : "text/css",
          "Content-Security-Policy":
            "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        });
        res.end(await readFile(join(root, "public", filename)));
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  let timer;
  return {
    server,
    db,
    state,
    directory,
    refresh,
    startJobs() {
      void directory();
      const tick = () => {
        if (
          !state.busy &&
          db
            .prepare(
              "SELECT symbol FROM watchlist WHERE last_attempt IS NULL OR last_attempt < ? LIMIT 1",
            )
            .get(new Date(Date.now() - 86400000).toISOString())
        )
          void refresh();
      };
      tick();
      timer = setInterval(tick, 60000);
      timer.unref();
    },
    close() {
      clearInterval(timer);
      server.close();
      db.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, process.env.HOST || "127.0.0.1", () => {
    console.log(`Market Tracker listening on port ${port}`);
    app.startJobs();
  });
}
