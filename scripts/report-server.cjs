#!/usr/bin/env node
// report-server.cjs — Lightweight HTTP server for knowledge consolidation reports
// Usage: node report-server.cjs [--port PORT] [--open-browser] [--daemon]
// Serves report pages, handles feedback submission, auto-shutdown on idle

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { exec } = require("child_process");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  console.error("FATAL: better-sqlite3 not found. Run: npm install better-sqlite3");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(os.homedir(), ".claude/knowledge");
const DB_PATH = path.join(KNOWLEDGE_DIR, "knowledge.db");
const CONSOLIDATION_DIR = path.join(KNOWLEDGE_DIR, "consolidation");

const args = process.argv.slice(2);
const PORT = parseInt(args[args.indexOf("--port") + 1]) || 19876;
const OPEN_BROWSER = args.includes("--open-browser");
const DAEMON = args.includes("--daemon");

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log("[report-server] Idle timeout, shutting down");
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

// ── Database ──────────────────────────────────────────────────────────────

function getDB() {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: false });
  db.pragma("journal_mode = WAL");
  return db;
}

// ── API Handlers ──────────────────────────────────────────────────────────

function getAvailableDates() {
  const dateSet = new Set();
  // Check filesystem (consolidation dirs)
  if (fs.existsSync(CONSOLIDATION_DIR)) {
    for (const entry of fs.readdirSync(CONSOLIDATION_DIR)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry)) dateSet.add(entry);
    }
  }
  // Check SQLite (consolidation_ops)
  const db = getDB();
  if (db) {
    const rows = db.prepare("SELECT DISTINCT date FROM consolidation_ops ORDER BY date DESC").all();
    rows.forEach(r => dateSet.add(r.date));
    db.close();
  }
  return Array.from(dateSet).sort().reverse();
}

function getReportData(date) {
  const db = getDB();
  if (!db) return { date, ops: [], stats: null };

  const ops = db.prepare(
    "SELECT * FROM consolidation_ops WHERE date = ? ORDER BY id"
  ).all(date);

  const statsRow = db.prepare(
    "SELECT COUNT(*) as total_active, ROUND(AVG(importance),1) as avg_importance FROM knowledge WHERE status = 'active'"
  ).get();

  db.close();
  return {
    date,
    ops: ops.map(op => ({
      ...op,
      tags: safeJSONParse(op.tags, []),
      reasoning: safeJSONParse(op.reasoning, {}),
      source_observations: safeJSONParse(op.source_observations, []),
    })),
    stats: statsRow,
  };
}

function submitFeedback(knowledgeId, rating, comment) {
  const db = getDB();
  if (!db) return { error: "database not found" };

  const existing = db.prepare("SELECT id FROM knowledge WHERE id = ?").get(knowledgeId);
  if (!existing) { db.close(); return { error: "knowledge not found" }; }

  db.prepare(
    `UPDATE knowledge SET feedback_rating = ?, feedback_comment = ?, feedback_at = datetime('now'), feedback_consumed = 0 WHERE id = ?`
  ).run(rating, comment || null, knowledgeId);

  db.close();
  return { ok: true, id: knowledgeId, rating };
}

function getFeedbackForDate(date) {
  const db = getDB();
  if (!db) return {};

  const ops = db.prepare("SELECT knowledge_id FROM consolidation_ops WHERE date = ?").all(date);
  const ids = ops.map(o => o.knowledge_id);
  if (ids.length === 0) { db.close(); return {}; }

  const feedback = {};
  for (const id of ids) {
    const row = db.prepare(
      "SELECT feedback_rating, feedback_comment, feedback_at FROM knowledge WHERE id = ?"
    ).get(id);
    if (row && row.feedback_rating) {
      feedback[id] = {
        rating: row.feedback_rating,
        comment: row.feedback_comment,
        at: row.feedback_at,
      };
    }
  }
  db.close();
  return feedback;
}

