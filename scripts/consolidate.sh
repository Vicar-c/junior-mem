#!/bin/bash
# consolidate.sh — 5-stage knowledge consolidation pipeline
# Stages: Scanner → Challenger → Auditor → Validator → Executor
# Storage: SQLite (primary) + Markdown (export)
# Uses: claude -p for each stage, breakpoint resume via state.json

set -euo pipefail

KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$HOME/.claude/knowledge}"
STAGING_DIR="$KNOWLEDGE_DIR/staging"
ACTIVE_DIR="$KNOWLEDGE_DIR/active"
ARCHIVE_DIR="$KNOWLEDGE_DIR/archive"
CONSOLIDATION_DIR="$KNOWLEDGE_DIR/consolidation"
ACCESS_LOG="$KNOWLEDGE_DIR/access_log.jsonl"
STATE_FILE="$KNOWLEDGE_DIR/state.json"
CONFIG_FILE="$KNOWLEDGE_DIR/config.json"
DB_FILE="$KNOWLEDGE_DIR/knowledge.db"
MCP_SCRIPT="$(cd "$(dirname "$0")" && pwd)/knowledge-mcp.cjs"

TODAY=$(date +%Y-%m-%d)
TODAY_DIR="$CONSOLIDATION_DIR/$TODAY"

if [[ -f "$CONFIG_FILE" ]]; then
  MODEL_CHEAP=$(jq -r '.model_cheap // "claude-haiku-4-5-20251001"' "$CONFIG_FILE")
  MODEL_STRONG=$(jq -r '.model_strong // "claude-opus-4-7"' "$CONFIG_FILE")
  CLAUDE_CMD=$(jq -r '.claude_cmd // "claude"' "$CONFIG_FILE")
  SOFT_LIMIT=$(jq -r '.soft_limit // 1000' "$CONFIG_FILE")
else
  MODEL_CHEAP="${MODEL_CHEAP:-claude-haiku-4-5-20251001}"
  MODEL_STRONG="${MODEL_STRONG:-claude-opus-4-7}"
  CLAUDE_CMD="claude"
  SOFT_LIMIT=1000
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { log "FATAL: $*"; exit 1; }
validate_json() { local f="$1"; [[ -s "$f" ]] && jq '.' "$f" >/dev/null 2>&1; }
extract_json() { local f="$1"; grep -q '```json' "$f" 2>/dev/null && { sed -n '/^```json$/,/^```$/p' "$f" | sed '1d;$d' > "${f}.clean"; mv "${f}.clean" "$f"; }; }
ensure_dirs() { mkdir -p "$STAGING_DIR" "$ACTIVE_DIR" "$ARCHIVE_DIR" "$TODAY_DIR" "$STAGING_DIR/processed"; }

