#!/bin/bash
# observe.sh — Stop hook: extract per-turn observations from transcript to staging
# Input: stdin JSON from Claude Code Stop hook
# Output: KNOWLEDGE_DIR/staging/<session_id>.jsonl

set -euo pipefail

KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$HOME/.claude/knowledge}"
STAGING_DIR="$KNOWLEDGE_DIR/staging"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v jq >/dev/null 2>&1 || { echo "observe.sh: jq not found" >&2; exit 0; }

# ── 1. Read hook input ──────────────────────────────────────────────
INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Expand ~
TRANSCRIPT_PATH="${TRANSCRIPT_PATH/#\~/$HOME}"

# Validate
[[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]] && exit 0
[[ -z "$SESSION_ID" ]] && exit 0

mkdir -p "$STAGING_DIR"

# ── 2. Parse transcript with external jq filter ─────────────────────
jq -s -c -f "${SCRIPT_DIR}/observe.jq" "$TRANSCRIPT_PATH" \
  > "${STAGING_DIR}/${SESSION_ID}.jsonl.tmp" 2>/dev/null || exit 0

# ── 3. Write staging file ───────────────────────────────────────────
if [[ -s "${STAGING_DIR}/${SESSION_ID}.jsonl.tmp" ]]; then
  mv "${STAGING_DIR}/${SESSION_ID}.jsonl.tmp" "${STAGING_DIR}/${SESSION_ID}.jsonl"
else
  rm -f "${STAGING_DIR}/${SESSION_ID}.jsonl.tmp"
fi
