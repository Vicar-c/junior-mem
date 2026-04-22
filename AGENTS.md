# AGENTS.md — junior-mem Project Reference

> A Claude Code plugin that implements a knowledge lifecycle system: **observe** user sessions, **consolidate** observations into durable knowledge, and **retrieve** it on demand via MCP tools.

## Architecture Overview

```
User Session (Claude Code)
       │
       ▼
  ┌──────────┐    Stop Hook     ┌───────────┐
  │ Transcript│ ────observe.sh──▶│  Staging   │   ~/.claude/knowledge/staging/*.jsonl
  │  (JSONL)  │                  │  (JSONL)   │
  └──────────┘                   └─────┬─────┘
       │                               │  Cron 3am daily
       │ SessionStart Hook             ▼
  ┌──────────┐               ┌──────────────────┐
  │ recover.sh│              │  5-Stage Pipeline │  Scanner → Challenger → Auditor → Validator → Executor
  │ (fallback)│              │  consolidate.sh   │
  └──────────┘               └────────┬─────────┘
                                      │
                                      ▼
                             ┌──────────────────┐
                             │  SQLite + FTS5    │  ~/.claude/knowledge/knowledge.db
                             │  + Markdown export│  ~/.claude/knowledge/active/*.md
                             └────────┬─────────┘
                                      │
                                      ▼
                             ┌──────────────────┐
                             │  MCP Server       │  knowledge-mcp.cjs (stdio)
                             │  5 tools          │  search, get, relevant, write, stats
                             └──────────────────┘
```

## Directory Structure

```
junior-mem/
├── .claude-plugin/
│   └── plugin.json              # Plugin metadata (name, version)
├── .mcp.json                    # MCP server registration (dist/mcp-server.js)
├── bin/
│   └── junior-mem.js            # npx CLI thin wrapper → dist/installer.js
├── hooks/
│   └── hooks.json               # Hook definitions (SessionStart, Stop)
├── commands/                    # Slash command definitions
│   ├── init.md                  # /junior-mem:init — first-time setup
│   ├── review.md                # /junior-mem:review — web feedback UI
│   └── uninstall.md             # /junior-mem:uninstall — full removal
├── src/                         # TypeScript source
│   ├── types.ts                 # Shared interfaces
│   ├── utils.ts                 # parseTags etc.
│   ├── db.ts                    # Schema init, FTS5 triggers, migrations
│   ├── search.ts                # searchKnowledge, getKnowledge, getRelevant
│   ├── write.ts                 # writeKnowledge (5 actions), exportToMarkdown
│   ├── stats.ts                 # getStats
│   ├── mcp-server.ts            # MCP stdio server (thin protocol layer)
│   ├── report-handlers.ts       # Report data functions (pure, testable)
│   ├── report-server.ts         # HTTP feedback UI (port 19876)
│   ├── cli.ts                   # CLI subcommands for consolidate.sh
│   ├── installer.ts             # npx install/uninstall logic
│   └── __tests__/               # Vitest tests
├── scripts/
│   ├── init.sh                  # Setup wizard (interactive / --non-interactive)
│   ├── observe.sh               # Stop hook: transcript → staging
│   ├── observe.jq               # jq filter: extract per-turn observations
│   ├── recover.sh               # SessionStart hook: recover orphaned transcripts
│   ├── consolidate.sh           # 5-stage nightly pipeline (calls dist/cli.js)
│   ├── diagnose.sh              # Diagnostic & troubleshooting utilities
│   └── uninstall.sh             # Complete cleanup
├── tsconfig.json                # TypeScript config (→ dist/)
├── vitest.config.ts             # Vitest test config
├── package.json                 # Node.js deps + devDeps
├── README.md                    # English docs
├── README_CN.md                 # Chinese docs
└── auto-digest-design.md        # Detailed design document
```

## Runtime Data Layout

All runtime data lives in `~/.claude/knowledge/` (configurable via `$KNOWLEDGE_DIR`):

