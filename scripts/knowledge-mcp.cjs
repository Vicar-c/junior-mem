#!/usr/bin/env node
// knowledge-mcp.cjs — MCP stdio server for knowledge retrieval
// Storage: SQLite + FTS5 (primary), Markdown export for human readability
// Tools: knowledge_search, knowledge_get, knowledge_relevant, knowledge_write

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  console.error("FATAL: better-sqlite3 not found. Run: npm install better-sqlite3");
  process.exit(1);
}

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(os.homedir(), ".claude/knowledge");
const DB_PATH = path.join(KNOWLEDGE_DIR, "knowledge.db");
const ACCESS_LOG = path.join(KNOWLEDGE_DIR, "access_log.jsonl");
const CONFIG_FILE = path.join(KNOWLEDGE_DIR, "config.json");
const ACTIVE_DIR = path.join(KNOWLEDGE_DIR, "active");

// ── Init Check ────────────────────────────────────────────────────────────

const INITIALIZED = fs.existsSync(CONFIG_FILE);

function initWarning() {
  return "⚠ junior-mem is not initialized. Please run /junior-mem:init in Claude Code to complete setup.";
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); }
  catch { return { soft_limit: 1000 }; }
}
const CONFIG = loadConfig();

// ── Database Init ────────────────────────────────────────────────────────

function initDB() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'knowledge',
      importance INTEGER NOT NULL DEFAULT 1,
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'active',
      created TEXT NOT NULL DEFAULT '',
      last_accessed TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      feedback_rating TEXT,
      feedback_comment TEXT,
      feedback_at TEXT,
      feedback_consumed INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      title,
      body,
      tags,
      content='knowledge',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS consolidation_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      knowledge_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      title TEXT,
      body TEXT,
      reasoning TEXT,
      source_observations TEXT,
      importance_before INTEGER,
      importance_after INTEGER,
      tags TEXT,
      type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_importance ON knowledge(importance);
    CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge(status);
    CREATE INDEX IF NOT EXISTS idx_consol_ops_date ON consolidation_ops(date);
    CREATE INDEX IF NOT EXISTS idx_feedback_unconsumed ON knowledge(feedback_rating) WHERE feedback_rating IS NOT NULL AND feedback_consumed = 0;
  `);

  // Migrate: add feedback columns if missing (for existing databases)
  const cols = db.prepare("PRAGMA table_info(knowledge)").all().map(c => c.name);
  const feedbackCols = ["feedback_rating", "feedback_comment", "feedback_at", "feedback_consumed"];
  for (const col of feedbackCols) {
    if (!cols.includes(col)) {
      const def = col === "feedback_consumed" ? "INTEGER NOT NULL DEFAULT 0" : "TEXT";
      db.exec(`ALTER TABLE knowledge ADD COLUMN ${col} ${def}`);
    }
  }

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS fts_insert AFTER INSERT ON knowledge BEGIN
      INSERT INTO fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS fts_delete AFTER DELETE ON knowledge BEGIN
      INSERT INTO fts(fts, rowid, title, body, tags) VALUES('delete', old.rowid, old.title, old.body, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS fts_update AFTER UPDATE ON knowledge BEGIN
      INSERT INTO fts(fts, rowid, title, body, tags) VALUES('delete', old.rowid, old.title, old.body, old.tags);
      INSERT INTO fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
    END;
  `);

  return db;
}

let db;
function getDB() {
  if (!db) db = initDB();
  return db;
}

// ── Utilities ────────────────────────────────────────────────────────────

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string") {
    if (tags.startsWith("[")) {
      try { return JSON.parse(tags); } catch { return [tags]; }
    }
    return tags.split(",").map(t => t.trim()).filter(Boolean);
  }
  return [];
}

function appendAccessLog(id, op) {
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  const entry = JSON.stringify({ id, ts: new Date().toISOString(), op }) + "\n";
  fs.appendFileSync(ACCESS_LOG, entry);
}

