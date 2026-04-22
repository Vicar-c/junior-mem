import Database from 'better-sqlite3';
import { parseTags } from './utils.js';
import type { KnowledgeRow, KnowledgeEntry, SearchResult, SearchOptions } from './types.js';

export function rowToEntry(row: KnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    importance: row.importance,
    tags: parseTags(row.tags),
    source: row.source,
    status: row.status,
    created: row.created,
    last_accessed: row.last_accessed || undefined,
    access_count: row.access_count,
    body: row.body,
  };
}

export function searchKnowledge(
  db: Database.Database,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const { tags, type, minImportance, limit = 10, status = 'active' } = options;

  const words = query.replace(/["'*:]/g, '').split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return [];

  const ftsWords = words.filter(w => /[a-zA-Z0-9]/.test(w));
  const cjkWords = words.filter(w => !/[a-zA-Z0-9]/.test(w));

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) { conditions.push('k.status = ?'); params.push(status); }
  if (type) { conditions.push('k.type = ?'); params.push(type); }
  if (minImportance) { conditions.push('k.importance >= ?'); params.push(minImportance); }

  if (tags) {
    const searchTags = Array.isArray(tags) ? tags : [tags];
    for (const tag of searchTags) {
      conditions.push('k.tags LIKE ?');
      params.push(`%"${tag}"%`);
    }
  }

  let scoreExpr = 'k.importance';
  let fromClause = 'knowledge k';

  if (ftsWords.length > 0) {
    fromClause = 'knowledge k JOIN fts ON k.rowid = fts.rowid';
    conditions.push('fts MATCH ?');
    params.push(ftsWords.join(' OR '));
    scoreExpr = '(bm25(fts) * -1) + k.importance';
  }

  for (const cjk of cjkWords) {
    conditions.push('(k.title LIKE ? OR k.body LIKE ? OR k.tags LIKE ?)');
    params.push(`%${cjk}%`, `%${cjk}%`, `%${cjk}%`);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const sql = `SELECT k.*, ${scoreExpr} AS score FROM ${fromClause} ${whereClause} ORDER BY score DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<KnowledgeRow & { score: number }>;
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

export function getKnowledge(
  db: Database.Database,
  ids: string[],
  accessLogPath?: string,
): Array<KnowledgeEntry | { id: string; error: string }> {
  const now = new Date().toISOString().split('T')[0];
  return ids.map(id => {
    const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as KnowledgeRow | undefined;
    if (!row) return { id, error: 'not found' };
    db.prepare('UPDATE knowledge SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?').run(now, id);
    if (accessLogPath) {
      const entry = JSON.stringify({ id, ts: new Date().toISOString(), op: 'get' }) + '\n';
      const fs = require('fs');
      fs.appendFileSync(accessLogPath, entry);
    }
    return rowToEntry(row);
  });
}

export function getRelevant(
  db: Database.Database,
  taskDescription: string,
  options: { limit?: number } = {},
): SearchResult[] {
  return searchKnowledge(db, taskDescription, { minImportance: 2, limit: options.limit || 5 });
}
