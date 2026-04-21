---
description: Completely remove junior-mem: delete all knowledge data, cron jobs, and unregister the plugin
allowed-tools: Bash(bash:*), AskUserQuestion, Bash(claude:*)
---

Uninstall junior-mem completely. This will remove all knowledge data, cron jobs, and the plugin itself.

## Step 1: Confirm

Use `AskUserQuestion` to confirm with the user:

Question: "This will delete ALL knowledge data (SQLite database, markdown files, logs) and unregister the plugin. Continue?"
Options:
- "Yes, uninstall everything"
- "Cancel"

If cancelled, stop here.

## Step 2: Run uninstall

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.sh" --yes
```

## Step 3: Unregister plugin

After the script completes, run:

```bash
claude plugin remove junior-mem
```

If `claude plugin remove` fails or is not available, tell the user to manually run:
```
claude plugin uninstall junior-mem
```

## Step 4: Report

Show the user what was removed and confirm the plugin is fully uninstalled.