```
~/.claude/knowledge/
├── config.json                  # Models, soft_limit, cron schedule
├── state.json                   # Pipeline state (total_active, last_consolidation, etc.)
├── knowledge.db                 # SQLite + FTS5 (primary storage)
├── access_log.jsonl             # Access tracking
├── INDEX.md                     # Auto-generated index
├── consolidation.log            # Cron output log
├── staging/                     # Observations awaiting consolidation
│   ├── <session_id>.jsonl       # One per session
│   └── processed/               # Moved here after consolidation
├── active/                      # Markdown export of active entries
├── archive/                     # Deprecated entries
└── consolidation/               # Daily pipeline records
    └── YYYY-MM-DD/
        ├── state.json           # Stage completion status
        ├── scanner-prompt.txt   # Stage 1 input
        ├── 01-proposals.json    # Stage 1 output
        ├── challenger-prompt.txt
        ├── 02-challenges.json   # Stage 2 output
        ├── auditor-prompt.txt
        ├── 03-decisions.json    # Stage 3 output
        ├── validator-prompt.txt
        ├── 04-approved.json     # Stage 4 output
        ├── executor-prompt.txt
        ├── 05-entries.json      # Stage 5 output (entries to write)
        └── report.md            # Human-readable summary
```

## Hook System

### Stop Hook (`observe.sh`)

Triggered when a Claude Code session ends normally. Extracts observations from the session transcript.

**Input** (stdin JSON from Claude Code):
```json
{"transcript_path": "/path/to/session.jsonl", "session_id": "uuid", "cwd": "/path"}
```

**Flow**:
1. Read transcript path and session ID from stdin
2. Run `observe.jq` filter on the transcript
3. Write non-empty results to `staging/<session_id>.jsonl`

### SessionStart Hook (`recover.sh`)

Triggered when a new session starts. Recovers transcripts that missed the Stop hook (e.g., Ctrl+C, SSH disconnect).

**Flow**:
1. Scan `~/.claude/projects/` for `.jsonl` files modified in last 7 days
2. Skip sessions that already have staging/processed files
3. Skip current session (still being written)
4. Process orphans through `observe.jq`, limit 20 per run

### observe.jq Filter Logic

Processes transcript JSONL in three stages:
1. **Filter**: Keep user text messages and assistant responses, exclude local commands and system messages
2. **Deduplicate**: Remove consecutive identical user messages (resets after assistant turn)
3. **Aggregate**: Assign turn numbers, extract tool names, file paths, bash commands from assistant turns

Output format (one JSON object per turn):
```json
{"turn": 1, "role": "user", "text": "...", "ts": "...", "session": "..."}
{"turn": 1, "role": "assistant", "tools": ["Read", "Bash"], "files": ["/path"], "commands": ["cmd"], "ts": "..."}
```

## 5-Stage Consolidation Pipeline

Runs nightly at 3am via cron (or manually). Each stage uses `claude -p --bare --plugin-dir` to invoke LLM with MCP tool access.

| Stage | Model | Role | Input | Output |
|-------|-------|------|-------|--------|
| Scanner | cheap (Haiku) | Extract knowledge proposals | Staging + active summary + feedback calibration | `01-proposals.json` |
| Challenger | cheap | Stress-test proposals | Proposals + knowledge base | `02-challenges.json` |
| Auditor | cheap | Final decisions | Proposals + challenges | `03-decisions.json` |
| Validator | cheap | Pre-flight checks | Decisions + knowledge base | `04-approved.json` |
| Executor | strong (Opus) | Write entries | Approved operations | `05-entries.json` + report |

### Breakpoint Resume

Each day's `state.json` tracks stage completion. The pipeline resumes from the first incomplete stage on retry.

### Feedback Loop (RL)

1. User rates operations via web UI (Good/Normal/Bad)
2. Ratings stored in `feedback_rating` column
3. Next consolidation: Scanner reads unconsumed feedback for calibration prompt
4. After Scanner runs, `consume_feedback()` adjusts importance (+1 for good, -1 for bad)
5. Feedback marked as consumed

### Actions

| Action | Meaning | Importance Rule |
|--------|---------|-----------------|
| `create` | New knowledge entry | 1 (auto) or 3 (user said "remember") |
| `reinforce` | Same knowledge re-encountered | Inherit from existing |
| `update` | Correction/extension | Same as existing |
| `deprecate` | Mark as obsolete | N/A |
| `delete` | Remove entirely | N/A |

## MCP Server (dist/mcp-server.js)

JSON-RPC over stdin/stdout. Registered via `.mcp.json`. Compiled from `src/mcp-server.ts`.

### Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `knowledge_search` | FTS5 BM25 search | `query`, `tags`, `type`, `min_importance`, `limit` |
| `knowledge_get` | Full entry by ID | `ids` (string or array) |
| `knowledge_relevant` | Task-relevant (importance >= 2) | `task_description`, `limit` |
| `knowledge_write` | Create/update/reinforce/deprecate/delete | `entries[]` with `action`, `id`, `title`, `body`, etc. |
| `knowledge_stats` | Database statistics | (none) |

### Search Logic