read_stage_state() {
  if [[ -f "$TODAY_DIR/state.json" ]]; then cat "$TODAY_DIR/state.json"
  else echo '{"scanner":"pending","challenger":"pending","auditor":"pending","validator":"pending","executor":"pending"}'; fi
}
update_stage_state() { local s="$1" v="$2"; read_stage_state | jq --arg s "$s" --arg v "$v" '.[$s] = $v' > "$TODAY_DIR/state.json"; }
update_global_state() {
  local k="$1" v="$2"
  if [[ -f "$STATE_FILE" ]]; then jq --arg k "$k" --arg v "$v" '.[$k] = $v' "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  else echo "{\"$k\":\"$v\"}" > "$STATE_FILE"; fi
}
has_staging_data() { local c; c=$(find "$STAGING_DIR" -maxdepth 1 -name "*.jsonl" 2>/dev/null | wc -l); [[ "$c" -gt 0 ]]; }

# ── SQLite helpers ─────────────────────────────────────────────────────

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MODULES="$PLUGIN_ROOT/node_modules"
export KNOWLEDGE_DIR="$KNOWLEDGE_DIR"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"

# Common claude -p flags: --bare for no session persistence, --plugin-dir for MCP/skill access
CLAUDE_FLAGS="--bare --plugin-dir $PLUGIN_ROOT"

# Get unconsumed feedback as JSON for RL calibration
read_unconsumed_feedback() {
  if [[ ! -f "$DB_FILE" ]]; then echo "[]"; return; fi
  node -e "
    const Database = require('$NODE_MODULES/better-sqlite3');
    const db = new Database('$DB_FILE');
    const rows = db.prepare(
      'SELECT id, title, body, feedback_rating, feedback_comment, feedback_at FROM knowledge WHERE feedback_rating IS NOT NULL AND feedback_consumed = 0 ORDER BY feedback_at DESC LIMIT 20'
    ).all();
    console.log(JSON.stringify(rows));
    db.close();
  " 2>/dev/null || echo "[]"
}

# Apply feedback-based importance adjustments + mark consumed
consume_feedback() {
  if [[ ! -f "$DB_FILE" ]]; then return; fi
  node -e "
    const Database = require('$NODE_MODULES/better-sqlite3');
    const db = new Database('$DB_FILE');
    const tx = db.transaction(() => {
      // Good: importance +1 (max 5)
      db.prepare(
        'UPDATE knowledge SET importance = MIN(5, importance + 1) WHERE feedback_rating = ? AND feedback_consumed = 0'
      ).run('good');
      // Bad: importance -1 (min 1), deprecate if already 1
      db.prepare(
        'UPDATE knowledge SET importance = MAX(1, importance - 1) WHERE feedback_rating = ? AND feedback_consumed = 0 AND importance > 1'
      ).run('bad');
      db.prepare(
        'UPDATE knowledge SET status = ? WHERE feedback_rating = ? AND feedback_consumed = 0 AND importance = 1'
      ).run('deprecated', 'bad');
      // Mark all as consumed
      db.prepare(
        'UPDATE knowledge SET feedback_consumed = 1 WHERE feedback_rating IS NOT NULL AND feedback_consumed = 0'
      ).run();
    });
    tx();
    console.log('Feedback consumed');
    db.close();
  " 2>/dev/null
}

# Generate RL calibration text from feedback
generate_calibration_text() {
  local feedback="$1"
  if [[ "$feedback" == "[]" ]] || [[ -z "$feedback" ]]; then echo ""; return; fi
  node -e "
    const fb = $feedback;
    if (fb.length === 0) { console.log(''); process.exit(0); }
    const lines = ['User preference calibration (based on recent feedback):'];
    fb.forEach((f, i) => {
      const rating = {good: '[GOOD]', normal: '[NORMAL]', bad: '[BAD]'}[f.feedback_rating] || '[?]';
      const comment = f.feedback_comment ? ': \"' + f.feedback_comment + '\"' : '';
      const title = f.title || f.id;
      lines.push((i+1) + '. ' + rating + ' \"' + title + '\"' + comment);
      if (f.feedback_rating === 'good') lines.push('   \\u2192 Inference: user values this type of knowledge, increase extraction priority for similar content');
      if (f.feedback_rating === 'bad') lines.push('   \\u2192 Inference: user does not need this type of knowledge, decrease extraction priority for similar content');
    });
    console.log(lines.join('\\n'));
  " 2>/dev/null || echo ""
}

# Write consolidation_ops to SQLite
write_consolidation_ops() {
  local date="$1"
  local decisions="$2"
  local proposals="$3"
  local challenges="$4"
  local entries_file="$TODAY_DIR/05-entries.json"
  if [[ ! -f "$decisions" ]] || [[ ! -f "$DB_FILE" ]]; then return; fi

  node -e "
    const Database = require('$NODE_MODULES/better-sqlite3');
    const fs = require('fs');
    const db = new Database('$DB_FILE');
    const decisions = JSON.parse(fs.readFileSync('$decisions', 'utf-8'));
    const proposals = fs.existsSync('$proposals') ? JSON.parse(fs.readFileSync('$proposals', 'utf-8')) : {proposals: []};
    const challenges = fs.existsSync('$challenges') ? JSON.parse(fs.readFileSync('$challenges', 'utf-8')) : {challenges: []};
    const entries = fs.existsSync('$entries_file') ? JSON.parse(fs.readFileSync('$entries_file', 'utf-8')) : [];

    // Build index: proposal_id -> actual knowledge_id from executor entries
    // Entries are ordered to match proposals, so map by position if no explicit link
    const proposalIds = (decisions.decisions || []).map(d => d.proposal_id);
    const entryMap = {};
    entries.forEach((e, i) => {
      if (proposalIds[i]) entryMap[proposalIds[i]] = e.id;
    });
    // Also try matching by title as fallback
    entries.forEach(e => {
      if (!Object.values(entryMap).includes(e.id)) {
        const match = (decisions.decisions || []).find(d => {
          const p = (proposals.proposals || []).find(p2 => p2.id === d.proposal_id);
          return p && p.title === e.title;
        });
        if (match) entryMap[match.proposal_id] = e.id;
      }
    });

    const insertOp = db.prepare(\`
      INSERT INTO consolidation_ops (date, knowledge_id, operation, title, body, reasoning, source_observations, importance_before, importance_after, tags, type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`);

    // Map proposal_id to proposal/challenge for reasoning
    const pMap = {};
    (proposals.proposals || []).forEach(p => { pMap[p.id] = p; });
    const cMap = {};
    (challenges.challenges || []).forEach(c => { cMap[c.proposal_id] = c; });

    const tx = db.transaction(() => {
      // Clear existing ops for this date (idempotent)
      db.prepare('DELETE FROM consolidation_ops WHERE date = ?').run('$date');

      for (const d of (decisions.decisions || [])) {
        const p = pMap[d.proposal_id] || {};
        const c = cMap[d.proposal_id];
        const action = (d.final_action || {}).action || d.decision || 'unknown';
        const fa = d.final_action || {};

        // Resolve real knowledge ID: executor entry > target_id > proposal_id
        const realKid = entryMap[d.proposal_id] || fa.target_id || d.proposal_id || '';

        const reasoning = {
          scanner: p.reasoning || '',
          challenger: c ? (c.dimension + ': ' + c.reasoning) : '',
          auditor: d.reasoning || '',
        };

        insertOp.run(
          '$date',
          realKid,
          action === 'approved' ? (p.action || 'create') :
            action === 'modified' ? (p.action || 'update') :
            action === 'rejected' ? 'reject' : action,
          fa.title || p.title || '',
          fa.content_draft || p.content_draft || '',
          JSON.stringify(reasoning),
          JSON.stringify(p.source_staging ? [{turn: p.source_staging}] : []),
          null,
          fa.importance || p.importance || null,
          JSON.stringify(fa.tags || p.tags || []),
          fa.type || p.type || p.source_type || 'knowledge'
        );
      }
    });
    tx();
    console.log('Consolidation ops written for $date');
    db.close();
  " 2>/dev/null
}

# Get active knowledge summary as JSON (for LLM context)
read_active_summary() {
  if [[ ! -f "$DB_FILE" ]]; then echo "[]"; return; fi
  node -e "
    const Database = require('$NODE_MODULES/better-sqlite3');
    const db = new Database('$DB_FILE');
    const rows = db.prepare('SELECT id, title, type, importance, tags, status FROM knowledge WHERE status = ? ORDER BY importance DESC').all('active');
    console.log(JSON.stringify(rows.map(r => ({
      id: r.id, title: r.title, type: r.type,
      importance: r.importance,
      tags: JSON.parse(r.tags || '[]')
    }))));
    db.close();
  " 2>/dev/null || echo "[]"
}

count_active() {
  if [[ ! -f "$DB_FILE" ]]; then echo 0; return; fi
  node -e "
    const Database = require('$NODE_MODULES/better-sqlite3');
    const db = new Database('$DB_FILE');
    console.log(db.prepare('SELECT COUNT(*) as c FROM knowledge WHERE status = ?').get('active').c);
    db.close();
  " 2>/dev/null || echo 0
}

# Call knowledge_write MCP tool
mcp_write() {
  local entries="$1"
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"consolidate","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"knowledge_write","arguments":{"entries":'"$entries"'}}}' | \
    KNOWLEDGE_DIR="$KNOWLEDGE_DIR" node "$MCP_SCRIPT" 2>/dev/null | \
    jq -r 'select(.id==2) | .result.content[0].text' 2>/dev/null || echo "[]"
}

read_staging() { cat "$STAGING_DIR"/*.jsonl 2>/dev/null || echo ""; }

# ── Stage Runners ─────────────────────────────────────────────────────

run_scanner() {
  log "Stage 1: Scanner"
  local staging_data; staging_data=$(read_staging)
  [[ -z "$staging_data" ]] && { log "No staging data"; return 0; }
  local active_summary; active_summary=$(read_active_summary)
  local active_count; active_count=$(count_active)

  # Read feedback calibration (RL)
  local feedback_data; feedback_data=$(read_unconsumed_feedback)
  local calibration; calibration=$(generate_calibration_text "$feedback_data")

  local calibration_section=""
  if [[ -n "$calibration" ]]; then
    calibration_section="
## User Preference Calibration
${calibration}

Use the feedback above to calibrate your judgment criteria.
"
    log "Scanner: Loaded $(echo "$feedback_data" | jq 'length') feedback entries for calibration"
  fi

  cat > "$TODAY_DIR/scanner-prompt.txt" << 'SCANNER_SYSTEM'
You are a Knowledge Extraction Scanner. Your job is to distill durable, reusable knowledge from raw session observations — NOT to summarize or log what happened.

## What Counts as Valuable Knowledge

Extract only information that would help a developer working on this codebase weeks from now:

- **Architecture patterns**: Design decisions, trade-off rationale, component relationships
- **Coding standards**: Conventions, naming rules, error handling patterns
- **Integration knowledge**: API contracts, serialization quirks, protocol specifics
- **Environment/config**: Service addresses, deployment paths, environment-specific settings
- **Gotchas & pitfalls**: Non-obvious constraints, version-specific bugs, subtle invariants
- **Workflow procedures**: Build steps, debugging techniques, testing approaches

Do NOT extract:
- One-off debug output, temporary code changes, or transient state
- Information already present in existing knowledge entries (reinforce instead)
- Trivial operations (file reads, listing directories, running basic commands)
- User preferences or opinions not backed by technical reasoning

## Decision Framework

For each staging observation, evaluate:

1. **Durability**: Will this be relevant in 30+ days? If not, skip.
2. **Specificity**: Is there a concrete, actionable insight? Vague observations are not knowledge.
3. **Uniqueness**: Check existing entries. If a close match exists → propose `reinforce`. If partial overlap → propose `update`. If genuinely new → propose `create`.
4. **Scope**: One knowledge entry = one coherent topic. Don't bundle unrelated facts. Don't over-split either.

## Action Guidelines

| Action | When | Importance |
|--------|------|------------|
| create | New, durable, specific knowledge | 1 (auto) or 3 (user said "remember") |
| reinforce | Same knowledge re-encountered within 7 days | importance of existing entry |
| update | Existing knowledge needs correction or extension | same as existing |
| deprecate | Over soft limit: lowest-value, longest-unaccessed entries | N/A |

## Content Draft Quality

The `content_draft` is what users will READ and SEARCH. Write it like documentation:
- Lead with the key insight in one sentence, then elaborate
- Include concrete examples, code snippets, or configuration values where relevant
- State the WHY, not just the WHAT (e.g., "use X because Y" not "use X")
- Use the SAME LANGUAGE as the source observation (Chinese observations → Chinese content)
- Aim for 2-5 sentences — concise but self-contained

## Tag Selection

Choose 2-5 tags from the content's domain. Prefer specific tags over generic ones:
- Good: ["taf", "jce", "serialization", "coding-standards"]
- Bad: ["code", "tech", "info"]

## Tool Usage

Use ALL tools available in your session actively — file tools, knowledge MCP tools, skills, and any other capabilities you have. Do NOT rely solely on reasoning from input data.

### Source Code Verification (Read, Glob, Grep, Grep for patterns)
- **Dedup check**: Before proposing `create`, use Grep to search the active knowledge directory for key terms from your proposed title/content. If you find a close match, switch to `reinforce` or `update`.
- **Context enrichment**: If a staging observation references a specific file or code pattern, use Read to check if the pattern is real and extract precise details (exact function names, config values, line numbers) for a higher-quality content_draft.
- **Evidence validation**: If a staging observation claims "X is the standard pattern", use Grep to verify this pattern actually appears in multiple places before treating it as a standard.
- **Scope assessment**: Use Glob to understand how widespread a file/pattern is across the codebase — this helps calibrate importance (widespread = more important to document).

### Knowledge Base Queries (knowledge_search, knowledge_get, knowledge_relevant, knowledge_stats)
- **knowledge_search(query)**: Search the knowledge base with FTS5 full-text search. Use this as your PRIMARY dedup tool — search for key terms before proposing any `create`. If results come back with semantically similar entries, propose `reinforce` or `update` instead.
- **knowledge_get(ids)**: Retrieve full content of specific knowledge entries by ID. Use this when you need to compare a proposed content_draft against an existing entry in detail.
- **knowledge_relevant(task_description)**: Find knowledge relevant to a topic. Use this to discover entries that might overlap with what you're about to propose.
- **knowledge_stats()**: Get database statistics. Check this first to understand the current state of the knowledge base before processing staging data.

Prefer MCP tools for knowledge-base queries (they search SQLite directly with BM25 ranking) and file tools for source-code verification. Do NOT read every file — only investigate when the staging observation is ambiguous or the knowledge claim needs verification.
SCANNER_SYSTEM

  cat >> "$TODAY_DIR/scanner-prompt.txt" << PROMPT_EOF
${calibration_section}
## Current Knowledge Base (${active_count} entries, soft limit ${SOFT_LIMIT})
${active_summary}

## Today's Staging Observations
$(echo "$staging_data" | head -300)

$([[ $active_count -gt $SOFT_LIMIT ]] && echo "⚠ KNOWLEDGE BASE EXCEEDS SOFT LIMIT (${active_count}/${SOFT_LIMIT}). You MUST propose deprecation for the least valuable, longest-unaccessed entries to bring the count down.")

## Output Format

Output ONLY valid JSON, no markdown fences:
{"proposals":[{"id":"P001","action":"create|reinforce|update|deprecate","target_id":null,"type":"knowledge|feedback|project|reference|env_config","title":"Concise descriptive title","importance":1,"source_staging":"filename.jsonl:turn:N","reasoning":"Why this is valuable and durable","content_draft":"Full knowledge body text","tags":["tag1","tag2"]}]}

If no valuable knowledge found, output: {"proposals":[]}
PROMPT_EOF

  $CLAUDE_CMD -p $CLAUDE_FLAGS --model "$MODEL_CHEAP" \
    "$(cat "$TODAY_DIR/scanner-prompt.txt")" > "$TODAY_DIR/01-proposals.json" 2>/dev/null
  extract_json "$TODAY_DIR/01-proposals.json"
  if validate_json "$TODAY_DIR/01-proposals.json"; then
    log "Scanner: $(jq '.proposals|length' "$TODAY_DIR/01-proposals.json") proposals"
    update_stage_state "scanner" "completed"; return 0
  else update_stage_state "scanner" "failed"; return 1; fi
}

run_challenger() {
  log "Stage 2: Challenger"
  local proposals; proposals=$(cat "$TODAY_DIR/01-proposals.json")
  local pc; pc=$(echo "$proposals" | jq '.proposals|length')
  [[ "$pc" -eq 0 ]] && {
    log "No proposals, skip 2-4"
    update_stage_state "challenger" "completed"; update_stage_state "auditor" "completed"; update_stage_state "validator" "completed"
    echo '{"decisions":[]}' > "$TODAY_DIR/03-decisions.json"
    echo '{"approved":[],"total_est_tokens":0,"within_budget":true}' > "$TODAY_DIR/04-approved.json"
    return 0; }
  local as; as=$(read_active_summary)
  cat > "$TODAY_DIR/challenger-prompt.txt" << 'CHALLENGER_SYSTEM'
You are a Knowledge Quality Challenger. Your job is to stress-test every proposal before it enters the knowledge base. You serve as the quality gate — weak proposals waste user attention and search relevance.

## Challenge Methodology

For each proposal, evaluate along these dimensions. Challenge ONLY when you have a specific objection — do not manufacture doubt.

### 1. Evidence & Grounding
- Is the proposal based on a single casual mention, or a confirmed pattern?
- Single-observation proposals for "best practices" or "standards" need extra scrutiny
- Debugging artifacts or temporary workarounds must NOT become permanent knowledge

### 2. Redundancy & Overlap
- Does a semantically similar entry already exist in the knowledge base?
- Could this be merged into an existing entry via `update` instead of `create`?
- Reinforce proposals: is the re-encounter genuinely independent, or just the same conversation split across turns?

### 3. Scope & Granularity
- Is the proposal too broad (covers multiple unrelated topics in one entry)?
- Is it too narrow (a single config value that nobody would search for)?
- Does the title accurately reflect the scope of the content?

### 4. Action Appropriateness
- `create`: Is this truly new, or does it overlap with existing entries?
- `reinforce`: Is there enough time-distance to count as independent reinforcement?
- `update`: Is the change substantiated by the evidence, or speculative?
- `deprecate`: Is the entry genuinely obsolete, or just not recently accessed?

### 5. Content Quality
- Is `content_draft` self-contained (understandable without the source conversation)?
- Does it explain WHY, not just WHAT?
- Are tags specific and useful for search?

## Challenge Actions

For each proposal, output one of:
- **accept**: No concerns, proposal is sound
- **modify**: Fundamentally agree but need changes (specify what and why)
- **reject**: Proposal should not proceed (give clear reason)

When suggesting modifications, provide the specific field changes — don't just say "improve it".

## Tool Usage

Use ALL tools available in your session actively — file tools, knowledge MCP tools, skills, and any other capabilities you have. Do NOT challenge based on assumptions alone.

### Source Code Verification (Read, Glob, Grep, Grep for patterns)
- **Redundancy verification**: Before claiming a proposal is redundant, use Grep to search the knowledge base for semantically similar entries. Quote the specific existing entry that makes the proposal redundant.
- **Evidence validation**: If a proposal claims "pattern X is used throughout the codebase", use Grep to verify — search for the pattern. If it only appears once, that's grounds for challenge.
- **Accuracy check**: If the proposal references specific code (function names, config keys, file paths), use Read or Grep to confirm the details are correct. A proposal with wrong specifics should be modified.
- **Deprecation validation**: For deprecate proposals, use Grep to check if the target entry's key terms still appear in active use. If they do, challenge the deprecation.
- **Scope calibration**: Use Glob to check if a proposal's claimed scope (e.g., "used across all services") matches reality.

### Knowledge Base Queries (knowledge_search, knowledge_get, knowledge_relevant, knowledge_stats)
- **knowledge_search(query)**: Search for existing entries that might conflict with or duplicate a proposal. Use this BEFORE claiming redundancy — the Scanner may have missed an existing entry, or you may be wrong about redundancy.
- **knowledge_get(ids)**: Retrieve the full content of entries referenced by proposals. Read the actual entry body before challenging a reinforce/update — don't challenge based on title alone.
- **knowledge_relevant(task_description)**: Find related knowledge that the Scanner might have missed. If a proposal seems to ignore a related existing entry, flag it.

Prefer MCP tools for knowledge-base lookups and file tools for source-code verification. Do NOT accept or reject blindly. Verify at least the top claims of each proposal.
CHALLENGER_SYSTEM

  cat >> "$TODAY_DIR/challenger-prompt.txt" << PROMPT_EOF

## Current Knowledge Base
${as}

## Proposals to Challenge
${proposals}

## Output Format

Output ONLY valid JSON, no markdown fences:
{"challenges":[{"proposal_id":"P001","action":"accept|modify|reject","dimension":"evidence|redundancy|scope|action|quality","reasoning":"Specific objection with evidence","suggested_modification":{"field":"value"}}]}

Challenge every proposal — do NOT skip any. An unchallenged proposal is a rubber stamp.
PROMPT_EOF

  $CLAUDE_CMD -p $CLAUDE_FLAGS --model "$MODEL_CHEAP" \
    "$(cat "$TODAY_DIR/challenger-prompt.txt")" > "$TODAY_DIR/02-challenges.json" 2>/dev/null
  extract_json "$TODAY_DIR/02-challenges.json"
  if validate_json "$TODAY_DIR/02-challenges.json"; then
    log "Challenger done"; update_stage_state "challenger" "completed"; return 0
  else update_stage_state "challenger" "failed"; return 1; fi
}

run_auditor() {
  log "Stage 3: Auditor"
  cat > "$TODAY_DIR/auditor-prompt.txt" << 'AUDITOR_SYSTEM'
You are the Knowledge Audit Judge. You make the final call on every proposal, weighing the Scanner's case against the Challenger's objections. Your decisions are binding.

## Decision Protocol

For each proposal + challenge pair:

1. **Read the proposal's reasoning** — understand what knowledge it captures and why it matters
2. **Evaluate the challenge** — is the objection valid? Is it nitpicking? Is it missing the point?
3. **Apply the standard of proof**:
   - `create` proposals: default to approved unless the challenge reveals a clear problem (redundancy, trivial content, insufficient evidence for claimed importance)
   - `reinforce` proposals: approve unless the challenge shows the re-encounter is not independent
   - `update` proposals: approve if the change is factual and substantiated; reject if speculative
   - `deprecate` proposals: approve unless the entry is still actively accessed or the type warrants a longer TTL
4. **If you modify**, produce a complete `final_action` — do not leave fields ambiguous

## Cross-Proposal Consistency Checks

Before finalizing, check for:
- **Duplicate proposals**: If two proposals would create near-identical entries, merge into one
- **Contradictory proposals**: If one proposal creates X and another deprecates related Y, ensure this is intentional
- **Importance inflation**: If many proposals claim importance >= 3, are they all truly high-priority?

## Type & TTL Awareness

Knowledge types have different retention characteristics:
| Type | Typical TTL | Notes |
|------|-------------|-------|
| knowledge | 90 days | General technical knowledge |
| feedback | 180 days | User corrections and preferences |
| project | 60 days | Ephemeral project state, changes fast |
| reference | 365 days | External system pointers, stable |
| env_config | 365 days | Environment configuration, rarely changes |

## Tool Usage

Use ALL tools available in your session actively — file tools, knowledge MCP tools, skills, and any other capabilities you have. You are the final decision maker and must ground your rulings in evidence, not gut feeling.

### Source Code Verification (Read, Glob, Grep, Grep for patterns)
- **Resolve disputes**: When Scanner and Challenger disagree on a factual claim (e.g., "this pattern is widespread" vs "only appears once"), use Grep to settle the dispute with evidence.
- **Cross-reference proposals**: If two proposals might conflict or overlap, use Grep to check if they reference the same code/concepts. Merge if appropriate.
- **Validate modifications**: If you modify a proposal (e.g., changing importance from 3 to 2), check the codebase to justify your change — is the pattern truly minor?
- **Type classification**: If uncertain whether something is env_config vs knowledge, use Read to check if the referenced file is a config file or source code.

### Knowledge Base Queries (knowledge_search, knowledge_get, knowledge_relevant, knowledge_stats)
- **knowledge_search(query)**: When Scanner and Challenger disagree on whether an entry is redundant, search yourself. Your search result is the tiebreaker.
- **knowledge_get(ids)**: Before modifying a proposal that targets an existing entry, read the FULL current content. Your modification must make sense in context of what's already there.
- **knowledge_relevant(task_description)**: Discover if there are related entries that neither Scanner nor Challenger noticed. Missing a closely related entry could lead to fragmentation.
- **knowledge_stats()**: Check overall knowledge base health before finalizing decisions. If the base is near the soft limit, be more aggressive about deprecation and more conservative about creation.

Resolve ALL disputes between Scanner and Challenger before outputting decisions. An unresolved dispute means you haven't done your job.
AUDITOR_SYSTEM

  cat >> "$TODAY_DIR/auditor-prompt.txt" << PROMPT_EOF

## Proposals
$(cat "$TODAY_DIR/01-proposals.json")

## Challenges
$(cat "$TODAY_DIR/02-challenges.json")

## Output Format

Output ONLY valid JSON, no markdown fences:
{"decisions":[{"proposal_id":"P001","decision":"approved|modified|rejected","reasoning":"Why this decision, referencing the challenge where relevant","final_action":{"action":"create|reinforce|update|deprecate","target_id":"existing_id_or_null","type":"knowledge","title":"...","importance":1,"content_draft":"...","tags":["..."]}}]}

For rejected proposals, include final_action as null. For modified proposals, include the corrected complete final_action.
PROMPT_EOF

  $CLAUDE_CMD -p $CLAUDE_FLAGS --model "$MODEL_CHEAP" \
    "$(cat "$TODAY_DIR/auditor-prompt.txt")" > "$TODAY_DIR/03-decisions.json" 2>/dev/null
  extract_json "$TODAY_DIR/03-decisions.json"
  if validate_json "$TODAY_DIR/03-decisions.json"; then
    log "Auditor done"; update_stage_state "auditor" "completed"; return 0
  else update_stage_state "auditor" "failed"; return 1; fi
}

run_validator() {
  log "Stage 4: Validator"
  local as; as=$(read_active_summary)
  cat > "$TODAY_DIR/validator-prompt.txt" << 'VALIDATOR_SYSTEM'
You are the Pre-Flight Validator. You simulate the effect of approved decisions on the knowledge base to catch problems BEFORE they happen. You are the last safety net.

## Validation Checklist

For each approved decision, run these checks:

### 1. Conflict Detection
- **Title collision**: Does an active entry with a very similar title already exist? (May indicate the Auditor missed a duplicate)
- **Content overlap**: Does the proposed content significantly overlap with an existing entry? (Should have been a reinforce/update, not create)
- **Broken references**: If deprecating an entry, is it referenced by other active entries?

### 2. Integrity Checks
- `create` with `target_id` set → fail (create targets should be null)
- `reinforce` or `update` with no `target_id` → fail (must specify which existing entry)
- `importance` outside 1-5 range → fail
- Empty `title` or `content_draft` → fail
- `tags` is empty array → warn (untagged entries are harder to find)

### 3. Token Budget Estimation
- Estimate tokens for each operation: create ≈ content length / 3, update ≈ delta length / 3, deprecate ≈ 0
- Total budget: ~10,000 tokens for context injection (this is a rough guide, not a hard limit)
- If total exceeds budget, flag which operations to defer

### 4. Action-Decision Consistency
- Decision says "approved" but action doesn't match the proposal? → fail
- Decision says "modified" but final_action looks identical to proposal? → flag ( Auditor may not have actually modified)

## Pass/Fail Criteria

- **pass**: All checks clear, safe to execute
- **fail**: A correctness or integrity issue was found — do NOT approve this decision
- Document every check result, even passes — this becomes the execution audit trail

## Tool Usage

Use ALL tools available in your session actively — file tools, knowledge MCP tools, skills, and any other capabilities you have. You are the last safety net before changes are written to the database.

### Source Code Verification (Read, Glob, Grep, Grep for patterns)
- **Collision detection**: Use Grep to search for the proposed entry's title and key terms in the active knowledge files. If a collision is found, fail the decision.
- **Broken reference check**: For deprecate decisions, use Grep to search all active knowledge files for references to the entry being deprecated. If references exist, flag the risk.
- **Content verification**: For create/update decisions, if the content_draft references specific files or code, use Read to verify those references are accurate. Wrong file paths or function names must be caught here.
- **Token estimation**: Use Grep to check the approximate size of the knowledge base files for token budget calculation.

### Knowledge Base Queries (knowledge_search, knowledge_get, knowledge_relevant, knowledge_stats)
- **knowledge_search(query)**: For each approved decision, search the knowledge base using key terms from the proposed title and content. If you find an entry the Auditor missed that conflicts with the decision, FAIL it.
- **knowledge_get(ids)**: For update/reinforce/deprecate decisions, retrieve the target entry and verify it actually exists and matches what the decision expects. A `reinforce` targeting a non-existent or already-deprecated entry is a bug.
- **knowledge_stats()**: Get accurate database statistics for token budget estimation. Do not guess — query the actual numbers.

This is the LAST safety net. Be thorough — a bad entry that enters the knowledge base will persist until the next manual cleanup.
VALIDATOR_SYSTEM

  cat >> "$TODAY_DIR/validator-prompt.txt" << PROMPT_EOF

## Decisions to Validate
$(cat "$TODAY_DIR/03-decisions.json")

## Current Knowledge Base
${as}

## Output Format

Output ONLY valid JSON, no markdown fences:
{"approved":[{"decision_idx":0,"proposal_id":"P001","action":"create","pre_check":"pass|fail","pre_check_details":"Conflict/integrity check results","est_tokens_delta":150}],"total_est_tokens":500,"within_budget":true,"validation_notes":"Overall assessment"}

Only include decisions that passed validation in the "approved" array. Failed decisions are dropped.
PROMPT_EOF

  $CLAUDE_CMD -p $CLAUDE_FLAGS --model "$MODEL_CHEAP" \
    "$(cat "$TODAY_DIR/validator-prompt.txt")" > "$TODAY_DIR/04-approved.json" 2>/dev/null
  extract_json "$TODAY_DIR/04-approved.json"
  if validate_json "$TODAY_DIR/04-approved.json"; then
    log "Validator: $(jq '.approved|length' "$TODAY_DIR/04-approved.json") approved"
    update_stage_state "validator" "completed"; return 0
  else update_stage_state "validator" "failed"; return 1; fi
}

run_executor() {
  log "Stage 5: Executor"
  local ac; ac=$(jq '.approved|length' "$TODAY_DIR/04-approved.json")
  if [[ "$ac" -eq 0 ]]; then generate_report; update_stage_state "executor" "completed"; return 0; fi

  cat > "$TODAY_DIR/executor-prompt.txt" << 'EXECUTOR_SYSTEM'
You are the Knowledge Execution Agent. You translate approved decisions into concrete knowledge entries. You do NOT make judgment calls — you execute faithfully. But you ARE responsible for the quality of the written content.

## Content Writing Standards

Each knowledge entry body must be:
- **Self-contained**: Fully understandable without referencing the source conversation
- **Precise**: Use exact values, not approximations ("timeout: 3s" not "a few seconds")
- **Structured**: Lead with the key takeaway, then provide context and details
- **Same language as source**: Chinese source → Chinese content, English → English
- **Search-friendly**: Include key terms that someone would search for

## ID Generation Rules

For `create` operations, generate IDs as: `k{YYYYMMDD}-{NNN}`
- YYYYMMDD = today's date
- NNN = sequential number (001, 002, ...)
- Example: k20260421-001, k20260421-002

For `update`/`reinforce`/`deprecate`, use the existing entry's ID from `target_id`.

## Entry Metadata

| Field | Rule |
|-------|------|
| source | Always "consolidation" for entries created by this pipeline |
| type | Inherit from the approved decision |
| importance | Use the value from the approved decision exactly |
| tags | Use tags from the approved decision, ensure 2-5 tags |
| status | "active" for create/update, "deprecated" for deprecate |

## Report Generation

Generate a Markdown report with these sections:
- **Summary**: staging input count, active count, operations performed (created/reinforced/updated/deprecated)
- **Changes**: Table of each operation with ID, title, action, importance change
- **Rejected**: List any rejected proposals with brief reason (if applicable)
- **Statistics**: Total active entries, average importance, estimated context tokens

## Tool Usage

Use ALL tools available in your session actively — file tools, knowledge MCP tools, skills, and any other capabilities you have. You are responsible for the factual accuracy of every entry you write.

### Source Code Verification (Read, Glob, Grep, Grep for patterns)
- **Fact-check content**: Before finalizing a content_draft, if it references specific code, files, or configurations, use Read to verify the details are accurate. Correct any discrepancies.
- **Improve specificity**: If a staging observation mentions a pattern but is vague (e.g., "there's a config for X"), use Grep to find the exact config key/value and include it in the content_draft.
- **Verify existing entries**: For update/reinforce operations, use Read to check the current state of the target entry. Your update must be a coherent evolution, not a contradictory overwrite.
- **Report context**: Use Glob to count active entries for the report statistics section.

### Knowledge Base Queries (knowledge_search, knowledge_get, knowledge_relevant, knowledge_stats)
- **knowledge_get(ids)**: Before updating or reinforcing an entry, retrieve its current full content. Your changes must build on what's already there — do not overwrite blindly.
- **knowledge_search(query)**: After drafting each entry, do a quick search to confirm no collision was introduced by your content. If another entry already covers the same ground, flag it in the report.
- **knowledge_stats()**: Get accurate statistics for the report summary section (total active entries, average importance, etc.).
- **knowledge_write(entries)**: You do NOT need to call this directly — the pipeline handles the actual write. But structure your output entries in the exact format knowledge_write expects.

Execute EVERY approved operation. Do not skip or second-guess any. But DO ensure each entry's content is factually correct.
EXECUTOR_SYSTEM

  cat >> "$TODAY_DIR/executor-prompt.txt" << PROMPT_EOF

## Approved Operations to Execute
$(cat "$TODAY_DIR/04-approved.json")

## Output Format

Output ONLY valid JSON, no markdown fences:
{"entries":[{"action":"create|update|reinforce|deprecate","id":"k$(date +%Y%m%d)-NNN","title":"...","type":"knowledge","importance":N,"body":"Full knowledge body text","tags":["..."],"source":"consolidation","status":"active|deprecated"}],"report":"# Knowledge Consolidation Report\\n...markdown content..."}

Execute EVERY approved operation. Do not skip or second-guess any.
PROMPT_EOF

  local executor_result
  executor_result=$($CLAUDE_CMD -p $CLAUDE_FLAGS --model "$MODEL_STRONG" \
    "$(cat "$TODAY_DIR/executor-prompt.txt")" 2>/dev/null)

  # Extract entries from executor result and write to SQLite via MCP
  local entries_json
  entries_json=$(echo "$executor_result" | jq -r 'if type == "string" then fromjson | .entries else .entries end' 2>/dev/null)

  if [[ -n "$entries_json" ]] && [[ "$entries_json" != "null" ]]; then
    echo "$entries_json" > "$TODAY_DIR/05-entries.json"
    local write_result; write_result=$(mcp_write "$entries_json")
    log "Executor write: $write_result"
  fi

  # Save report
  local report_content
  report_content=$(echo "$executor_result" | jq -r 'if type == "string" then fromjson | .report else .report end' 2>/dev/null)
  if [[ -n "$report_content" ]] && [[ "$report_content" != "null" ]]; then
    echo "$report_content" > "$TODAY_DIR/report.md"
  else
    generate_report
  fi

  update_stage_state "executor" "completed"
}

generate_report() {
  local active_count; active_count=$(count_active)
  cat > "$TODAY_DIR/report.md" << EOF
# Knowledge Consolidation Report — ${TODAY}

## Summary
- Staging: $(find "$STAGING_DIR" -maxdepth 1 -name "*.jsonl" | wc -l) sessions
- Active: ${active_count} entries
- Changes this run: none

## Statistics
- Soft limit: ${SOFT_LIMIT}
- Over limit: $([[ $active_count -gt $SOFT_LIMIT ]] && echo "yes" || echo "no")
EOF
}

post_exec_cleanup() {
  for f in "$STAGING_DIR"/*.jsonl; do [[ -f "$f" ]] && mv "$f" "$STAGING_DIR/processed/"; done
  ln -sfn "$TODAY_DIR" "$CONSOLIDATION_DIR/latest"
  update_global_state "total_active" "$(count_active)"
  update_global_state "last_consolidation" "$TODAY"
  update_global_state "consecutive_failures" "0"
  update_global_state "last_success_date" "$TODAY"
  : > "$ACCESS_LOG" 2>/dev/null || true
  # Markdown export is handled by knowledge_write automatically
}

handle_failure() {
  local c; c=$(jq -r '.consecutive_failures // 0' "$STATE_FILE" 2>/dev/null || echo 0)
  update_global_state "consecutive_failures" "$((c + 1))"
  [[ $((c + 1)) -ge 3 ]] && log "WARNING: $((c + 1)) consecutive failures!"
}

main() {
  log "=== Consolidation ${TODAY} (cheap=${MODEL_CHEAP}, strong=${MODEL_STRONG}) ==="
  ensure_dirs
  if ! has_staging_data; then log "No staging data"; generate_report; exit 0; fi

  local state; state=$(read_stage_state)
  log "State: $(echo "$state" | jq -c '.')"

  echo "$state" | jq -r '.scanner' | grep -q "completed" || { update_stage_state "scanner" "running"; run_scanner || { handle_failure "scanner"; die "Scanner failed"; }; }

  # Consume feedback AFTER scanner has read it for calibration, BEFORE subsequent stages
  # (run_scanner reads unconsumed feedback internally for the calibration prompt)
  local feedback_count; feedback_count=$(read_unconsumed_feedback | jq 'length' 2>/dev/null || echo 0)
  if [[ "$feedback_count" -gt 0 ]]; then
    log "Stage 0: Consuming ${feedback_count} feedback entries (after scanner calibration)"
    consume_feedback
  fi

  echo "$state" | jq -r '.challenger' | grep -q "completed" || { update_stage_state "challenger" "running"; run_challenger || { handle_failure "challenger"; die "Challenger failed"; }; }
  echo "$state" | jq -r '.auditor' | grep -q "completed" || { update_stage_state "auditor" "running"; run_auditor || { handle_failure "auditor"; die "Auditor failed"; }; }
  echo "$state" | jq -r '.validator' | grep -q "completed" || { update_stage_state "validator" "running"; run_validator || { handle_failure "validator"; die "Validator failed"; }; }
  echo "$state" | jq -r '.executor' | grep -q "completed" || { update_stage_state "executor" "running"; run_executor || { handle_failure "executor"; die "Executor failed"; }; }

  # Post-exec: Write consolidation_ops for report server
  write_consolidation_ops "$TODAY" "$TODAY_DIR/03-decisions.json" "$TODAY_DIR/01-proposals.json" "$TODAY_DIR/02-challenges.json"

  post_exec_cleanup
  log "=== Consolidation completed ==="
}

main "$@"
