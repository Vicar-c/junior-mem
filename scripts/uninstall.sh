#!/bin/bash
# uninstall.sh — Complete cleanup for junior-mem plugin
# Removes ALL traces: knowledge data, cron, config
# Safe: shows what will be deleted, asks for confirmation
#
# Usage: bash uninstall.sh [--yes] [--keep-data] [--dir /path/to/knowledge]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_NAME="junior-mem"

AUTO_YES=false
KEEP_DATA=false
EXPLICIT_DIR=""

for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
    --keep-data) KEEP_DATA=true ;;
    --dir=*) EXPLICIT_DIR="${arg#--dir=}" ;;
    --help|-h)
      echo "Usage: bash uninstall.sh [--yes] [--keep-data] [--dir /path/to/knowledge]"
      echo ""
      echo "  --yes           Skip confirmation prompts"
      echo "  --keep-data     Keep knowledge data directory (only remove system files)"
      echo "  --dir=PATH      Specify knowledge directory (overrides auto-detection)"
      exit 0 ;;
  esac
done

# ── Colors ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'
DIM='\033[2m'; NC='\033[0m'

info()  { echo -e "${BLUE}  ℹ${NC} $*"; }
ok()    { echo -e "${GREEN}  ✔${NC} $*"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $*"; }
del()   { echo -e "${RED}  ✘${NC} $*"; }

confirm() {
  local label="$1"
  echo -ne "  ${BOLD}${label}${NC} [y/N]: "
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

# ── Detect knowledge directory ───────────────────────────────────────
KNOWLEDGE_DIR=""

# Priority: 1) explicit --dir  2) KNOWLEDGE_DIR env  3) config.json  4) default location
if [[ -n "$EXPLICIT_DIR" ]]; then
  KNOWLEDGE_DIR="$EXPLICIT_DIR"
elif [[ -n "${KNOWLEDGE_DIR:-}" ]]; then
  # env var already set
  :
elif [[ -f "$HOME/.claude/knowledge/config.json" ]]; then
  KNOWLEDGE_DIR=$(jq -r '.knowledge_dir // ""' "$HOME/.claude/knowledge/config.json" 2>/dev/null)
  [[ -z "$KNOWLEDGE_DIR" ]] && KNOWLEDGE_DIR="$HOME/.claude/knowledge"
elif [[ -d "$HOME/.claude/knowledge" ]]; then
  KNOWLEDGE_DIR="$HOME/.claude/knowledge"
fi

# ── Header ───────────────────────────────────────────────────────────
echo -e "${BOLD}${RED}╔══════════════════════════════════════╗
║  junior-mem — Full Uninstall          ║
╚════════════════════════════════════════╝${NC}\n"

# ── Scan traces ──────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}Scanning for junior-mem traces...${NC}\n"

FOUND_ITEMS=()

# (A) Knowledge data directory
if [[ -n "$KNOWLEDGE_DIR" && -d "$KNOWLEDGE_DIR" ]]; then
  LOCAL_SIZE=$(du -sh "$KNOWLEDGE_DIR" 2>/dev/null | cut -f1)
  LOCAL_FILES=$(find "$KNOWLEDGE_DIR" -type f 2>/dev/null | wc -l)
  FOUND_ITEMS+=("knowledge")
  echo -e "  ${RED}●${NC} ${BOLD}Knowledge data directory${NC}"
  echo -e "    Path: ${KNOWLEDGE_DIR}"
  echo -e "    Size: ${LOCAL_SIZE} (${LOCAL_FILES} files)"
  [[ -d "$KNOWLEDGE_DIR/active" ]] && \
    echo -e "    ${DIM}├ active/: $(find "$KNOWLEDGE_DIR/active" -name '*.md' | wc -l) knowledge entries${NC}"
  [[ -d "$KNOWLEDGE_DIR/staging" ]] && \
    echo -e "    ${DIM}├ staging/: $(find "$KNOWLEDGE_DIR/staging" -name '*.jsonl' | wc -l) observation files${NC}"
  [[ -d "$KNOWLEDGE_DIR/archive" ]] && \
    echo -e "    ${DIM}├ archive/: $(find "$KNOWLEDGE_DIR/archive" -name '*.md' | wc -l) archived entries${NC}"
  [[ -d "$KNOWLEDGE_DIR/consolidation" ]] && \
    echo -e "    ${DIM}├ consolidation/: pipeline records${NC}"
  [[ -f "$KNOWLEDGE_DIR/config.json" ]] && echo -e "    ${DIM}├ config.json${NC}"
  [[ -f "$KNOWLEDGE_DIR/state.json" ]] && echo -e "    ${DIM}├ state.json${NC}"
  [[ -f "$KNOWLEDGE_DIR/INDEX.md" ]] && echo -e "    ${DIM}├ INDEX.md${NC}"
  [[ -f "$KNOWLEDGE_DIR/access_log.jsonl" ]] && echo -e "    ${DIM}└ access_log.jsonl${NC}"
else
  echo -e "  ${GREEN}●${NC} Knowledge data directory — not found"
fi

# (B) Cron job
CRON_EXISTS=false
if crontab -l 2>/dev/null | grep -q "consolidate.sh"; then
  CRON_EXISTS=true
  FOUND_ITEMS+=("cron")
  CRON_LINE=$(crontab -l 2>/dev/null | grep "consolidate.sh")
  echo -e "\n  ${RED}●${NC} ${BOLD}Cron scheduled task${NC}"
  echo -e "    ${DIM}${CRON_LINE}${NC}"
else
  echo -e "\n  ${GREEN}●${NC} Cron scheduled task — not configured"
fi

# (C) Plugin registration (claude plugin install)
PLUGIN_REGISTERED=false
if [[ -f "$HOME/.claude/plugins/installed_plugins.json" ]]; then
  if jq -r '.plugins | keys[]' "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null | grep -qi "$PLUGIN_NAME"; then
    PLUGIN_REGISTERED=true
    FOUND_ITEMS+=("plugin-reg")
    echo -e "\n  ${RED}●${NC} ${BOLD}Plugin registration${NC}"
    echo -e "    ${DIM}Installed via 'claude plugin install', needs 'claude plugin uninstall' to unregister${NC}"
  fi
fi
[[ "$PLUGIN_REGISTERED" != "true" ]] && \
  echo -e "\n  ${GREEN}●${NC} Plugin registration — not found (local install mode)"

# (D) Plugin directory (informational — don't auto-delete)
if [[ -d "$PLUGIN_DIR" && -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ]]; then
  PLUGIN_SIZE=$(du -sh "$PLUGIN_DIR" 2>/dev/null | cut -f1)
  echo -e "\n  ${BLUE}●${NC} ${BOLD}Plugin directory${NC} ${DIM}(will not be auto-deleted)${NC}"
  echo -e "    Path: ${PLUGIN_DIR} (${PLUGIN_SIZE})"
  echo -e "    ${DIM}To delete: rm -rf ${PLUGIN_DIR}${NC}"
fi

# ── Nothing found ────────────────────────────────────────────────────
if [[ ${#FOUND_ITEMS[@]} -eq 0 ]]; then
  echo -e "\n${GREEN}No junior-mem traces found. System is clean.${NC}"
  exit 0
fi

# ── Confirmation ─────────────────────────────────────────────────────
echo ""
if [[ "$KEEP_DATA" == "true" ]]; then
  echo -e "  ${YELLOW}Mode: keep knowledge data (--keep-data), only cleaning system files${NC}"
fi

if [[ "$AUTO_YES" != "true" ]]; then
  echo -e "  ${BOLD}${RED}⚠ Items marked with ● above will be permanently deleted (irreversible)${NC}"
  echo ""
  if ! confirm "Confirm uninstall?"; then
    echo -e "\n  Cancelled."
    exit 0
  fi
fi

# ── Execute cleanup ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}Cleaning up...${NC}\n"

# (A) Knowledge data
if [[ -n "$KNOWLEDGE_DIR" && -d "$KNOWLEDGE_DIR" ]]; then
  if [[ "$KEEP_DATA" == "true" ]]; then
    rm -f "$KNOWLEDGE_DIR/config.json" \
          "$KNOWLEDGE_DIR/state.json" \
          "$KNOWLEDGE_DIR/INDEX.md" \
          "$KNOWLEDGE_DIR/access_log.jsonl" \
          "$KNOWLEDGE_DIR/consolidation.log" 2>/dev/null || true
    rm -rf "$KNOWLEDGE_DIR/consolidation" \
           "$KNOWLEDGE_DIR/staging" 2>/dev/null || true
    info "Kept knowledge data (--keep-data), cleaned system files"
  else
    rm -rf "$KNOWLEDGE_DIR"
    del "Deleted knowledge directory: ${KNOWLEDGE_DIR}"
  fi
fi

# (B) Cron
if [[ "$CRON_EXISTS" == "true" ]]; then
  crontab -l 2>/dev/null | grep -v "consolidate.sh" | crontab - 2>/dev/null || true
  del "Removed cron scheduled task"
fi

# (C) Plugin registration
if [[ "$PLUGIN_REGISTERED" == "true" ]]; then
  info "Running claude plugin uninstall ${PLUGIN_NAME}..."
  if claude plugin uninstall "$PLUGIN_NAME" 2>/dev/null; then
    ok "Unregistered via claude plugin uninstall"
  else
    warn "Auto-uninstall failed, please run manually: claude plugin uninstall ${PLUGIN_NAME}"
  fi
fi

# ── Verify ───────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}Verifying cleanup...${NC}\n"

CLEAN=true

if [[ -n "$KNOWLEDGE_DIR" && -d "$KNOWLEDGE_DIR" && "$KEEP_DATA" != "true" ]]; then
  warn "Knowledge directory still exists: ${KNOWLEDGE_DIR}"
  CLEAN=false
fi

if crontab -l 2>/dev/null | grep -q "consolidate.sh"; then
  warn "Cron entry still exists"
  CLEAN=false
fi

if [[ "$CLEAN" == "true" ]]; then
  echo -e "${GREEN}  ✔ junior-mem fully removed${NC}"
else
  echo -e "${YELLOW}  ⚠ Some traces may need manual cleanup${NC}"
fi
