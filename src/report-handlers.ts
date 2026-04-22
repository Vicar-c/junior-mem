import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createDatabase } from './db.js';

export interface ReportOp {
  id: number;
  date: string;
  knowledge_id: string;
  operation: string;
  title: string | null;
  body: string | null;
  reasoning: any;
  source_observations: any;
  importance_before: number | null;
  importance_after: number | null;
  tags: any;
  type: string | null;
  created_at: string | null;
}

export interface FeedbackEntry {
  rating: string;
  comment: string | null;
  at: string | null;
}

function openDB(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function safeJSONParse(str: string | null | undefined, fallback: any): any {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export function getAvailableDates(dbPath: string, consolidationDir: string): string[] {
  const dateSet = new Set<string>();

  if (fs.existsSync(consolidationDir)) {
    for (const entry of fs.readdirSync(consolidationDir)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry)) dateSet.add(entry);
    }
  }

  const db = openDB(dbPath);
  if (db) {
    const rows = db.prepare('SELECT DISTINCT date FROM consolidation_ops ORDER BY date DESC').all() as Array<{ date: string }>;
    rows.forEach(r => dateSet.add(r.date));
    db.close();
  }

  return Array.from(dateSet).sort().reverse();
}

export function getReportData(dbPath: string, date: string): {
  date: string;
  ops: ReportOp[];
  stats: { total_active: number; avg_importance: number } | null;
} {
  const db = openDB(dbPath);
  if (!db) return { date, ops: [], stats: null };

  const ops = db.prepare(
    'SELECT * FROM consolidation_ops WHERE date = ? ORDER BY id',
  ).all(date) as any[];

  const statsRow = db.prepare(
    "SELECT COUNT(*) as total_active, ROUND(AVG(importance),1) as avg_importance FROM knowledge WHERE status = 'active'",
  ).get() as any;

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

export function submitFeedback(
  dbPath: string,
  knowledgeId: string,
  rating: string,
  comment?: string | null,
): { ok?: boolean; id?: string; rating?: string; error?: string } {
  const db = openDB(dbPath);
  if (!db) return { error: 'database not found' };

  const existing = db.prepare('SELECT id FROM knowledge WHERE id = ?').get(knowledgeId);
  if (!existing) { db.close(); return { error: 'knowledge not found' }; }

  db.prepare(
    `UPDATE knowledge SET feedback_rating = ?, feedback_comment = ?, feedback_at = datetime('now'), feedback_consumed = 0 WHERE id = ?`,
  ).run(rating, comment || null, knowledgeId);

  db.close();
  return { ok: true, id: knowledgeId, rating };
}

export function getFeedbackForDate(dbPath: string, date: string): Record<string, FeedbackEntry> {
  const db = openDB(dbPath);
  if (!db) return {};

  const ops = db.prepare('SELECT knowledge_id FROM consolidation_ops WHERE date = ?').all(date) as Array<{ knowledge_id: string }>;
  const ids = ops.map(o => o.knowledge_id);
  if (ids.length === 0) { db.close(); return {}; }

  const feedback: Record<string, FeedbackEntry> = {};
  for (const id of ids) {
    const row = db.prepare(
      'SELECT feedback_rating, feedback_comment, feedback_at FROM knowledge WHERE id = ?',
    ).get(id) as any;
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

export { safeJSONParse, openDB };
