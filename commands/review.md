---
name: review
description: Open the consolidation report web UI to review and provide feedback on daily results
---

Open the consolidation report web UI to interactively browse daily consolidation results and provide feedback.

## Steps

1. Locate plugin install path (via `$CLAUDE_PLUGIN_ROOT` or infer from current working directory)
2. Check if `report-server.cjs` is already running: `lsof -i :19876` or try connecting
3. If not running, start in background: `node $PLUGIN_ROOT/scripts/report-server.cjs --daemon --open-browser --port 19876 &`
   Or use: `nohup node $PLUGIN_ROOT/scripts/report-server.cjs --daemon --open-browser --port 19876 > /dev/null 2>&1 &`
4. Tell the user:
   - URL: `http://localhost:19876`
   - Instructions: browse daily consolidation reports, click Good/Normal/Bad for each operation, optionally add a comment and Submit
   - Server auto-shuts down after 10 minutes of inactivity
   - Feedback is consumed during the next nightly consolidation run to calibrate knowledge extraction preferences

## Prerequisites

- Node.js >= 18
- better-sqlite3 installed (npm install)
- At least one consolidation run completed (consolidation_ops data exists)

## Troubleshooting

- Port conflict: try `--port 19877`
- Database not found: prompt user to run `/junior-mem:init` and at least one consolidation