function rowToResult(row) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    importance: row.importance,
    tags: parseTags(row.tags),
    source: row.source,
    status: row.status,
    created: row.created,
    last_accessed: row.last_accessed,
    access_count: row.access_count,
    body: row.body,
  };
}

// ── Search ──────────────────────────────────────────────────────────────

function searchKnowledge(query, options = {}) {
  const { tags, type, minImportance, limit = 10, status = "active" } = options;
  const d = getDB();

  const words = query.replace(/["'*:]/g, "").split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return [];

  // Split words into FTS-friendly (ascii/alphanumeric) and CJK (need LIKE fallback)
  const ftsWords = words.filter(w => /[a-zA-Z0-9]/.test(w));
  const cjkWords = words.filter(w => !/[a-zA-Z0-9]/.test(w));

  // Build WHERE conditions
  const conditions = [];
  const params = [];

  if (status) { conditions.push("k.status = ?"); params.push(status); }
  if (type) { conditions.push("k.type = ?"); params.push(type); }
  if (minImportance) { conditions.push("k.importance >= ?"); params.push(minImportance); }

  // Tag filtering
  if (tags) {
    const searchTags = Array.isArray(tags) ? tags : [tags];
    for (const tag of searchTags) {
      conditions.push("k.tags LIKE ?");
      params.push(`%"${tag}"%`);
    }
  }

  // FTS5 for ascii words, LIKE for CJK
  let scoreExpr = "k.importance";
  let fromClause = "knowledge k";

  if (ftsWords.length > 0) {
    fromClause = "knowledge k JOIN fts ON k.rowid = fts.rowid";
    conditions.push("fts MATCH ?");
    params.push(ftsWords.join(" OR "));
    scoreExpr = "(bm25(fts) * -1) + k.importance";
  }

  // CJK LIKE matching (substring match in title or body)
  for (const cjk of cjkWords) {
    conditions.push("(k.title LIKE ? OR k.body LIKE ? OR k.tags LIKE ?)");
    params.push(`%${cjk}%`, `%${cjk}%`, `%${cjk}%`);
    // Bonus for CJK matches: add to score
  }

  // If no FTS words, fall back to full table scan with LIKE for all words
  if (ftsWords.length === 0) {
    for (const w of cjkWords) {
      // Already added above
    }
  }

  const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const sql = `SELECT k.*, ${scoreExpr} AS score FROM ${fromClause} ${whereClause} ORDER BY score DESC LIMIT ?`;
  params.push(limit);

  const rows = d.prepare(sql).all(...params);
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    type: row.type,
    importance: row.importance,
    tags: parseTags(row.tags),
    source: row.source,
    score: Math.round((row.score + 0.01) * 100) / 100,
    snippet: row.body.substring(0, 200),
  }));
}

// ── Get ──────────────────────────────────────────────────────────────────

function getKnowledge(ids) {
  const d = getDB();
  return ids.map(id => {
    const row = d.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(id);
    if (!row) return { id, error: "not found" };
    // Update access stats
    const now = new Date().toISOString().split("T")[0];
    d.prepare(`UPDATE knowledge SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?`).run(now, id);
    appendAccessLog(id, "get");
    return rowToResult(row);
  });
}

// ── Relevant ─────────────────────────────────────────────────────────────

function getRelevant(taskDescription, options = {}) {
  return searchKnowledge(taskDescription, { minImportance: 2, limit: options.limit || 5 });
}

// ── Write (for consolidation executor) ──────────────────────────────────

