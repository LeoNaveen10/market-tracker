import { importance, IMPORTANCE_POLICY } from "./importance.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
export function openStore(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS companies(symbol TEXT PRIMARY KEY,name TEXT NOT NULL,series TEXT);
CREATE TABLE IF NOT EXISTS watchlist(symbol TEXT PRIMARY KEY REFERENCES companies(symbol),added_at TEXT NOT NULL,last_attempt TEXT,last_success TEXT);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,symbol TEXT NOT NULL REFERENCES companies(symbol),title TEXT,content TEXT,summary TEXT,growth REAL,category TEXT,url TEXT,published TEXT,source TEXT,note TEXT,collected_at TEXT);
CREATE INDEX IF NOT EXISTS items_company_date ON items(symbol,published);
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY,symbol TEXT,source TEXT,status TEXT,error TEXT,added INTEGER,finished TEXT);
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);`);
  if (
    !db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .some((column) => column.name === "skipped")
  ) {
    db.exec("ALTER TABLE runs ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0");
  }
  const previousPolicy = db
    .prepare("SELECT value FROM metadata WHERE key='importance_policy'")
    .get()?.value;
  if (previousPolicy !== IMPORTANCE_POLICY) {
    db.exec("BEGIN IMMEDIATE");
    try {
      let removed = 0;
      const remove = db.prepare("DELETE FROM items WHERE id=?");
      for (const item of db.prepare("SELECT * FROM items").all()) {
        if (!importance(item).important)
          removed += Number(remove.run(item.id).changes);
      }
      const meta = db.prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)");
      meta.run("importance_policy", IMPORTANCE_POLICY);
      meta.run("importance_cleanup_removed", String(removed));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    db,
    saveCompanies(rows) {
      const insert = db.prepare(
        "INSERT INTO companies VALUES(?,?,?) ON CONFLICT(symbol) DO UPDATE SET name=excluded.name,series=excluded.series",
      );
      db.exec("BEGIN");
      try {
        for (const r of rows) insert.run(r.symbol, r.name, r.series);
        db.prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(
          "directory_updated",
          new Date().toISOString(),
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    saveItems(symbol, items) {
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      let added = 0,
        skipped = 0;
      for (const i of items) {
        if (!importance(i).important) {
          skipped++;
          continue;
        }
        const id = createHash("sha256")
          .update([symbol, i.source, i.url, i.title, i.published].join("|"))
          .digest("hex");
        added += Number(
          stmt.run(
            id,
            symbol,
            i.title,
            i.content,
            i.summary,
            i.growth,
            i.category,
            i.url,
            i.published,
            i.source,
            i.note,
            new Date().toISOString(),
          ).changes,
        );
      }
      return { added, skipped };
    },
  };
}
