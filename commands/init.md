---
description: Initialize junior-mem knowledge management system (first-time setup)
allowed-tools: Bash(bash:*), AskUserQuestion, Bash(jq:*), Bash(claude:*)
---

Initialize the junior-mem knowledge management system.

## Step 1: Run init

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/init.sh" --non-interactive
```

If output says "Already initialized", skip to Step 3.

## Step 2: Validate model connectivity

Test both models. Each should reply within 15 seconds.

```bash
claude -p --model "$(jq -r '.model_cheap' ~/.claude/knowledge/config.json)" "reply with exactly: ok" </dev/null 2>&1 | head -1
```

```bash
claude -p --model "$(jq -r '.model_strong' ~/.claude/knowledge/config.json)" "reply with exactly: ok" </dev/null 2>&1 | head -1
```

If either model fails (timeout, error, or no "ok" in response), use `AskUserQuestion`:
- Question: "Model <model_name> validation failed. The consolidation pipeline may not work. How to proceed?"
- Options:
  - "Switch to a different model" (then ask which model and update config.json)
  - "Keep current config, fix later"

To update a model in config.json:
```bash
jq '.model_cheap = "<new_model>"' ~/.claude/knowledge/config.json > /tmp/_jm_config && mv /tmp/_jm_config ~/.claude/knowledge/config.json
```

## Step 3: Show final config

Read and display the actual config:

```bash
jq . ~/.claude/knowledge/config.json
```

Always present a clear summary to the user. Example:

```
junior-mem initialized ✓

  Storage dir:  ~/.claude/knowledge/
  Cheap model:  claude-haiku-4-5-20251001     ← Scanner/Challenger/Auditor/Validator
  Strong model: claude-opus-4-7               ← Executor
  Soft limit:   1000 entries
  Cron:         0 3 * * * (daily at 3am)

  Edit config: jq . ~/.claude/knowledge/config.json
  Full uninstall: /junior-mem:uninstall
```

If any model failed validation in Step 2, mark it with ⚠ in the summary:

```
  Cheap model:  claude-haiku-4-5-20251001  ⚠ validation failed, consolidation may not work
```

## Rules

- Always show the full config after init — user must see exactly what was chosen.
- Always include the config file path and how to modify it.
- Do NOT re-run init.sh for customization — just edit config.json with jq.