function writeKnowledge(entries) {
  const d = getDB();
  const results = [];

  const upsert = d.prepare(`
    INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created, last_accessed, access_count)
    VALUES (@id, @title, @type, @importance, @body, @tags, @source, @status, @created, @last_accessed, @access_count)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      type = excluded.type,
      importance = excluded.importance,
      body = excluded.body,
      tags = excluded.tags,
      source = excluded.source,
      status = excluded.status,
      last_accessed = COALESCE(NULLIF(excluded.last_accessed, ''), knowledge.last_accessed),
      access_count = CASE WHEN excluded.access_count > 0 THEN excluded.access_count ELSE knowledge.access_count END
  `);

  const deleteStmt = d.prepare(`DELETE FROM knowledge WHERE id = ?`);
  const archiveStmt = d.prepare(`UPDATE knowledge SET status = 'deprecated' WHERE id = ?`);
  const reinforceStmt = d.prepare(`UPDATE knowledge SET importance = MIN(importance + 1, 5), last_accessed = ? WHERE id = ?`);

  const transaction = d.transaction(() => {
    for (const entry of entries) {
      try {
        switch (entry.action) {
          case "create":
          case "update": {
            const tags = Array.isArray(entry.tags) ? JSON.stringify(entry.tags) : (entry.tags || "[]");
            upsert.run({
              id: entry.id,
              title: entry.title || "",
              type: entry.type || "knowledge",
              importance: entry.importance || 1,
              body: entry.body || "",
              tags,
              source: entry.source || "auto",
              status: entry.status || "active",
              created: entry.created || new Date().toISOString().split("T")[0],
              last_accessed: entry.last_accessed || new Date().toISOString().split("T")[0],
              access_count: entry.access_count || 0,
            });
            results.push({ id: entry.id, action: entry.action, result: "ok" });
            break;
          }
          case "deprecate":
            archiveStmt.run(entry.id);
            results.push({ id: entry.id, action: "deprecate", result: "ok" });
            break;
          case "reinforce":
            reinforceStmt.run(new Date().toISOString().split("T")[0], entry.id);
            results.push({ id: entry.id, action: "reinforce", result: "ok" });
            break;
          case "delete":
            deleteStmt.run(entry.id);
            results.push({ id: entry.id, action: "delete", result: "ok" });
            break;
          default:
            results.push({ id: entry.id, action: entry.action, result: "unknown_action" });
        }
      } catch (err) {
        results.push({ id: entry.id, action: entry.action, result: "error", error: err.message });
      }
    }
  });

  transaction();
  exportToMarkdown();
  return results;
}

// ── Markdown Export ──────────────────────────────────────────────────────

function exportToMarkdown() {
  const d = getDB();
  if (!fs.existsSync(ACTIVE_DIR)) fs.mkdirSync(ACTIVE_DIR, { recursive: true });

  const rows = d.prepare(`SELECT * FROM knowledge WHERE status = 'active' ORDER BY importance DESC, id`).all();

  // Delete existing markdown files (will be regenerated)
  for (const f of fs.readdirSync(ACTIVE_DIR).filter(f => f.endsWith(".md"))) {
    fs.unlinkSync(path.join(ACTIVE_DIR, f));
  }

  for (const row of rows) {
    const tags = parseTags(row.tags);
    const tagsStr = tags.length > 0 ? `[${tags.map(t => `"${t}"`).join(", ")}]` : "[]";
    const filename = row.id.replace(/[\/\\]/g, "_") + ".md";
    const content = [
      "---",
      `id: "${row.id}"`,
      `type: ${row.type}`,
      `status: ${row.status}`,
      `importance: ${row.importance}`,
      `created: "${row.created}"`,
      `last_accessed: "${row.last_accessed || row.created}"`,
      `access_count: ${row.access_count}`,
      `source: ${row.source}`,
      `tags: ${tagsStr}`,
      `title: "${row.title}"`,
      "---",
      "",
      row.body,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(ACTIVE_DIR, filename), content, "utf-8");
  }

  // Generate INDEX.md
  const indexPath = path.join(KNOWLEDGE_DIR, "INDEX.md");
  const lines = ["# Knowledge Index", "", "_Auto-generated from SQLite. Do not edit._", ""];
  for (const row of rows) {
    const tags = parseTags(row.tags);
    lines.push(`- **${row.title}** (\`${row.id}\`) — ${tags.join(", ")}`);
  }
  fs.writeFileSync(indexPath, lines.join("\n") + "\n", "utf-8");
}

