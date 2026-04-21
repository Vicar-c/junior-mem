<div align="center">

# junior-mem

**Persistent knowledge management for Claude Code — observe, consolidate, retrieve.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)]()
[![Built for Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-orange.svg)](https://docs.anthropic.com/en/docs/claude-code)

🇺🇸 English · 🇨🇳 [中文](README_CN.md)

**Quick Start** · **How It Works** · **MCP Tools** · **Configuration** · **Architecture** · **Troubleshooting**

</div>

---

<table>
<tr>
<td>

### 🤔 Why junior-mem?

We're all "junior" — our skill level is hard to benchmark against AI, and much of our daily work is modular and repetitive.

When Claude Code's built-in memory already does a solid job, external memory plugins can feel **oversized and bloated** — especially when context window space is at a premium.

**junior-mem is the middle ground:**

- 🤖 **Machine-readable** — structured knowledge that Claude can search and retrieve
- 📓 **Human-friendly** — a personal log for your own recording and learning
- 🪶 **Lightweight** — no heavy infrastructure, just SQLite + FTS5
- 🎯 **Human-in-the-loop** — built-in feedback & RL mechanism, so knowledge quality is shaped by *you*, not decided solely by the machine

</td>
</tr>
</table>

---

## Quick Start

Install with two commands inside Claude Code:

```bash
/plugin marketplace add Vicar-c/junior-mem
/plugin install junior-mem
```

Then initialize:

```bash
/junior-mem:init
```

That's it. junior-mem will automatically:
- 🪝 Capture observations from your conversations via a **Stop hook**
- 🧠 Register an **MCP server** with 5 knowledge tools
- ⏰ Set up a **daily cron job** to consolidate new observations

No manual knowledge management required — just work as usual and let junior-mem learn what matters.

---

## Key Features

- 🧠 **Automatic Knowledge Capture** — Stop hook extracts observations after every session, zero config needed
- 🔄 **5-Stage Consolidation Pipeline** — Scanner → Challenger → Auditor → Validator → Executor, all powered by LLM
- 🔍 **FTS5 + SQLite Storage** — Fast full-text search with BM25 ranking, no external database required
- 🛠️ **5 MCP Tools** — Search, retrieve, write, and manage knowledge directly from Claude Code
- 💬 **Feedback Loop** — Rate consolidation results via web UI, calibrates future extraction preferences
- 📝 **Markdown Export** — Human-readable knowledge files auto-generated from SQLite
- 🪶 **Lightweight** — Minimal footprint, designed for developers who don't need a heavy memory solution

---

## How It Works

junior-mem follows a **5-stage knowledge lifecycle**:

```
┌──────────────┐     ┌──────────┐     ┌─────────┐     ┌─────────────┐     ┌──────────┐
│ Conversation │────►│ Observe  │────►│ Stage   │────►│ Consolidate │────►│ Retrieve │
│              │     │ (hook)   │     │ (jsonl) │     │  (nightly)  │     │  (MCP)   │
└──────────────┘     └──────────┘     └─────────┘     └─────────────┘     └──────────┘
```

### 1. Observe (automatic)

A Claude Code Stop hook extracts observations from your conversation transcript after each session. Observations are staged as JSONL files under `~/.claude/knowledge/staging/`.

### 2. Consolidate (nightly, 3 AM)

A 5-stage LLM pipeline runs daily to process staged observations:

| Stage | Role | Description |
|:-----:|:----:|:-----------:|
| 🔍 **Scanner** | Analyst | Analyzes staging observations, proposes create/update/deprecate operations |
| ⚔️ **Challenger** | Critic | Reviews proposals for quality, detects duplicates and contradictions |
| ⚖️ **Auditor** | Judge | Reconciles proposals with challenges, resolves conflicts |
| 🛡️ **Validator** | Guard | Checks for side effects, enforces budget constraints |
| ✅ **Executor** | Worker | Writes approved operations to SQLite, exports Markdown |

### 3. Retrieve (on demand)

The MCP server provides tools that Claude Code can call during any conversation to find and use stored knowledge.

### 4. Feedback loop (optional)

Run `/junior-mem:review` to open a web UI where you can rate consolidation results:

| Rating | Effect |
|:------:|:------|
| 👍 **Good** | Increases extraction priority for similar content |
| 😐 **Normal** | No change |
| 👎 **Bad** | Decreases extraction priority for similar content |

Your feedback calibrates future consolidation decisions — junior-mem learns what types of knowledge you actually value.

---

## MCP Tools

Once initialized, these tools are available to Claude Code automatically:

| Tool | Description | Example |
|:----:|:-----------:|:-------:|
| `knowledge_search` | Full-text search with BM25 ranking | Search for "HTTP timeout patterns" |
| `knowledge_get` | Get a full knowledge entry by ID | Retrieve entry `k20260421-001` |
| `knowledge_relevant` | Find knowledge relevant to a task | "I'm adding cache invalidation logic" |
| `knowledge_write` | Create, update, or deprecate entries | Manually add a coding standard |
| `knowledge_stats` | View knowledge base statistics | Entry counts, storage usage, last consolidation |

---

## Configuration

Configuration is stored in `~/.claude/knowledge/config.json` and set during `/junior-mem:init`:

| Key | Default | Description |
|:---:|:-------:|:-----------:|
| `model_cheap` | `claude-haiku-4-5-20251001` | Model for extraction and classification |
| `model_strong` | `claude-opus-4-7` | Model for consolidation and quality review |
| `soft_limit` | `200` | Target max active entries (triggers pruning) |
| `consolidation_time` | `0 3 * * *` | Cron schedule for nightly consolidation |

---

## Architecture

```
~/.claude/knowledge/
├── knowledge.db          # SQLite + FTS5 (primary storage)
├── active/               # Markdown exports (human-readable)
├── staging/              # Raw observation JSONL files
├── consolidation/        # Daily reports and operation logs
│   └── YYYY-MM-DD/
│       ├── report.md     # Human-readable consolidation report
│       └── ops.jsonl     # Operation log
└── config.json           # User configuration

junior-mem/
├── commands/             # Slash commands
│   ├── init.md           #   /junior-mem:init
│   ├── review.md         #   /junior-mem:review
│   └── uninstall.md      #   /junior-mem:uninstall
├── scripts/
│   ├── knowledge-mcp.cjs # MCP stdio server (SQLite + FTS5)
│   ├── observe.sh        # Stop hook: extract observations
│   ├── observe.jq        # JQ filter for transcript parsing
│   ├── consolidate.sh    # 5-stage consolidation pipeline
│   ├── report-server.cjs # Web UI for feedback review
│   ├── init.sh           # Setup wizard
│   ├── uninstall.sh      # Full cleanup
│   └── test.sh           # Manual test utilities
├── .claude-plugin/plugin.json
├── .claude-hooks/hooks.json
└── .mcp.json
```

---

## System Requirements

| Requirement | Version | Notes |
|:----------:|:-------:|:-----:|
| **Claude Code** | Latest | With plugin support |
| **Node.js** | >= 18 | For MCP server and scripts |
| **SQLite** | With FTS5 | Bundled via better-sqlite3 |
| **jq** | Any | For transcript parsing |

---

## Troubleshooting

<details>
<summary><strong>MCP tools not showing up</strong></summary>

- Run `/junior-mem:init` to register the MCP server
- Restart Claude Code after init
- Check that `.mcp.json` exists in the plugin directory

</details>

<details>
<summary><strong>Consolidation not running</strong></summary>

- Check cron: `crontab -l | grep consolidate`
- Run manually: `KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/consolidate.sh`
- Check logs in `~/.claude/knowledge/consolidation/`

</details>

<details>
<summary><strong>Port conflict on /junior-mem:review</strong></summary>

- Use a different port: start manually with `--port 19877`
- Kill existing process: `lsof -i :19876` then `kill <PID>`

</details>

<details>
<summary><strong>Want to start fresh</strong></summary>

Run `/junior-mem:uninstall` to remove all data, cron jobs, and the plugin itself.

</details>

---

## Manual Commands

```bash
# Check status
KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/test.sh status

# Run consolidation now
KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/consolidate.sh

# Seed test data
KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/test.sh seed
```

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a Pull Request

---

## License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built for Claude Code** · **Powered by SQLite + FTS5** · **Made with Bash & JavaScript**

</div>
