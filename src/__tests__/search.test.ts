import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../db.js';
import { searchKnowledge, getKnowledge, getRelevant } from '../search.js';
import { writeKnowledge } from '../write.js';
import type { WriteEntry } from '../types.js';

describe('searchKnowledge', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const fs = require('fs');
    const os = require('os');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-test-'));
    const { join } = require('path');
    db = createDatabase(join(tmpDir, 'test.db'));
  });

  // Helper: insert entries directly
  function seed(entries: Array<{ id: string; title: string; body: string; importance?: number; tags?: string; type?: string }>) {
    const stmt = db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES (?, ?, ?, ?, ?, ?, 'auto', 'active', '2026-01-01')",
    );
    for (const e of entries) {
      stmt.run(e.id, e.title, e.type || 'knowledge', e.importance || 1, e.body, e.tags || '[]');
    }
  }

  it('finds entries by ASCII keyword via FTS5', () => {
    seed([
      { id: 'k1', title: 'HTTP timeout patterns', body: 'Use 3s timeout for external API calls' },
      { id: 'k2', title: 'Database connection pool', body: 'Max pool size: 20 connections' },
    ]);
    const results = searchKnowledge(db, 'timeout');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('k1');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('finds entries by CJK substring via LIKE', () => {
    seed([
      { id: 'k1', title: '编码规范', body: '使用 UTF-8 编码格式' },
      { id: 'k2', title: '部署流程', body: '先编译再部署到生产环境' },
    ]);
    const results = searchKnowledge(db, '编码');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.id === 'k1')).toBe(true);
  });

  it('combines FTS and CJK results', () => {
    seed([
      { id: 'k1', title: 'TAF JCE 编码规范', body: 'JCE 序列化使用 UTF-8' },
    ]);
    const results = searchKnowledge(db, 'JCE 编码');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('k1');
  });

  it('respects importance filter', () => {
    seed([
      { id: 'k1', title: 'Low importance', body: 'test content', importance: 1 },
      { id: 'k2', title: 'High importance', body: 'test content important', importance: 4 },
    ]);
    const results = searchKnowledge(db, 'important', { minImportance: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('k2');
  });

  it('respects type filter', () => {
    seed([
      { id: 'k1', title: 'Some config', body: 'config value', type: 'env_config' },
      { id: 'k2', title: 'Some knowledge', body: 'knowledge value', type: 'knowledge' },
    ]);
    const results = searchKnowledge(db, 'value', { type: 'env_config' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('k1');
  });

  it('respects tag filter', () => {
    seed([
      { id: 'k1', title: 'Tagged entry', body: 'content', tags: '["taf","jce"]' },
      { id: 'k2', title: 'Other entry', body: 'content', tags: '["react"]' },
    ]);
    const results = searchKnowledge(db, 'content', { tags: 'taf' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('k1');
  });

  it('excludes deprecated entries by default', () => {
    seed([{ id: 'k1', title: 'Old stuff', body: 'deprecated content' }]);
    db.prepare("UPDATE knowledge SET status = 'deprecated' WHERE id = ?").run('k1');
    const results = searchKnowledge(db, 'deprecated');
    expect(results).toHaveLength(0);
  });

  it('returns empty for short query words', () => {
    seed([{ id: 'k1', title: 'test', body: 'test content here' }]);
    const results = searchKnowledge(db, 'a');
    expect(results).toHaveLength(0);
  });

  it('respects limit', () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      id: `k${i}`, title: `Entry ${i}`, body: 'shared content keyword',
    }));
    seed(entries);
    const results = searchKnowledge(db, 'keyword', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('BM25 + importance boosts high-importance entries', () => {
    seed([
      { id: 'k1', title: 'cache invalidation', body: 'cache invalidation strategy pattern', importance: 5 },
      { id: 'k2', title: 'cache setup', body: 'cache setup configuration pattern', importance: 1 },
    ]);
    const results = searchKnowledge(db, 'cache');
    expect(results[0].id).toBe('k1'); // higher importance should rank first
  });
});

describe('getKnowledge', () => {
  let db: Database.Database;

  beforeEach(() => {
    const fs = require('fs');
    const os = require('os');
    const { join } = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-test-'));
    db = createDatabase(join(tmpDir, 'test.db'));
    const stmt = db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES (?, ?, 'knowledge', 3, ?, '[]', 'auto', 'active', '2026-01-01')",
    );
    stmt.run('k1', 'Test entry', 'some body content');
  });

  it('returns full entry by ID', () => {
    const results = getKnowledge(db, ['k1']);
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('id', 'k1');
    expect(results[0]).toHaveProperty('body', 'some body content');
  });

  it('increments access count', () => {
    getKnowledge(db, ['k1']);
    getKnowledge(db, ['k1']);
    const row = db.prepare('SELECT access_count FROM knowledge WHERE id = ?').get('k1') as any;
    expect(row.access_count).toBe(2);
  });

  it('returns error for non-existent ID', () => {
    const results = getKnowledge(db, ['nonexistent']);
    expect(results[0]).toHaveProperty('error', 'not found');
  });
});

describe('getRelevant', () => {
  let db: Database.Database;

  beforeEach(() => {
    const fs = require('fs');
    const os = require('os');
    const { join } = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-test-'));
    db = createDatabase(join(tmpDir, 'test.db'));
    const stmt = db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES (?, ?, 'knowledge', ?, ?, '[]', 'auto', 'active', '2026-01-01')",
    );
    stmt.run('k1', 'Low importance', 1, 'common keyword');
    stmt.run('k2', 'High importance', 4, 'common keyword advanced');
  });

  it('only returns importance >= 2 entries', () => {
    const results = getRelevant(db, 'keyword');
    expect(results.every(r => r.importance >= 2)).toBe(true);
    expect(results.some(r => r.id === 'k1')).toBe(false);
  });
});

const path = require('path');
