import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { parseTags } from './utils.js';
import type { WriteEntry, WriteResult, KnowledgeRow } from './types.js';

export function writeKnowledge(
  db: Database.Database,
  entries: WriteEntry[],
  activeDir: string,
  knowledgeDir: string,
): WriteResult[] {
  const results: WriteResult[] = [];

  const upsert = db.prepare(`
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

  const deleteStmt = db.prepare('DELETE FROM knowledge WHERE id = ?');
  const archiveStmt = db.prepare("UPDATE knowledge SET status = 'deprecated' WHERE id = ?");
  const reinforceStmt = db.prepare('UPDATE knowledge SET importance = MIN(importance + 1, 5), last_accessed = ? WHERE id = ?');

  const transaction = db.transaction(() => {
    for (const entry of entries) {
      try {
        switch (entry.action) {
          case 'create':
          case 'update': {
            const tags = Array.isArray(entry.tags) ? JSON.stringify(entry.tags) : (entry.tags || '[]');
            upsert.run({
              id: entry.id,
              title: entry.title || '',
              type: entry.type || 'knowledge',
              importance: entry.importance || 1,
              body: entry.body || '',
              tags,
              source: entry.source || 'auto',
              status: entry.status || 'active',
              created: entry.created || new Date().toISOString().split('T')[0],
              last_accessed: entry.last_accessed || new Date().toISOString().split('T')[0],
              access_count: entry.access_count || 0,
            });
            results.push({ id: entry.id, action: entry.action, result: 'ok' });
            break;
          }
          case 'deprecate':
            archiveStmt.run(entry.id);
            results.push({ id: entry.id, action: 'deprecate', result: 'ok' });
            break;
          case 'reinforce':
            reinforceStmt.run(new Date().toISOString().split('T')[0], entry.id);
            results.push({ id: entry.id, action: 'reinforce', result: 'ok' });
            break;
          case 'delete':
            deleteStmt.run(entry.id);
            results.push({ id: entry.id, action: 'delete', result: 'ok' });
            break;
          default:
            results.push({ id: entry.id, action: entry.action, result: 'unknown_action' });
        }
      } catch (err) {
        results.push({ id: entry.id, action: entry.action, result: 'error', error: (err as Error).message });
      }
    }
  });

  transaction();
  exportToMarkdown(db, activeDir, knowledgeDir);
  return results;
}

export function exportToMarkdown(
  db: Database.Database,
  activeDir: string,
  knowledgeDir: string,
): void {
  if (!fs.existsSync(activeDir)) fs.mkdirSync(activeDir, { recursive: true });

  const rows = db.prepare(
    "SELECT * FROM knowledge WHERE status = 'active' ORDER BY importance DESC, id",
  ).all() as KnowledgeRow[];

  for (const f of fs.readdirSync(activeDir).filter(f => f.endsWith('.md'))) {
    fs.unlinkSync(path.join(activeDir, f));
  }

  for (const row of rows) {
    const tags = parseTags(row.tags);
    const tagsStr = tags.length > 0 ? `[${tags.map(t => `"${t}"`).join(', ')}]` : '[]';
    const filename = row.id.replace(/[/\\]/g, '_') + '.md';
    const content = [
      '---',
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
      '---',
      '',
      row.body,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(activeDir, filename), content, 'utf-8');
  }

  const indexPath = path.join(knowledgeDir, 'INDEX.md');
  const lines = ['# Knowledge Index', '', '_Auto-generated from SQLite. Do not edit._', ''];
  for (const row of rows) {
    const tags = parseTags(row.tags);
    lines.push(`- **${row.title}** (\`${row.id}\`) — ${tags.join(', ')}`);
  }
  fs.writeFileSync(indexPath, lines.join('\n') + '\n', 'utf-8');
}
