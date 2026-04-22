import Database from 'better-sqlite3';
import fs from 'fs';
import type { KnowledgeStats } from './types.js';

export function getStats(db: Database.Database, dbPath: string, initialized: boolean): KnowledgeStats {
  if (!initialized) {
    return { initialized: false, message: 'Not initialized. Run /junior-mem:init to complete setup.' };
  }
  const total = (db.prepare("SELECT COUNT(*) as count FROM knowledge WHERE status = 'active'").get() as any).count;
  const archived = (db.prepare("SELECT COUNT(*) as count FROM knowledge WHERE status = 'deprecated'").get() as any).count;
  const byType = db.prepare("SELECT type, COUNT(*) as count FROM knowledge WHERE status = 'active' GROUP BY type").all() as Array<{ type: string; count: number }>;
  const avgRow = db.prepare("SELECT AVG(importance) as avg FROM knowledge WHERE status = 'active'").get() as any;
  const avgImportance = avgRow?.avg || 0;
  const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  return { initialized: true, total, archived, byType, avgImportance: Math.round(avgImportance * 10) / 10, dbSize };
}
