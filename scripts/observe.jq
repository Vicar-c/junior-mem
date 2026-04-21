# observe.jq — Extract per-turn observations from Claude Code transcript
# Input: slurped JSONL array of transcript messages
# Output: one JSON object per user/assistant record

# Filter to relevant messages
map(select(
  (.type == "user"
   and (.message.content | type) == "string"
   and (.message.content | test("^<(local-command|command-name|system-)") | not)
  )
  or
  (.type == "assistant" and .message.role == "assistant")
))

# Deduplicate consecutive identical user messages
| reduce .[] as $msg (
  {prev_text: null, filtered: []};
  if $msg.type == "user" then
    if $msg.message.content == .prev_text then .
    else .prev_text = $msg.message.content | .filtered += [$msg] end
  else .prev_text = null | .filtered += [$msg] end
)
| .filtered

# Assign turns and aggregate assistant data
| reduce .[] as $msg (
  {turn: 0, last_role: "", recs: []};
  if $msg.type == "user" then
    .turn += 1 | .last_role = "user"
    | .recs += [{
        turn: .turn,
        role: "user",
        text: ($msg.message.content[:500]),
        ts: $msg.timestamp,
        session: $msg.sessionId
      }]
  elif .turn > 0 and $msg.type == "assistant" then
    (if ($msg.message.content | type) == "array"
     then [$msg.message.content[] | select(.type == "tool_use") | .name] | unique
     else [] end) as $tools
    | (if ($msg.message.content | type) == "array"
       then [$msg.message.content[]
         | select(.type == "tool_use"
             and (.name == "Read" or .name == "Write" or .name == "Edit"))
         | .input.file_path]
       else [] end) as $files
    | (if ($msg.message.content | type) == "array"
       then [$msg.message.content[]
         | select(.type == "tool_use" and .name == "Bash")
         | .input.command[:120]]
       else [] end) as $cmds
    | if .last_role == "user" then
        .last_role = "assistant"
        | .recs += [{
            turn: .turn,
            role: "assistant",
            tools: ($tools | sort),
            files: $files,
            commands: $cmds,
            ts: $msg.timestamp
          }]
      elif .last_role == "assistant" then
        .recs[-1].tools = ((.recs[-1].tools + $tools) | unique | sort)
        | .recs[-1].files = (.recs[-1].files + $files)
        | .recs[-1].commands = (.recs[-1].commands + $cmds)
        | .recs[-1].ts = $msg.timestamp
      else . end
  else . end
)
| .recs[]
