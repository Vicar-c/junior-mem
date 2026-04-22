#!/bin/bash
# diagnose.sh — Diagnostic utilities for junior-mem plugin
# Usage: bash diagnose.sh [command] [args...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$HOME/.claude/knowledge}"
MCP_SCRIPT="$SCRIPT_DIR/knowledge-mcp.cjs"

cmd="${1:-status}"
shift || true

# Helper: call MCP tool
mcp_call() {
  local tool="$1" args="$2"
  args=$(echo "$args" | jq -c . 2>/dev/null || echo "$args")
  printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diagnose","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$tool" "$args" | \
    KNOWLEDGE_DIR="$KNOWLEDGE_DIR" node "$MCP_SCRIPT" 2>/dev/null | \
    jq -r 'select(.id==2) | .result.content[0].text'
}

case "$cmd" in
  observe)
    TRANSCRIPT="${1:?Usage: diagnose.sh observe <transcript_path>}"
    SESSION_ID="diag-$(date +%s)"
    mkdir -p "$KNOWLEDGE_DIR/staging"
    echo "{\"session_id\":\"$SESSION_ID\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"/root\"}" | \
      KNOWLEDGE_DIR="$KNOWLEDGE_DIR" bash "$SCRIPT_DIR/observe.sh"
    echo "Output: $KNOWLEDGE_DIR/staging/${SESSION_ID}.jsonl"
    wc -l "$KNOWLEDGE_DIR/staging/${SESSION_ID}.jsonl" 2>/dev/null
    ;;

  mcp-search|mcp-get|mcp-relevant|mcp-stats)
    TOOL_NAME="knowledge_${cmd#mcp-}"
    case "$cmd" in
      mcp-search)  ARGS="{\"query\":\"${*:?Usage: diagnose.sh mcp-search <query>}\"}" ;;
      mcp-get)     ARGS="{\"ids\":[\"${*:?Usage: diagnose.sh mcp-get <id>}\"]}" ;;
      mcp-relevant) ARGS="{\"task_description\":\"${*:?Usage: diagnose.sh mcp-relevant <desc>}\"}" ;;
      mcp-stats)   ARGS="{}" ;;
    esac
    mcp_call "$TOOL_NAME" "$ARGS" | jq .
    ;;

  consolidate)
    KNOWLEDGE_DIR="$KNOWLEDGE_DIR" bash "$SCRIPT_DIR/consolidate.sh"
    ;;

  status)
    echo "Knowledge dir: $KNOWLEDGE_DIR"
    echo "DB file: $KNOWLEDGE_DIR/knowledge.db"
    echo ""
    mcp_call "knowledge_stats" "{}" | jq .
    echo ""
    echo "Staging sessions: $(find "$KNOWLEDGE_DIR/staging" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l)"
    echo "Processed sessions: $(find "$KNOWLEDGE_DIR/staging/processed" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l)"
    echo ""
    if [[ -f "$KNOWLEDGE_DIR/state.json" ]]; then
      echo "Global state:"
      jq . "$KNOWLEDGE_DIR/state.json"
    else
      echo "No state.json found (run: bash $SCRIPT_DIR/init.sh)"
    fi
    ;;

  clean)
    echo "Cleaning all diagnostic artifacts from $KNOWLEDGE_DIR ..."
    # Remove database
    rm -f "$KNOWLEDGE_DIR/knowledge.db" "$KNOWLEDGE_DIR/knowledge.db-wal" "$KNOWLEDGE_DIR/knowledge.db-shm"
    # Remove logs
    rm -f "$KNOWLEDGE_DIR/access_log.jsonl" "$KNOWLEDGE_DIR/consolidation.log"
    # Clear generated content
    rm -rf "$KNOWLEDGE_DIR/active"/* "$KNOWLEDGE_DIR/archive"/* "$KNOWLEDGE_DIR/staging/processed"/*
    # Remove staging files created by diagnose (diag-* prefix) or orphans
    rm -f "$KNOWLEDGE_DIR/staging"/diag-*.jsonl "$KNOWLEDGE_DIR/staging"/*.jsonl.tmp
    # Clear consolidation pipeline artifacts
    rm -rf "$KNOWLEDGE_DIR/consolidation"/*
    echo "Done. Config and state preserved. Run 'diagnose.sh status' to verify."
    ;;

  *)
    echo "Usage: bash diagnose.sh [status|observe|mcp-search|mcp-get|mcp-relevant|mcp-stats|consolidate|clean]"
    ;;
esac
