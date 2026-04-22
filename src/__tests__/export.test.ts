import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDatabase } from '../db.js';
import { exportToMarkdown } from '../write.js';

function setup(): { db: Database.Database; activeDir: string; knowledgeDir: string } {
  const knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-export-'));
  const activeDir = path.join(knowledgeDir, 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const db = createDatabase(path.join(knowledgeDir, 'test.db'));
  return { db, activeDir, knowledgeDir };
}

describe('exportToMarkdown', () => {
  it('generates .md files for active entries', () => {
    const { db, activeDir, knowledgeDir } = setup();
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k001', 'Test Entry', 'knowledge', 3, 'some body content', '[\"tag1\",\"tag2\"]', 'auto', 'active', '2026-01-01')",
    ).run();

    exportToMarkdown(db, activeDir, knowledgeDir);

    const mdPath = path.join(activeDir, 'k001.md');
    expect(fs.existsSync(mdPath)).toBe(true);
    const content = fs.readFileSync(mdPath, 'utf-8');
    expect(content).toContain('id: "k001"');
    expect(content).toContain('title: "Test Entry"');
    expect(content).toContain('importance: 3');
    expect(content).toContain('some body content');
    expect(content).toContain('tags: ["tag1", "tag2"]');
  });

  it('generates INDEX.md with all active entries', () => {
    const { db, activeDir, knowledgeDir } = setup();
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k001', 'Alpha', 'knowledge', 5, 'a', '[]', 'auto', 'active', '2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k002', 'Beta', 'knowledge', 2, 'b', '[]', 'auto', 'active', '2026-01-01')",
    ).run();

    exportToMarkdown(db, activeDir, knowledgeDir);

    const indexPath = path.join(knowledgeDir, 'INDEX.md');
    expect(fs.existsSync(indexPath)).toBe(true);
    const indexContent = fs.readFileSync(indexPath, 'utf-8');
    expect(indexContent).toContain('Alpha');
    expect(indexContent).toContain('Beta');
  });

  it('skips deprecated entries', () => {
    const { db, activeDir, knowledgeDir } = setup();
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k001', 'Active', 'knowledge', 1, 'a', '[]', 'auto', 'active', '2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k002', 'Deprecated', 'knowledge', 1, 'b', '[]', 'auto', 'deprecated', '2026-01-01')",
    ).run();

    exportToMarkdown(db, activeDir, knowledgeDir);

    expect(fs.existsSync(path.join(activeDir, 'k001.md'))).toBe(true);
    expect(fs.existsSync(path.join(activeDir, 'k002.md'))).toBe(false);
    const indexContent = fs.readFileSync(path.join(knowledgeDir, 'INDEX.md'), 'utf-8');
    expect(indexContent).not.toContain('Deprecated');
  });

  it('regenerates files on each call (no stale files)', () => {
    const { db, activeDir, knowledgeDir } = setup();
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k001', 'Keep', 'knowledge', 1, 'a', '[]', 'auto', 'active', '2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO knowledge (id, title, type, importance, body, tags, source, status, created) VALUES ('k002', 'Remove', 'knowledge', 1, 'b', '[]', 'auto', 'active', '2026-01-01')",
    ).run();

    exportToMarkdown(db, activeDir, knowledgeDir);
    expect(fs.existsSync(path.join(activeDir, 'k002.md'))).toBe(true);

    // Delete k002, re-export
    db.prepare("DELETE FROM knowledge WHERE id = ?").run('k002');
    exportToMarkdown(db, activeDir, knowledgeDir);

    expect(fs.existsSync(path.join(activeDir, 'k001.md'))).toBe(true);
    expect(fs.existsSync(path.join(activeDir, 'k002.md'))).toBe(false);
  });

  it('handles empty database gracefully', () => {
    const { db, activeDir, knowledgeDir } = setup();

    exportToMarkdown(db, activeDir, knowledgeDir);

    const mdFiles = fs.readdirSync(activeDir).filter(f => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(0);
    const indexContent = fs.readFileSync(path.join(knowledgeDir, 'INDEX.md'), 'utf-8');
    expect(indexContent).toContain('Knowledge Index');
  });
});