- ASCII/alphanumeric terms → FTS5 BM25 ranking
- CJK terms → LIKE substring matching
- Combined score: `(bm25_score * -1) + importance`
- Filters: status, type, tags, min_importance

### Markdown Export

`knowledge_write` triggers automatic export of all active entries to `~/.claude/knowledge/active/*.md` with YAML frontmatter.

## Database Schema

### `knowledge` table (primary)

```sql
id TEXT PRIMARY KEY,           -- e.g., k20260421-001
title TEXT,                    -- Descriptive title
type TEXT,                     -- knowledge|feedback|project|reference|env_config
importance INTEGER DEFAULT 1,  -- 1-5 scale
body TEXT,                     -- Full content
tags TEXT,                     -- JSON array of strings
source TEXT,                   -- auto|consolidation|explicit
status TEXT DEFAULT 'active',  -- active|deprecated
created TEXT,
last_accessed TEXT,
access_count INTEGER DEFAULT 0,
feedback_rating TEXT,          -- good|normal|bad
feedback_comment TEXT,
feedback_at TEXT,
feedback_consumed INTEGER DEFAULT 0
```

### `fts` virtual table (FTS5)

Auto-synced via triggers on INSERT/UPDATE/DELETE. Covers title, body, tags.

### `consolidation_ops` table (audit trail)

Records every pipeline operation with date, knowledge_id, operation, title, body, reasoning (JSON), and metadata.

## Report Server (dist/report-server.js)

Lightweight HTTP server for reviewing consolidation results and submitting feedback. Compiled from `src/report-server.ts` + `src/report-handlers.ts`.

- Default port: 19876
- Auto-shutdown after 10 min idle
- Endpoints: `/report/:date`, `/api/dates`, `/api/report/:date`, `/api/feedback`, `/api/feedback/:date`
- Dark theme UI with expandable cards showing reasoning chains

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/junior-mem:init` | First-time setup (runs init.sh, validates models) |
| `/junior-mem:review` | Start report server, open feedback UI |
| `/junior-mem:uninstall` | Full cleanup with confirmation |

## Key Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `KNOWLEDGE_DIR` | Runtime data directory | `~/.claude/knowledge` |
| `CLAUDE_PLUGIN_ROOT` | Plugin install path (set by Claude Code) | (auto) |

## Configuration (config.json)

```json
{
  "model_cheap": "claude-haiku-4-5-20251001",
  "model_strong": "claude-opus-4-7",
  "knowledge_dir": "~/.claude/knowledge",
  "soft_limit": 1000,
  "claude_cmd": "claude",
  "cron_schedule": "0 3 * * *",
  "initialized_at": "2026-04-22T..."
}
```

## Dependencies

- **jq** — Transcript parsing (observe.jq)
- **claude CLI** — LLM invocation in consolidation pipeline
- **Node.js >= 18** — MCP server, report server, CLI tools
- **better-sqlite3** — SQLite with FTS5 (npm package)
- **TypeScript** — Source language, compiled to `dist/`
- **Vitest** — Test framework (41 tests)

## Important Design Decisions

1. **No external services**: Everything runs locally (SQLite, file-based staging, local LLM calls)
2. **`${CLAUDE_PLUGIN_ROOT}`** for all script paths in hooks.json and .mcp.json — ensures portability
3. **Staging as JSONL**: Simple append-only format, easy to debug, natural fit for transcript data
4. **SQLite + FTS5 over vector DB**: Simpler, no embedding cost, good enough for knowledge base scale
5. **Markdown export**: Human-readable backup of SQLite, easy to grep/browse
6. **Breakpoint resume**: Each stage tracked in state.json, pipeline can resume after failure
7. **Feedback → RL calibration**: User ratings adjust importance and influence future Scanner decisions

## Common Workflows

### Debugging observe pipeline
```bash
# Test observation extraction on a specific transcript
bash scripts/diagnose.sh observe /path/to/session.jsonl

# Check staging status
bash scripts/diagnose.sh status
```

### Running consolidation manually
```bash
KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/consolidate.sh
```

### Querying knowledge via MCP
```bash
bash scripts/diagnose.sh mcp-search "http timeout"
bash scripts/diagnose.sh mcp-stats
```

### Cleanup (remove diagnostic artifacts)
```bash
bash scripts/diagnose.sh clean
# Full uninstall: /junior-mem:uninstall or npx junior-mem uninstall
```

### Build and test
```bash
npm run build      # Compile TypeScript → dist/
npm test           # Run Vitest (41 tests)
npm run test:watch # Vitest watch mode
```
