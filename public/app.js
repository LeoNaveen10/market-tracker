const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let selected = "",
  watch = [],
  status = {},
  items = [];
let searchSequence = 0;
let loadGeneration = 0;
async function api(path, method = "GET") {
  const r = await fetch(path, { method });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
function notice(text) {
  $("#notice").hidden = !text;
  $("#notice").textContent = text;
}
const stamp = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : "Never";
function renderWatch() {
  $("#watch-count").textContent = watch.length;
  $("#stat-companies").textContent = watch.length;
  $("#watchlist").innerHTML = watch.length
    ? watch
        .map(
          (c) =>
            `<div class="watch-item ${selected === c.symbol ? "selected" : ""}"><span class="ticker-icon">${esc(c.symbol.slice(0, 2))}</span><button class="watch-select" data-symbol="${esc(c.symbol)}"><strong>${esc(c.symbol)}</strong><small>${esc(c.name)}</small></button><button class="remove" data-remove="${esc(c.symbol)}" aria-label="Unfollow ${esc(c.symbol)}">×</button></div>`,
        )
        .join("")
    : '<p class="sidebar-empty">Your watchlist starts here.<br>Search for a company to follow.</p>';
  const company = watch.find((c) => c.symbol === selected);
  $("#page-title").textContent = company
    ? company.name
    : "Your companies, in focus.";
  $("#page-description").textContent = company
    ? `${company.symbol} · NSE · Last successful collection: ${stamp(company.last_success)}`
    : "Results, announcements and stories. One place to stay informed.";
}
function renderFeed() {
  const filtered = items.filter(
    (i) => !$("#category").value || i.category === $("#category").value,
  );
  $("#stat-updates").textContent = items.length;
  $("#stat-results").textContent = items.filter(
    (i) => i.category === "results",
  ).length;
  $("#feed-count").textContent = filtered.length;
  $("#feed").innerHTML = filtered.length
    ? filtered
        .map((i) => {
          let url;
          try {
            url = new URL(i.url);
            if (url.protocol !== "https:") url = null;
          } catch {}
          return `<article class="card"><div class="card-meta"><span class="tag ${i.category === "results" ? "results" : ""}">${esc(i.category)}</span><strong>${esc(i.symbol)}</strong>${i.importanceReason ? `<span class="importance-reason">${esc(i.importanceReason)}</span>` : ""}<span>·</span><span>${esc(stamp(i.published))}</span><span>·</span><span>${esc(i.source)}</span></div><h3>${esc(i.title)}</h3>${i.highlights ? `<ul class="highlights">${i.highlights.map((point) => `<li>${esc(point)}</li>`).join("")}</ul>` : `<p>${esc(i.summary)}</p>`}${i.growth !== null ? `<div class="growth">Sales / revenue growth &nbsp; <strong>${esc(i.growth)}% YoY</strong> <span>· ${i.source === "NSE financials" ? "calculated from matched quarterly filings" : "explicitly stated by source"}</span></div>` : ""}<div class="card-bottom"><small>${esc(i.note)} · Saved ${esc(stamp(i.collected_at))}</small>${url ? `<a class="source-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">Original source ↗</a>` : ""}</div></article>`;
        })
        .join("")
    : `<div class="empty"><div class="empty-icon">◫</div><h3>${watch.length ? "Your next update will appear here." : "Build your circle of companies."}</h3><p>${watch.length ? "No important updates match this view. Routine notices are filtered out before storage. Refresh to check for new business events." : "Search an NSE company above and add it to your watchlist. We’ll keep its results, announcements and public news together."}</p></div>`;
}
function renderStatus() {
  const directory = status.companyCount
    ? `${status.companyCount.toLocaleString("en-IN")} NSE securities searchable · Synced ${stamp(status.directoryUpdated)}`
    : status.directoryBusy
      ? "Fetching NSE company directory…"
      : "Company directory unavailable — sync after enabling source access";
  $("#directory-status").textContent = directory;
  $("#refresh").disabled = status.busy || !watch.length;
  $("#refresh").textContent = status.busy
    ? "↻  Collecting…"
    : "↻  Refresh data";
  $("#directory-refresh").disabled = status.directoryBusy;
  const latest = new Map();
  for (const r of status.runs || []) {
    if (selected && r.symbol !== selected) continue;
    const key = r.symbol + r.source;
    if (!latest.has(key)) latest.set(key, r);
  }
  $("#health").innerHTML =
    `<div class="health-row"><span class="${status.directoryError ? "failed" : "success"}">●</span> NSE directory: ${status.directoryError ? "unavailable" : status.companyCount ? "available" : "pending"}</div>${status.directoryError ? `<small class="health-detail">${esc(status.directoryError)}</small>` : ""}` +
    [...latest.values()]
      .slice(0, 6)
      .map(
        (r) =>
          `<div class="health-row"><span class="${r.status}">●</span> ${esc(r.symbol)} · ${esc(r.source)} · ${r.status === "success" ? `${r.added} saved · ${r.skipped || 0} filtered out` : r.status === "limited" ? "limited coverage" : "failed"}</div><small class="health-detail">${esc(r.error || stamp(r.finished))}</small>`,
      )
      .join("");
}
async function load() {
  const generation = ++loadGeneration;
  try {
    const next = await Promise.all([
      api("/api/watchlist"),
      api("/api/status"),
      api(
        "/api/items" +
          (selected ? "?symbol=" + encodeURIComponent(selected) : ""),
      ),
    ]);
    if (generation !== loadGeneration) return;
    [watch, status, items] = next;
    renderWatch();
    renderFeed();
    renderStatus();
  } catch (e) {
    notice(e.message);
  }
}
$("#search").addEventListener("input", async () => {
  const seq = ++searchSequence,
    q = $("#search").value.trim();
  if (!q) {
    $("#search-results").hidden = true;
    return;
  }
  try {
    const rows = await api("/api/companies?q=" + encodeURIComponent(q));
    if (seq !== searchSequence) return;
    $("#search-results").hidden = false;
    $("#search-results").innerHTML = rows.length
      ? rows
          .map(
            (c) =>
              `<div class="search-result"><div><strong>${esc(c.symbol)}</strong><small>${esc(c.name)} · ${esc(c.series)}</small></div><button class="follow" data-follow="${esc(c.symbol)}" ${watch.some((w) => w.symbol === c.symbol) ? "disabled" : ""}>${watch.some((w) => w.symbol === c.symbol) ? "Following" : "+ Follow"}</button></div>`,
          )
          .join("")
      : `<div class="search-result">${status.companyCount ? "No matching NSE company." : "Sync the NSE directory to search companies."}</div>`;
  } catch (e) {
    notice(e.message);
  }
});
document.addEventListener("click", async (e) => {
  const follow = e.target.closest("[data-follow]"),
    remove = e.target.closest("[data-remove]"),
    pick = e.target.closest("[data-symbol]");
  try {
    if (follow) {
      await api(
        "/api/watchlist/" + encodeURIComponent(follow.dataset.follow),
        "POST",
      );
      $("#search-results").hidden = true;
      $("#search").value = "";
      notice(
        "Company added. Refresh data to collect up to one year of available history.",
      );
      await load();
    }
    if (remove) {
      await api(
        "/api/watchlist/" + encodeURIComponent(remove.dataset.remove),
        "DELETE",
      );
      if (selected === remove.dataset.remove) selected = "";
      await load();
    }
    if (pick) {
      selected = pick.dataset.symbol;
      await load();
    }
  } catch (error) {
    notice(error.message);
  }
});
$("#overview").onclick = () => {
  selected = "";
  void load();
};
$("#category").onchange = renderFeed;
$("#refresh").onclick = async () => {
  try {
    await api(
      "/api/refresh" +
        (selected ? "?symbol=" + encodeURIComponent(selected) : ""),
      "POST",
    );
    notice(
      "Collection started. Older coverage depends on source availability; Google News is not a complete archive.",
    );
    await load();
  } catch (e) {
    notice(e.message);
  }
};
$("#directory-refresh").onclick = async () => {
  try {
    await api("/api/directory/refresh", "POST");
    await load();
  } catch (e) {
    notice(e.message);
  }
};
// One persistent notification connection replaces periodic API polling.
let reloadTimer;
const events = new EventSource("/api/events");
function scheduleLoad() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 75);
}
events.addEventListener("ready", scheduleLoad);
events.addEventListener("change", scheduleLoad);
events.onerror = () => {
  events.close(); // Avoid an automatic reconnect/request loop during outages.
  notice("Live updates disconnected. Reload the page to reconnect.");
};
window.addEventListener("pagehide", () => {
  events.close();
  clearTimeout(reloadTimer);
});
// Initial data still loads if event streaming is unavailable.
await load();
