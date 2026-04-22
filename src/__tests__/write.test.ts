import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDatabase } from '../db.js';
import { writeKnowledge } from '../write.js';
import type { WriteEntry } from '../types.js';

function setup(): { db: Database.Database; activeDir: string; knowledgeDir: string } {
  const knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-write-'));
  const activeDir = path.join(knowledgeDir, 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const db = createDatabase(path.join(knowledgeDir, 'test.db'));
  return { db, activeDir, knowledgeDir };
}

describe('writeKnowledge — create', () => {
  let db: Database.Database;
  let activeDir: string;
  let knowledgeDir: string;

  beforeEach(() => {
    ({ db, activeDir, knowledgeDir } = setup());
  });

  it('creates a new entry', () => {
    const results = writeKnowledge(db, [{
      action: 'create', id: 'k001', title: 'Test', body: 'Body', tags: ['a', 'b'], importance: 3,
    }], activeDir, knowledgeDir);
    expect(results[0].result).toBe('ok');
    const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get('k001') as any;
    expect(row.title).toBe('Test');
    expect(row.importance).toBe(3);
    expect(JSON.parse(row.tags)).toEqual(['a', 'b']);
  });

  it('upserts on create with existing ID', () => {
    writeKnowledge(db, [{ action: 'create', id: 'k001', title: 'V1', body: 'old' }], activeDir, knowledgeDir);
    writeKnowledge(db, [{ action: 'create', id: 'k001', title: 'V2', body: 'new' }], activeDir, knowledgeDir);
    const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get('k001') as any;
    expect(row.title).toBe('V2');
    expect(row.body).toBe('new');
  });
});

describe('writeKnowledge — update', () => {
  let db: Database.Database;
  let activeDir: string;
  let knowledgeDir: string;

  beforeEach(() => {
    ({ db, activeDir, knowledgeDir } = setup());
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k001', 'Old', 'knowledge', 2, 'old body', '[]', 'auto', 'active', '2026-01-01')",
    ).run();
  });

  it('updates existing entry', () => {
    const results = writeKnowledge(db, [{
      action: 'update', id: 'k001', title: 'Updated', body: 'new body', importance: 4,
    }], activeDir, knowledgeDir);
    expect(results[0].result).toBe('ok');
    const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get('k001') as any;
    expect(row.title).toBe('Updated');
    expect(row.importance).toBe(4);
  });
});

describe('writeKnowledge — reinforce', () => {
  let db: Database.Database;
  let activeDir: string;
  let knowledgeDir: string;

  beforeEach(() => {
    ({ db, activeDir, knowledgeDir } = setup());
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k001', 'Test', 'knowledge', 3, 'body', '[]', 'auto', 'active', '2026-01-01')",
    ).run();
  });

  it('increments importance by 1 (max 5)', () => {
    writeKnowledge(db, [{ action: 'reinforce', id: 'k001' }], activeDir, knowledgeDir);
    const row = db.prepare('SELECT importance FROM knowledge WHERE id = ?').get('k001') as any;
    expect(row.importance).toBe(4);
  });

  it('caps importance at 5', () => {
    db.prepare('UPDATE knowledge SET importance = 5 WHERE id = ?').run('k001');
    writeKnowledge(db, [{ action: 'reinforce', id: 'k001' }], activeDir, knowledgeDir);
    const row = db.prepare('SELECT importance FROM knowledge WHERE id = ?').get('k001') as any;
    expect(row.importance).toBe(5);
  });
});

describe('writeKnowledge — deprecate', () => {
  let db: Database.Database;
  let activeDir: string;
  let knowledgeDir: string;

  beforeEach(() => {
    ({ db, activeDir, knowledgeDir } = setup());
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k001', 'Test', 'knowledge', 1, 'body', '[]', 'auto', 'active', '2026-01-01')",
    ).run();
  });

  it('marks entry as deprecated', () => {
    const results = writeKnowledge(db, [{ action: 'deprecate', id: 'k001' }], activeDir, knowledgeDir);
    expect(results[0].result).toBe('ok');
    const row = db.prepare('SELECT status FROM knowledge WHERE id = ?').get('k001') as any;
    expect(row.status).toBe('deprecated');
  });
});

describe('writeKnowledge — delete', () => {
  let db: Database.Database;
  let activeDir: string;
  let knowledgeDir: string;

  beforeEach(() => {
    ({ db, activeDir, knowledgeDir } = setup());
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k001', 'Test', 'knowledge', 1, 'body', '[]', 'auto', 'active', '2026-01-01')",
    ).run();
  });

  it('removes entry entirely', () => {
    const results = writeKnowledge(db, [{ action: 'delete', id: 'k001' }], activeDir, knowledgeDir);
    expect(results[0].result).toBe('ok');
    const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get('k001');
    expect(row).toBeUndefined();
  });
});

describe('writeKnowledge — unknown action', () => {
  it('returns unknown_action result', () => {
    const { db, activeDir, knowledgeDir } = setup();
    const results = writeKnowledge(db, [{ action: 'foobar' as any, id: 'k001' }], activeDir, knowledgeDir);
    expect(results[0].result).toBe('unknown_action');
  });
});

describe('writeKnowledge — transaction atomicity', () => {
  it('all succeed or all fail together', () => {
    const { db, activeDir, knowledgeDir } = setup();
    const results = writeKnowledge(db, [
      { action: 'create', id: 'k1', title: 'A', body: 'a' },
      { action: 'create', id: 'k2', title: 'B', body: 'b' },
      { action: 'create', id: 'k3', title: 'C', body: 'c' },
    ], activeDir, knowledgeDir);
    expect(results.every(r => r.result === 'ok')).toBe(true);
    const count = (db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status = 'active'").get() as any).c;
    expect(count).toBe(3);
  });
});
