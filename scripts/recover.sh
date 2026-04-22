#!/bin/bash
# recover.sh — SessionStart hook: scan for orphaned transcripts and recover them
# Finds transcript JSONL files that have no corresponding staging file,
# then processes them through observe.jq to capture missed observations.
#
# Input: stdin JSON from Claude Code SessionStart hook
# Output: KNOWLEDGE_DIR/staging/<session_id>.jsonl (for recovered sessions)

set -euo pipefail

KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$HOME/.claude/knowledge}"
STAGING_DIR="$KNOWLEDGE_DIR/staging"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v jq >/dev/null 2>&1 || exit 0

# Read hook input to get current session_id (so we skip it)
INPUT=$(cat 2>/dev/null || echo "{}")
CURRENT_SESSION=$(echo "$INPUT" | jq -r '.session_id // empty')

mkdir -p "$STAGING_DIR"

# Only scan transcripts modified in the last 7 days
CUTOFF_DAYS=7

recovered=0

while IFS= read -r transcript; do
  [[ -z "$transcript" || ! -f "$transcript" ]] && continue

  session_id=$(basename "$transcript" .jsonl)

  # Skip current session (still being written to)
  [[ -n "$CURRENT_SESSION" && "$session_id" == "$CURRENT_SESSION" ]] && continue

  # Skip if already has staging file (Stop hook succeeded)
  [[ -f "$STAGING_DIR/${session_id}.jsonl" ]] && continue
  [[ -f "$STAGING_DIR/processed/${session_id}.jsonl" ]] && continue

  # Skip if staging tmp exists (another process is working on it)
  [[ -f "$STAGING_DIR/${session_id}.jsonl.tmp" ]] && continue

  # Process through observe.jq
  jq -s -c -f "${SCRIPT_DIR}/observe.jq" "$transcript" \
    > "${STAGING_DIR}/${session_id}.jsonl.tmp" 2>/dev/null || {
    rm -f "${STAGING_DIR}/${session_id}.jsonl.tmp"
    continue
  }

  # Only keep non-empty results
  if [[ -s "${STAGING_DIR}/${session_id}.jsonl.tmp" ]]; then
    mv "${STAGING_DIR}/${session_id}.jsonl.tmp" "${STAGING_DIR}/${session_id}.jsonl"
    recovered=$((recovered + 1))
  else
    rm -f "${STAGING_DIR}/${session_id}.jsonl.tmp"
  fi

  # Safety limit: don't process more than 20 per run
  [[ $recovered -ge 20 ]] && break

done < <(find "$HOME/.claude/projects" -name "*.jsonl" -maxdepth 2 -not -path "*/subagents/*" -mtime -${CUTOFF_DAYS} 2>/dev/null)

[[ $recovered -gt 0 ]] && echo "recover.sh: recovered ${recovered} orphaned session(s)" >&2