// ── Stats ────────────────────────────────────────────────────────────────

function getStats() {
  if (!INITIALIZED) {
    return { initialized: false, message: initWarning() };
  }
  const d = getDB();
  const total = d.prepare(`SELECT COUNT(*) as count FROM knowledge WHERE status = 'active'`).get().count;
  const archived = d.prepare(`SELECT COUNT(*) as count FROM knowledge WHERE status = 'deprecated'`).get().count;
  const byType = d.prepare(`SELECT type, COUNT(*) as count FROM knowledge WHERE status = 'active' GROUP BY type`).all();
  const avgImportance = d.prepare(`SELECT AVG(importance) as avg FROM knowledge WHERE status = 'active'`).get().avg || 0;
  const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  return { initialized: true, total, archived, byType, avgImportance: Math.round(avgImportance * 10) / 10, dbSize };
}

// ── MCP Protocol ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "knowledge_search",
    description: "Search knowledge base using FTS5 full-text search with BM25 ranking. Returns matching entries with ID, title, snippet and score.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (supports OR for multiple terms)" },
        tags: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Filter by tags",
        },
        type: { type: "string", description: "Filter by type: knowledge|feedback|project|reference|env_config" },
        min_importance: { type: "number", description: "Minimum importance (1-5)" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "knowledge_get",
    description: "Get full content of knowledge entries by ID. Returns all fields including body. Updates access_count automatically.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Knowledge entry ID(s) — single ID string or array",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "knowledge_relevant",
    description: "Find knowledge relevant to a task description. Uses FTS5 with BM25 ranking, only returns importance >= 2 entries. Good for auto-context before starting work.",
    inputSchema: {
      type: "object",
      properties: {
        task_description: { type: "string", description: "Describe the task to find relevant knowledge" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["task_description"],
    },
  },
  {
    name: "knowledge_write",
    description: "Write/modify knowledge entries. Supports create, update, reinforce (importance+1), deprecate, delete. Used by consolidation pipeline. Triggers markdown export.",
    inputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["create", "update", "reinforce", "deprecate", "delete"] },
              id: { type: "string" },
              title: { type: "string" },
              type: { type: "string" },
              importance: { type: "number" },
              body: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              source: { type: "string" },
            },
            required: ["action", "id"],
          },
          description: "Array of knowledge write operations",
        },
      },
      required: ["entries"],
    },
  },
  {
    name: "knowledge_stats",
    description: "Get knowledge base statistics: total active, archived, by type, average importance, DB size.",
    inputSchema: { type: "object", properties: {} },
  },
];

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "knowledge-mcp", version: "0.2.0" },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    // Block all tools except stats when not initialized
    if (!INITIALIZED && toolName !== "knowledge_stats") {
      sendResponse(id, {
        content: [{ type: "text", text: JSON.stringify({ error: "not_initialized", message: initWarning() }) }],
      });
      return;
    }

    try {
      let result;
      switch (toolName) {
        case "knowledge_search":
          result = searchKnowledge(args.query, {
            tags: args.tags,
            type: args.type,
            minImportance: args.min_importance,
            limit: args.limit,
          });
          break;

        case "knowledge_get": {
          const ids = Array.isArray(args.ids) ? args.ids : [args.ids];
          result = getKnowledge(ids);
          break;
        }

        case "knowledge_relevant":
          result = getRelevant(args.task_description, { limit: args.limit });
          break;

        case "knowledge_write":
          result = writeKnowledge(args.entries);
          break;

        case "knowledge_stats":
          result = getStats();
          break;

        default:
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          return;
      }
      sendResponse(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      sendError(id, -32000, err.message);
    }
    return;
  }

  if (method === "ping") {
    sendResponse(id, {});
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

// ── Main loop ────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    handleRequest(req);
  } catch {
    // Ignore malformed input
  }
});

rl.on("close", () => {
  if (db) db.close();
  process.exit(0);
});
