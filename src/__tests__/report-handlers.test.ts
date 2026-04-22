import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createDatabase } from '../db.js';
import {
  getAvailableDates,
  getReportData,
  submitFeedback,
  getFeedbackForDate,
} from '../report-handlers.js';

function setup(): { dbPath: string; knowledgeDir: string; consolidationDir: string } {
  const knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-report-'));
  const consolidationDir = path.join(knowledgeDir, 'consolidation');
  fs.mkdirSync(consolidationDir, { recursive: true });
  const dbPath = path.join(knowledgeDir, 'test.db');
  const db = createDatabase(dbPath);

  // Seed some knowledge entries
  db.prepare(
    "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES (?, ?, 'knowledge', 3, 'body', '[]', 'auto', 'active', '2026-01-01')",
  ).run('k001', 'Test entry');
  db.prepare(
    "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES (?, ?, 'knowledge', 2, 'body2', '[]', 'auto', 'active', '2026-01-01')",
  ).run('k002', 'Another entry');

  // Seed consolidation_ops
  db.prepare(
    `INSERT INTO consolidation_ops (date, knowledge_id, operation, title, body, reasoning, source_observations, importance_before, importance_after, tags, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-04-20', 'k001', 'create', 'Test entry', 'body content', '{"scanner":"good"}', '[{"turn":1}]', null, 3, '["tag1"]', 'knowledge');

  db.prepare(
    `INSERT INTO consolidation_ops (date, knowledge_id, operation, title, body, reasoning, source_observations, importance_before, importance_after, tags, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-04-20', 'k002', 'update', 'Another entry', 'updated body', '{}', '[]', 2, 2, '[]', 'knowledge');

  db.close();
  return { dbPath, knowledgeDir, consolidationDir };
}

describe('getAvailableDates', () => {
  it('returns dates from both filesystem and DB', () => {
    const { dbPath, consolidationDir } = setup();
    // Create a filesystem-only date dir
    fs.mkdirSync(path.join(consolidationDir, '2026-04-21'), { recursive: true });

    const dates = getAvailableDates(dbPath, consolidationDir);
    expect(dates).toContain('2026-04-20'); // from DB
    expect(dates).toContain('2026-04-21'); // from filesystem
  });

  it('returns empty when no data exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-report-'));
    const dates = getAvailableDates(path.join(tmpDir, 'nonexistent.db'), tmpDir);
    expect(dates).toEqual([]);
  });

  it('returns dates in reverse order', () => {
    const { dbPath, consolidationDir } = setup();
    const dates = getAvailableDates(dbPath, consolidationDir);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1] >= dates[i]).toBe(true);
    }
  });
});

describe('getReportData', () => {
  it('returns ops and stats for a date', () => {
    const { dbPath } = setup();
    const data = getReportData(dbPath, '2026-04-20');
    expect(data.date).toBe('2026-04-20');
    expect(data.ops).toHaveLength(2);
    expect(data.ops[0].knowledge_id).toBe('k001');
    expect(data.ops[0].reasoning).toEqual({ scanner: 'good' });
    expect(data.ops[0].source_observations).toEqual([{ turn: 1 }]);
    expect(data.stats).not.toBeNull();
    expect(data.stats!.total_active).toBe(2);
  });

  it('returns empty for date with no ops', () => {
    const { dbPath } = setup();
    const data = getReportData(dbPath, '2025-01-01');
    expect(data.ops).toHaveLength(0);
  });

  it('returns null stats when DB does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-report-'));
    const data = getReportData(path.join(tmpDir, 'nope.db'), '2026-04-20');
    expect(data.stats).toBeNull();
    expect(data.ops).toEqual([]);
  });
});

describe('submitFeedback', () => {
  it('stores feedback on an existing entry', () => {
    const { dbPath } = setup();
    const result = submitFeedback(dbPath, 'k001', 'good', 'nice entry');
    expect(result.ok).toBe(true);
    expect(result.rating).toBe('good');

    // Verify in DB
    const db = new Database(dbPath);
    const row = db.prepare('SELECT feedback_rating, feedback_comment, feedback_consumed FROM knowledge WHERE id = ?').get('k001') as any;
    expect(row.feedback_rating).toBe('good');
    expect(row.feedback_comment).toBe('nice entry');
    expect(row.feedback_consumed).toBe(0);
    db.close();
  });

  it('rejects unknown knowledge ID', () => {
    const { dbPath } = setup();
    const result = submitFeedback(dbPath, 'nonexistent', 'good');
    expect(result.error).toBe('knowledge not found');
  });

  it('returns error when DB does not exist', () => {
    const result = submitFeedback('/tmp/nonexistent.db', 'k001', 'good');
    expect(result.error).toBe('database not found');
  });

  it('handles all three rating values', () => {
    const { dbPath } = setup();
    for (const rating of ['good', 'normal', 'bad']) {
      const result = submitFeedback(dbPath, 'k001', rating);
      expect(result.ok).toBe(true);
    }
  });
});

describe('getFeedbackForDate', () => {
  it('returns feedback for entries in a date', () => {
    const { dbPath } = setup();
    // Submit feedback first
    submitFeedback(dbPath, 'k001', 'good', 'useful');
    submitFeedback(dbPath, 'k002', 'bad', 'not helpful');

    const feedback = getFeedbackForDate(dbPath, '2026-04-20');
    expect(feedback['k001'].rating).toBe('good');
    expect(feedback['k001'].comment).toBe('useful');
    expect(feedback['k002'].rating).toBe('bad');
  });

  it('skips entries without feedback', () => {
    const { dbPath } = setup();
    // k001 has no feedback, k002 has feedback
    submitFeedback(dbPath, 'k002', 'normal');

    const feedback = getFeedbackForDate(dbPath, '2026-04-20');
    expect(feedback['k001']).toBeUndefined();
    expect(feedback['k002'].rating).toBe('normal');
  });

  it('returns empty for date with no ops', () => {
    const { dbPath } = setup();
    const feedback = getFeedbackForDate(dbPath, '2025-01-01');
    expect(feedback).toEqual({});
  });
});
