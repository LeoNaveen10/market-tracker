# Market Tracker

A personal NSE company research dashboard: searchable companies, a watchlist, financial results, press releases, public news and persistent history. Built with Node.js 24, SQLite and a responsive web interface. No paid APIs or API keys.

## Run locally

```sh
npm ci --cache /workspace/.npm
npm start
```

The development server listens on port 3000 on loopback. Open it through your development environment's supported port access. Search a company, click **Follow**, then **Refresh data**. Each newly followed company attempts one year of available history. A running server checks every minute for watchlists due for their daily collection. Processes must be restarted after an environment restart; this is not an external cron service.

`npm run dev` starts with Node's file watcher. `PORT`, `HOST` and `DB_PATH` can override the defaults. This is a single-user development application without authentication: do not expose it publicly before adding authentication and production deployment controls.

## What is collected

- **Company directory:** NSE's published `EQUITY_L.csv`, cached in SQLite and refreshed at startup or with **Sync directory**. Search covers the securities in that file; it does not claim exhaustive SME, delisted or suspended-company coverage.
- **Announcements and press releases:** NSE corporate filings filtered by company and date. Relevant public PDFs are read when available; oversized, scanned or unsupported attachments fall back to the announcement with an explicit extraction note. Financial results and voting results are classified separately.
- **Quarterly financial figures:** NSE financial-results filings and XBRL, when supported. Revenue and net profit are taken from the current-quarter INR context. YoY revenue growth is calculated only with a matching previous-year quarter and the same consolidated or standalone basis. Unsupported bank/other taxonomy layouts show missing figures explicitly.
- **News and research:** Google News RSS searches using the company name. Attribution, source links and public feed excerpts are retained. Full articles, paywalled reports and social media are not scraped. RSS coverage is limited and does not provide a complete one-year archive or a guarantee of research-article coverage.

Filing and announcement cards show up to three short, source-backed highlights instead of opening paragraphs or full text. The extractor ranks business statements, removes common cover-letter and administrative boilerplate, preserves negative facts and figures, and deduplicates statements. When no reliable statement is found, the card directs you to the original filing. Existing stored filings use the same presentation without deleting their underlying history. Full source text is excluded from feed API responses.

Summaries use source extracts and deterministic financial templates, not a paid language model. They are not guaranteed interpretations of every PDF or full article. All displayed information links back to its original source; figures are not invented when extraction fails.

## History and refresh behavior

SQLite lives in `data/market.db`, with WAL mode enabled. Followed companies, source text, normalized summaries, quarterly metrics and refresh logs survive restarts. Duplicate source records are ignored. Unfollowing preserves historical records. The feed shows the latest 300 records; older records remain stored in SQLite. Back up the database using SQLite's backup API or stop the server before copying the database and associated WAL files.

The first collection requests one year of announcements; financial parsing also fetches earlier comparison quarters. Subsequent collections overlap the previous successful refresh by three days. Failed sources are logged and do not advance the successful-refresh date. Automatic collection runs approximately every 24 hours while the app is running; manual refresh is available anytime and concurrent collections are prevented.

## Validation

```sh
npm test
npm run test:browser
npm audit --omit=dev --cache /workspace/.npm
```

The unit/integration suite uses explicit fixtures to verify parsing, quarterly context selection, dates, persistence, duplicate handling, source failure reporting and API behavior. The browser smoke test uses an isolated in-memory database; it requires Chromium at `/usr/bin/chromium` or a `BROWSER_PATH` override. It verifies search, following, refresh, figures, category filtering and mobile layout without changing your watchlist.

Live external-source validation is separate from fixture tests. Sources may change schemas, restrict automated access or omit filings. Collection health shows errors rather than silently presenting a failed request as successful empty coverage.

## Cloud environment

Node.js 24 or newer is required for built-in SQLite and proxy-aware fetch. Use the existing checkout in the isolated cloud task; no Git worktree is necessary. Install with the lockfile using `npm ci`. Required network destinations are `www.nseindia.com`, `nsearchives.nseindia.com`, `archives.nseindia.com`, `news.google.com` and `registry.npmjs.org`. Keep TLS and integrity checks enabled. No secrets are needed. Dependencies and databases are ignored by Git; never commit personal runtime data.

Production hosting, accounts, broker integration, investment recommendations and complete historical market-data licensing are outside this development version.
