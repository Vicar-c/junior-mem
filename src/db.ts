import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export function createDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
    CREATE INDEX IF NOT EXISTS idx_feedback_unconsumed ON knowledge(feedback_rating)
      WHERE feedback_rating IS NOT NULL AND feedback_consumed = 0;
  `);

  migrateFeedbackColumns(db);

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

function migrateFeedbackColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(knowledge)').all().map((c: any) => c.name);
  const feedbackCols: Array<{ name: string; def: string }> = [
    { name: 'feedback_rating', def: 'TEXT' },
    { name: 'feedback_comment', def: 'TEXT' },
    { name: 'feedback_at', def: 'TEXT' },
    { name: 'feedback_consumed', def: 'INTEGER NOT NULL DEFAULT 0' },
  ];
  for (const col of feedbackCols) {
    if (!cols.includes(col.name)) {
      db.exec(`ALTER TABLE knowledge ADD COLUMN ${col.name} ${col.def}`);
    }
  }
}
