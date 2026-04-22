#!/usr/bin/env node
// mcp-server.ts — MCP stdio server for knowledge retrieval
// Storage: SQLite + FTS5 (primary), Markdown export for human readability
// Tools: knowledge_search, knowledge_get, knowledge_relevant, knowledge_write, knowledge_stats

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import Database from 'better-sqlite3';
import { createDatabase } from './db.js';
import { searchKnowledge, getKnowledge, getRelevant } from './search.js';
import { writeKnowledge } from './write.js';
import { getStats } from './stats.js';
import type { SearchOptions, WriteEntry } from './types.js';

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(os.homedir(), '.claude/knowledge');
const DB_PATH = path.join(KNOWLEDGE_DIR, 'knowledge.db');
const ACCESS_LOG = path.join(KNOWLEDGE_DIR, 'access_log.jsonl');
const CONFIG_FILE = path.join(KNOWLEDGE_DIR, 'config.json');
const ACTIVE_DIR = path.join(KNOWLEDGE_DIR, 'active');

const INITIALIZED = fs.existsSync(CONFIG_FILE);

function initWarning(): string {
  return 'Not initialized. Run /junior-mem:init in Claude Code to complete setup.';
}

let db: Database.Database | undefined;
function getDB(): Database.Database {
  if (!db) db = createDatabase(DB_PATH);
  return db;
}

// ── MCP Tool Definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'knowledge_search',
    description: 'Search knowledge base using FTS5 full-text search with BM25 ranking. Returns matching entries with ID, title, snippet and score.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (supports OR for multiple terms)' },
        tags: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Filter by tags' },
        type: { type: 'string', description: 'Filter by type: knowledge|feedback|project|reference|env_config' },
        min_importance: { type: 'number', description: 'Minimum importance (1-5)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_get',
    description: 'Get full content of knowledge entries by ID. Returns all fields including body. Updates access_count automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Knowledge entry ID(s)' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'knowledge_relevant',
    description: 'Find knowledge relevant to a task description. Uses FTS5 with BM25 ranking, only returns importance >= 2 entries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_description: { type: 'string', description: 'Describe the task to find relevant knowledge' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['task_description'],
    },
  },
  {
    name: 'knowledge_write',
    description: 'Write/modify knowledge entries. Supports create, update, reinforce, deprecate, delete. Triggers markdown export.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'update', 'reinforce', 'deprecate', 'delete'] },
              id: { type: 'string' },
              title: { type: 'string' },
              type: { type: 'string' },
              importance: { type: 'number' },
              body: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              source: { type: 'string' },
            },
            required: ['action', 'id'],
          },
          description: 'Array of knowledge write operations',
        },
      },
      required: ['entries'],
    },
  },
  {
    name: 'knowledge_stats',
    description: 'Get knowledge base statistics: total active, archived, by type, average importance, DB size.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// ── MCP Protocol ──────────────────────────────────────────────────────────

function sendResponse(id: string | number, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id: string | number, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handleRequest(req: { id?: string | number; method?: string; params?: any }): void {
  const { id, method, params } = req;

  if (method === 'initialize') {
    sendResponse(id!, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'knowledge-mcp', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    sendResponse(id!, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (!INITIALIZED && toolName !== 'knowledge_stats') {
      sendResponse(id!, {
        content: [{ type: 'text', text: JSON.stringify({ error: 'not_initialized', message: initWarning() }) }],
      });
      return;
    }

    try {
      let result;
      switch (toolName) {
        case 'knowledge_search':
          result = searchKnowledge(getDB(), args.query, {
            tags: args.tags,
            type: args.type,
            minImportance: args.min_importance,
            limit: args.limit,
          } as SearchOptions);
          break;

        case 'knowledge_get': {
          const ids: string[] = Array.isArray(args.ids) ? args.ids : [args.ids];
          result = getKnowledge(getDB(), ids, ACCESS_LOG);
          break;
        }

        case 'knowledge_relevant':
          result = getRelevant(getDB(), args.task_description, { limit: args.limit });
          break;

        case 'knowledge_write':
          result = writeKnowledge(getDB(), args.entries as WriteEntry[], ACTIVE_DIR, KNOWLEDGE_DIR);
          break;

        case 'knowledge_stats':
          result = getStats(getDB(), DB_PATH, INITIALIZED);
          break;

        default:
          sendError(id!, -32601, `Unknown tool: ${toolName}`);
          return;
      }
      sendResponse(id!, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      sendError(id!, -32000, (err as Error).message);
    }
    return;
  }

  if (method === 'ping') {
    sendResponse(id!, {});
    return;
  }

  sendError(id!, -32601, `Method not found: ${method}`);
}

// ── Main loop ─────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line: string) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    handleRequest(req);
  } catch {
    // Ignore malformed input
  }
});

rl.on('close', () => {
  if (db) db.close();
  process.exit(0);
});
