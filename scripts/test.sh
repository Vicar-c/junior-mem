#!/bin/bash
# test.sh — Manual test utilities for junior-mem
# Usage: bash test.sh [command] [args...]

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
  # Compact args to single line (remove newlines)
  args=$(echo "$args" | jq -c . 2>/dev/null || echo "$args")
  printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$tool" "$args" | \
    KNOWLEDGE_DIR="$KNOWLEDGE_DIR" node "$MCP_SCRIPT" 2>/dev/null | \
    jq -r 'select(.id==2) | .result.content[0].text'
}

case "$cmd" in
  observe)
    TRANSCRIPT="${1:?Usage: test.sh observe <transcript_path>}"
    SESSION_ID="test-$(date +%s)"
    mkdir -p "$KNOWLEDGE_DIR/staging"
    echo "{\"session_id\":\"$SESSION_ID\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"/root\"}" | \
      KNOWLEDGE_DIR="$KNOWLEDGE_DIR" bash "$SCRIPT_DIR/observe.sh"
    echo "Output: $KNOWLEDGE_DIR/staging/${SESSION_ID}.jsonl"
    wc -l "$KNOWLEDGE_DIR/staging/${SESSION_ID}.jsonl" 2>/dev/null
    ;;

  mcp-search|mcp-get|mcp-relevant|mcp-write|mcp-stats)
    TOOL_NAME="knowledge_${cmd#mcp-}"
    case "$cmd" in
      mcp-search)  ARGS="{\"query\":\"${*:?Usage: test.sh mcp-search <query>}\"}" ;;
      mcp-get)     ARGS="{\"ids\":[\"${*:?Usage: test.sh mcp-get <id>}\"]}" ;;
      mcp-relevant) ARGS="{\"task_description\":\"${*:?Usage: test.sh mcp-relevant <desc>}\"}" ;;
      mcp-write)   ARGS="${*:?Usage: test.sh mcp-write '<JSON entries>'}" ;;
      mcp-stats)   ARGS="{}" ;;
    esac
    mcp_call "$TOOL_NAME" "$ARGS" | jq .
    ;;

  consolidate)
    KNOWLEDGE_DIR="$KNOWLEDGE_DIR" bash "$SCRIPT_DIR/consolidate.sh"
    ;;

  seed)
    mcp_call "knowledge_write" '{"entries":[
      {"action":"create","id":"k20260421-001","title":"Always set HTTP request timeouts","type":"knowledge","importance":3,"body":"HTTP clients should always set explicit connection and read timeouts. Default infinite timeouts can cause thread exhaustion under downstream failures. Recommended: connect 3s, read 5s.","tags":["http","reliability","coding-standards"],"source":"auto"},
      {"action":"create","id":"k20260421-002","title":"Use structured logging with consistent fields","type":"knowledge","importance":2,"body":"All log entries should use structured key-value format with consistent field names. This enables automated log parsing and alerting.","tags":["logging","observability","coding-standards"],"source":"auto"},
      {"action":"create","id":"k20260421-003","title":"Cache invalidation requires version tagging","type":"feedback","importance":3,"body":"When using distributed cache, always include a version tag in the cache key. This allows atomic invalidation without race conditions during deployments.","tags":["cache","distributed-systems","coding-standards"],"source":"explicit"}
    ]}' | jq .
    echo "Seeded 3 test entries to SQLite"
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

  *)
    echo "Usage: bash test.sh [observe|mcp-search|mcp-get|mcp-relevant|mcp-write|mcp-stats|consolidate|seed|status]"
    ;;
esac
