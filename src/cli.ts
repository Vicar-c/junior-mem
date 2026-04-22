#!/usr/bin/env node
// cli.ts — CLI subcommands for consolidate.sh, replacing inline node -e scripts

import fs from 'fs';
import Database from 'better-sqlite3';

function openDB(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

// ── Subcommands ──────────────────────────────────────────────────────────

function readUnconsumedFeedback(dbPath: string): void {
  const db = openDB(dbPath);
  if (!db) { console.log('[]'); return; }
  const rows = db.prepare(
    'SELECT id, title, body, feedback_rating, feedback_comment, feedback_at FROM knowledge WHERE feedback_rating IS NOT NULL AND feedback_consumed = 0 ORDER BY feedback_at DESC LIMIT 20',
  ).all();
  console.log(JSON.stringify(rows));
  db.close();
}

function consumeFeedback(dbPath: string): void {
  const db = openDB(dbPath);
  if (!db) return;
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE knowledge SET importance = MIN(5, importance + 1) WHERE feedback_rating = ? AND feedback_consumed = 0',
    ).run('good');

    db.prepare(
      'UPDATE knowledge SET importance = MAX(1, importance - 1) WHERE feedback_rating = ? AND feedback_consumed = 0 AND importance > 1',
    ).run('bad');

    db.prepare(
      'UPDATE knowledge SET status = ? WHERE feedback_rating = ? AND feedback_consumed = 0 AND importance = 1',
    ).run('deprecated', 'bad');

    db.prepare(
      'UPDATE knowledge SET feedback_consumed = 1 WHERE feedback_rating IS NOT NULL AND feedback_consumed = 0',
    ).run();
  });
  tx();
  console.log('Feedback consumed');
  db.close();
}

function generateCalibrationText(): void {
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => { input += chunk; });
  process.stdin.on('end', () => {
    const feedback = JSON.parse(input || '[]');
    if (!Array.isArray(feedback) || feedback.length === 0) { console.log(''); return; }
    const lines = [
      'User preference calibration — recent feedback on knowledge quality:',
      'These are knowledge entries the user reviewed. Each includes what was rated, the rating, and the user\'s comment.',
      'Use these to calibrate your own extraction judgment — understand what the user values and what they don\'t.',
    ];
    feedback.forEach((f: any, i: number) => {
      const rating: Record<string, string> = { good: '[GOOD]', normal: '[NORMAL]', bad: '[BAD]' };
      const tag = rating[f.feedback_rating] || '[?]';
      const title = f.title || f.id;
      lines.push(`${i + 1}. ${tag} "${title}"`);
      if (f.body) {
        const snippet = f.body.length > 200 ? f.body.slice(0, 200) + '...' : f.body;
        lines.push(`   Content: "${snippet}"`);
      }
      if (f.feedback_comment) {
        lines.push(`   User comment: "${f.feedback_comment}"`);
      }
    });
    console.log(lines.join('\n'));
  });
}