function safeJSONParse(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── HTML Generation ───────────────────────────────────────────────────────

function generateHTML(dates, initialDate) {
  const datesJSON = JSON.stringify(dates);
  const initialDateStr = initialDate || (dates.length > 0 ? dates[0] : "");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Junior-Mem Knowledge Report</title>
<style>
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #e6edf3; --text-secondary: #8b949e;
  --accent: #58a6ff; --green: #3fb950; --orange: #d29922;
  --red: #f85149; --blue: #58a6ff; --gray: #6e7681;
  --radius: 8px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.6; padding: 0;
}
.header {
  position: sticky; top: 0; z-index: 100;
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 12px 24px; display: flex; align-items: center; gap: 16px;
}
.header h1 { font-size: 16px; font-weight: 600; white-space: nowrap; }
.date-nav { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.date-nav select {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 6px 12px; font-size: 14px; cursor: pointer;
}
.stats-bar {
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 10px 24px; display: flex; gap: 20px; font-size: 13px; color: var(--text-secondary);
}
.stats-bar .stat-val { color: var(--text); font-weight: 600; }
.main { max-width: 900px; margin: 0 auto; padding: 20px 24px; }
.empty { text-align: center; color: var(--text-secondary); padding: 60px 20px; font-size: 15px; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  margin-bottom: 16px; overflow: hidden; transition: border-color 0.2s;
}
.card:hover { border-color: var(--accent); }
.card-header {
  padding: 14px 18px; display: flex; align-items: center; gap: 10px;
  cursor: pointer; user-select: none;
}
.op-badge {
  display: inline-block; padding: 2px 10px; border-radius: 12px;
  font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
}
.op-create { background: rgba(63,185,80,0.15); color: var(--green); }
.op-reinforce { background: rgba(88,166,255,0.15); color: var(--blue); }
.op-update { background: rgba(210,153,34,0.15); color: var(--orange); }
.op-deprecate { background: rgba(248,81,73,0.15); color: var(--red); }
.op-reject { background: rgba(110,118,129,0.15); color: var(--gray); }
.card-title { font-size: 15px; font-weight: 500; flex: 1; }
.card-meta { font-size: 12px; color: var(--text-secondary); display: flex; gap: 12px; align-items: center; }
.importance { color: var(--orange); }
.expand-icon { color: var(--text-secondary); transition: transform 0.2s; font-size: 12px; }
.expand-icon.open { transform: rotate(90deg); }
.card-body { padding: 0 18px; display: none; }
.card-body.open { display: block; }
.section { margin-bottom: 16px; }
.section-label {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;
}
.section-content {
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 12px 14px; font-size: 14px; white-space: pre-wrap; word-break: break-word;
  max-height: 400px; overflow-y: auto;
}
.section-content code { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 13px; }
.reasoning-chain { display: flex; flex-direction: column; gap: 8px; }
.reasoning-step {
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; font-size: 13px;
}
.reasoning-step .role {
  font-weight: 600; margin-bottom: 4px;
}
.role-scanner { color: var(--green); }
.role-challenger { color: var(--orange); }
.role-auditor { color: var(--blue); }
.observation {
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 12px; font-size: 13px; margin-bottom: 6px;
}
.obs-turn { color: var(--accent); font-weight: 600; }
.feedback-section {
  border-top: 1px solid var(--border); padding: 14px 0 4px;
  margin-top: 8px;
}
.feedback-buttons { display: flex; gap: 10px; margin-bottom: 12px; }
.fb-btn {
  padding: 8px 20px; border-radius: var(--radius); border: 2px solid var(--border);
  background: transparent; color: var(--text); font-size: 14px; cursor: pointer;
  transition: all 0.2s; font-weight: 500;
}
.fb-btn:hover { border-color: var(--text-secondary); }
.fb-btn.selected-good { border-color: var(--green); background: rgba(63,185,80,0.15); color: var(--green); }
.fb-btn.selected-normal { border-color: var(--blue); background: rgba(88,166,255,0.15); color: var(--blue); }
.fb-btn.selected-bad { border-color: var(--red); background: rgba(248,81,73,0.15); color: var(--red); }
.comment-area { display: none; margin-top: 10px; }
.comment-area.visible { display: block; }
.comment-area textarea {
  width: 100%; min-height: 60px; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 10px;
  font-size: 14px; resize: vertical; font-family: inherit;
}
.comment-area textarea:focus { outline: none; border-color: var(--accent); }
.submit-btn {
  margin-top: 8px; padding: 8px 24px; background: var(--accent); color: #fff;
  border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500;
}
.submit-btn:hover { opacity: 0.9; }
.submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.feedback-status { font-size: 12px; color: var(--text-secondary); margin-top: 6px; }
.feedback-status.saved { color: var(--green); }
</style>
</head>
<body>

<div class="header">
  <h1>Junior-Mem Report</h1>
  <div class="date-nav">
    <label for="dateSelect" style="font-size:13px;color:var(--text-secondary)">Date:</label>
    <select id="dateSelect"></select>
  </div>
</div>

<div class="stats-bar" id="statsBar"></div>
<div class="main" id="mainContent"></div>

<script>
const DATES = ${datesJSON};
const INITIAL_DATE = "${initialDateStr}";
const API_BASE = window.location.origin;

let currentRating = {};
let feedbackCache = {};

// ── Init ──────────────────────────────────────────────────────────────
const dateSelect = document.getElementById("dateSelect");
DATES.forEach(d => {
  const opt = document.createElement("option");
  opt.value = d; opt.textContent = d;
  dateSelect.appendChild(opt);
});
if (INITIAL_DATE) dateSelect.value = INITIAL_DATE;
dateSelect.addEventListener("change", () => loadReport(dateSelect.value));

loadReport(INITIAL_DATE);

// ── Load Report ───────────────────────────────────────────────────────
async function loadReport(date) {
  if (!date) { document.getElementById("mainContent").innerHTML = '<div class="empty">No consolidation report data</div>'; return; }
  try {
    const [reportRes, feedbackRes] = await Promise.all([
      fetch(API_BASE + "/api/report/" + date).then(r => r.json()),
      fetch(API_BASE + "/api/feedback/" + date).then(r => r.json()),
    ]);
    feedbackCache = feedbackRes;
    renderReport(reportRes);
  } catch (e) {
    document.getElementById("mainContent").innerHTML = '<div class="empty">Failed to load: ' + e.message + '</div>';
  }
}

// ── Render ────────────────────────────────────────────────────────────
function renderReport(data) {
  const main = document.getElementById("mainContent");
  const statsBar = document.getElementById("statsBar");

  if (!data.ops || data.ops.length === 0) {
    main.innerHTML = '<div class="empty">' + data.date + ' no consolidation operations</div>';
    statsBar.innerHTML = "";
    return;
  }

  // Stats
  const counts = { create: 0, reinforce: 0, update: 0, deprecate: 0, reject: 0 };
  data.ops.forEach(op => { if (counts[op.operation] !== undefined) counts[op.operation]++; });
  statsBar.innerHTML =
    '<span>Date: <b class="stat-val">' + data.date + '</b></span>' +
    '<span>Ops: <b class="stat-val">' + data.ops.length + '</b></span>' +
    '<span style="color:var(--green)">Created ' + counts.create + '</span>' +
    '<span style="color:var(--blue)">Reinforced ' + counts.reinforce + '</span>' +
    '<span style="color:var(--orange)">Updated ' + counts.update + '</span>' +
    '<span style="color:var(--red)">Deprecated ' + counts.deprecate + '</span>' +
    '<span style="color:var(--gray)">Rejected ' + counts.reject + '</span>' +
    (data.stats ? '<span>Active total: <b class="stat-val">' + data.stats.total_active + '</b></span>' +
                 '<span>Avg importance: <b class="stat-val">' + data.stats.avg_importance + '</b></span>' : '');

  // Cards
  main.innerHTML = data.ops.map((op, idx) => renderCard(op, idx)).join("");
}

function renderCard(op, idx) {
  const badgeClass = "op-" + op.operation;
  const opLabel = {create:"Created", reinforce:"Reinforced", update:"Updated", deprecate:"Deprecated", reject:"Rejected"}[op.operation] || op.operation;
  const fb = feedbackCache[op.knowledge_id];
  const savedRating = fb ? fb.rating : "";
  const savedComment = fb ? (fb.comment || "") : "";

  let impStr = "";
  if (op.importance_before !== null && op.importance_after !== null && op.importance_before !== op.importance_after) {
    impStr = '<span class="importance">\\u2605' + op.importance_before + ' \\u2192 \\u2605' + op.importance_after + '</span>';
  } else if (op.importance_after !== null) {
    impStr = '<span class="importance">\\u2605' + op.importance_after + '</span>';
  }

  const tagsStr = (op.tags && op.tags.length > 0) ? op.tags.map(t => '<code>' + esc(t) + '</code>').join(" ") : "";

  let html = '<div class="card" data-id="' + esc(op.knowledge_id) + '">';
  html += '<div class="card-header" onclick="toggleCard(' + idx + ')">';
  html += '<span class="op-badge ' + badgeClass + '">' + opLabel + '</span>';
  html += '<span class="card-title">' + esc(op.title || op.knowledge_id) + '</span>';
  html += '<span class="card-meta">' + impStr + ' <code>' + esc(op.type || "") + '</code> ' + tagsStr + '</span>';
  html += '<span class="expand-icon" id="expand-' + idx + '">\\u25B6</span>';
  html += '</div>';

  html += '<div class="card-body" id="body-' + idx + '">';

  // Body
  if (op.body) {
    html += '<div class="section"><div class="section-label">Knowledge Body</div>';
    html += '<div class="section-content">' + esc(op.body) + '</div></div>';
  }

  // Source observations
  if (op.source_observations && op.source_observations.length > 0) {
    html += '<div class="section"><div class="section-label">Source Observations</div>';
    op.source_observations.forEach(obs => {
      html += '<div class="observation"><span class="obs-turn">[turn ' + esc(obs.turn || "?") + ']</span> ';
      html += '<b>' + esc(obs.role || "") + ':</b> ' + esc(obs.text || JSON.stringify(obs)) + '</div>';
    });
    html += '</div>';
  }

  // Reasoning chain
  if (op.reasoning && Object.keys(op.reasoning).length > 0) {
    html += '<div class="section"><div class="section-label">AI Reasoning Chain</div><div class="reasoning-chain">';
    const roles = [["scanner", "Scanner (propose)", "role-scanner"], ["challenger", "Challenger (challenge)", "role-challenger"], ["auditor", "Auditor (decide)", "role-auditor"]];
    roles.forEach(([key, label, cls]) => {
      if (op.reasoning[key]) {
        html += '<div class="reasoning-step"><div class="role ' + cls + '">' + label + '</div>';
        html += '<div>' + esc(op.reasoning[key]) + '</div></div>';
      }
    });
    html += '</div></div>';
  }

  // Feedback
  if (op.operation !== "reject") {
    html += '<div class="feedback-section">';
    html += '<div class="section-label">Feedback</div>';
    html += '<div class="feedback-buttons" id="fb-btns-' + idx + '">';
    html += '<button class="fb-btn' + (savedRating === "good" ? " selected-good" : "") + '" data-rating="good" onclick="selectRating(' + idx + ',\\'good\\',\\'' + esc(op.knowledge_id) + '\\')">&#x1F44D; Good</button>';
    html += '<button class="fb-btn' + (savedRating === "normal" ? " selected-normal" : "") + '" data-rating="normal" onclick="selectRating(' + idx + ',\\'normal\\',\\'' + esc(op.knowledge_id) + '\\')">&#x1F610; Normal</button>';
    html += '<button class="fb-btn' + (savedRating === "bad" ? " selected-bad" : "") + '" data-rating="bad" onclick="selectRating(' + idx + ',\\'bad\\',\\'' + esc(op.knowledge_id) + '\\')">&#x1F44E; Bad</button>';
    html += '</div>';
    html += '<div class="comment-area' + (savedRating ? " visible" : "") + '" id="comment-area-' + idx + '">';
    html += '<textarea id="comment-' + idx + '" placeholder="Add your feedback (optional)...">' + esc(savedComment) + '</textarea>';
    html += '<button class="submit-btn" id="submit-' + idx + '" onclick="submitFeedback(' + idx + ',\\'' + esc(op.knowledge_id) + '\\')">Submit</button>';
    html += '<div class="feedback-status" id="status-' + idx + '"></div>';
    html += '</div></div>';
  }

  html += '</div></div>';
  return html;
}

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ── Interactions ──────────────────────────────────────────────────────
function toggleCard(idx) {
  const body = document.getElementById("body-" + idx);
  const icon = document.getElementById("expand-" + idx);
  body.classList.toggle("open");
  icon.classList.toggle("open");
}

function selectRating(idx, rating, kid) {
  currentRating[kid] = rating;
  const btns = document.getElementById("fb-btns-" + idx).querySelectorAll(".fb-btn");
  btns.forEach(b => { b.className = "fb-btn"; if (b.dataset.rating === rating) b.classList.add("selected-" + rating); });
  document.getElementById("comment-area-" + idx).classList.add("visible");
}

async function submitFeedback(idx, kid) {
  const rating = currentRating[kid] || feedbackCache[kid]?.rating;
  if (!rating) { document.getElementById("status-" + idx).textContent = "Please select a rating first"; return; }
  const comment = document.getElementById("comment-" + idx).value;
  const btn = document.getElementById("submit-" + idx);
  const status = document.getElementById("status-" + idx);
  btn.disabled = true;
  status.textContent = "Submitting...";
  status.className = "feedback-status";
  try {
    const res = await fetch(API_BASE + "/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ knowledge_id: kid, rating, comment }),
    }).then(r => r.json());
    if (res.ok) {
      status.textContent = "\\u2713 Saved";
      status.className = "feedback-status saved";
      feedbackCache[kid] = { rating, comment, at: new Date().toISOString() };
    } else {
      status.textContent = "Failed: " + (res.error || "unknown");
    }
  } catch (e) {
    status.textContent = "Network error: " + e.message;
  }
  btn.disabled = false;
}
</script>
</body>
</html>`;
}

// ── HTTP Server ───────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  resetIdleTimer();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers (for local dev)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Route: GET / — redirect to latest report
  if (pathname === "/" || pathname === "") {
    const dates = getAvailableDates();
    if (dates.length > 0) {
      res.writeHead(302, { Location: "/report/" + dates[0] });
    } else {
      serveHTML(res, generateHTML([], null));
    }
    res.end();
    return;
  }

  // Route: GET /report/:date — serve report page
  const reportMatch = pathname.match(/^\/report\/(\d{4}-\d{2}-\d{2})$/);
  if (reportMatch) {
    const date = reportMatch[1];
    const dates = getAvailableDates();
    serveHTML(res, generateHTML(dates, date));
    return;
  }

  // Route: GET /api/dates — list available dates
  if (pathname === "/api/dates") {
    serveJSON(res, getAvailableDates());
    return;
  }

  // Route: GET /api/report/:date — get report data as JSON
  const apiReportMatch = pathname.match(/^\/api\/report\/(\d{4}-\d{2}-\d{2})$/);
  if (apiReportMatch) {
    serveJSON(res, getReportData(apiReportMatch[1]));
    return;
  }

  // Route: GET /api/feedback/:date — get existing feedback for a date
  const apiFeedbackMatch = pathname.match(/^\/api\/feedback\/(\d{4}-\d{2}-\d{2})$/);
  if (apiFeedbackMatch) {
    serveJSON(res, getFeedbackForDate(apiFeedbackMatch[1]));
    return;
  }

  // Route: POST /api/feedback — submit feedback
  if (pathname === "/api/feedback" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { knowledge_id, rating, comment } = JSON.parse(body);
        if (!knowledge_id || !rating || !["good", "normal", "bad"].includes(rating)) {
          serveJSON(res, { error: "invalid payload: need knowledge_id and rating (good|normal|bad)" }, 400);
          return;
        }
        const result = submitFeedback(knowledge_id, rating, comment);
        serveJSON(res, result, result.error ? 400 : 200);
      } catch {
        serveJSON(res, { error: "invalid JSON" }, 400);
      }
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end("Not Found");
});

function serveJSON(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function serveHTML(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ── Start ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const addr = `http://localhost:${PORT}`;
  console.log(`[report-server] Listening on ${addr}`);
  if (OPEN_BROWSER) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} ${addr}`, err => {
      if (err) console.error(`[report-server] Failed to open browser: ${err.message}`);
    });
  }
  resetIdleTimer();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[report-server] Port ${PORT} in use. Try --port <another_port>`);
    process.exit(1);
  }
  console.error(`[report-server] Error: ${err.message}`);
});

if (!DAEMON) {
  process.on("SIGINT", () => { console.log("\n[report-server] Shutting down"); process.exit(0); });
  process.on("SIGTERM", () => { console.log("[report-server] Shutting down"); process.exit(0); });
}