function writeConsolidationOps(
  dbPath: string,
  date: string,
  decisionsFile: string,
  proposalsFile: string,
  challengesFile: string,
): void {
  const db = openDB(dbPath);
  if (!db) return;

  const decisions = JSON.parse(fs.readFileSync(decisionsFile, 'utf-8'));
  const proposals = fs.existsSync(proposalsFile)
    ? JSON.parse(fs.readFileSync(proposalsFile, 'utf-8'))
    : { proposals: [] };
  const challenges = fs.existsSync(challengesFile)
    ? JSON.parse(fs.readFileSync(challengesFile, 'utf-8'))
    : { challenges: [] };

  // Also try to read 05-entries.json for real knowledge IDs
  const entriesFile = decisionsFile.replace('03-decisions.json', '05-entries.json');
  const entries = fs.existsSync(entriesFile)
    ? JSON.parse(fs.readFileSync(entriesFile, 'utf-8'))
    : [];

  // Build index: proposal_id → actual knowledge_id from executor entries
  const proposalIds = (decisions.decisions || []).map((d: any) => d.proposal_id);
  const entryMap: Record<string, string> = {};
  entries.forEach((e: any, i: number) => {
    if (proposalIds[i]) entryMap[proposalIds[i]] = e.id;
  });
  entries.forEach((e: any) => {
    if (!Object.values(entryMap).includes(e.id)) {
      const match = (decisions.decisions || []).find((d: any) => {
        const p = (proposals.proposals || []).find((p2: any) => p2.id === d.proposal_id);
        return p && p.title === e.title;
      });
      if (match) entryMap[match.proposal_id] = e.id;
    }
  });

  const insertOp = db.prepare(
    'INSERT INTO consolidation_ops (date, knowledge_id, operation, title, body, reasoning, source_observations, importance_before, importance_after, tags, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  const pMap: Record<string, any> = {};
  (proposals.proposals || []).forEach((p: any) => { pMap[p.id] = p; });
  const cMap: Record<string, any> = {};
  (challenges.challenges || []).forEach((c: any) => { cMap[c.proposal_id] = c; });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM consolidation_ops WHERE date = ?').run(date);

    for (const d of (decisions.decisions || [])) {
      const p = pMap[d.proposal_id] || {};
      const c = cMap[d.proposal_id];
      const action = (d.final_action || {}).action || d.decision || 'unknown';
      const fa = d.final_action || {};
      const realKid = entryMap[d.proposal_id] || fa.target_id || d.proposal_id || '';

      const reasoning = {
        scanner: p.reasoning || '',
        challenger: c ? (c.dimension + ': ' + c.reasoning) : '',
        auditor: d.reasoning || '',
      };

      insertOp.run(
        date,
        realKid,
        action === 'approved' ? (p.action || 'create') :
          action === 'modified' ? (p.action || 'update') :
          action === 'rejected' ? 'reject' : action,
        fa.title || p.title || '',
        fa.content_draft || p.content_draft || '',
        JSON.stringify(reasoning),
        JSON.stringify(p.source_staging ? [{ turn: p.source_staging }] : []),
        null,
        fa.importance || p.importance || null,
        JSON.stringify(fa.tags || p.tags || []),
        fa.type || p.type || p.source_type || 'knowledge',
      );
    }
  });
  tx();
  console.log(`Consolidation ops written for ${date}`);
  db.close();
}

function readActiveSummary(dbPath: string): void {
  const db = openDB(dbPath);
  if (!db) { console.log('[]'); return; }
  const rows = db.prepare(
    'SELECT id, title, type, importance, tags, status FROM knowledge WHERE status = ? ORDER BY importance DESC',
  ).all('active');
  console.log(JSON.stringify(rows.map((r: any) => ({
    id: r.id, title: r.title, type: r.type,
    importance: r.importance,
    tags: JSON.parse(r.tags || '[]'),
  }))));
  db.close();
}

function countActive(dbPath: string): void {
  const db = openDB(dbPath);
  if (!db) { console.log(0); return; }
  const row = db.prepare('SELECT COUNT(*) as c FROM knowledge WHERE status = ?').get('active') as any;
  console.log(row.c);
  db.close();
}

// ── Main ─────────────────────────────────────────────────────────────────

function main(): void {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  switch (cmd) {
    case 'read-unconsumed-feedback':
      readUnconsumedFeedback(args[0]);
      break;
    case 'consume-feedback':
      consumeFeedback(args[0]);
      break;
    case 'generate-calibration-text':
      generateCalibrationText();
      break;
    case 'write-consolidation-ops':
      writeConsolidationOps(args[0], args[1], args[2], args[3], args[4]);
      break;
    case 'read-active-summary':
      readActiveSummary(args[0]);
      break;
    case 'count-active':
      countActive(args[0]);
      break;
    default:
      console.error(`Usage: node cli.js <command> [args...]
Commands:
  read-unconsumed-feedback <dbPath>
  consume-feedback <dbPath>
  generate-calibration-text  (reads JSON from stdin)
  write-consolidation-ops <dbPath> <date> <decisionsFile> <proposalsFile> <challengesFile>
  read-active-summary <dbPath>
  count-active <dbPath>`);
      process.exit(1);
  }
}

main();
