### Fixed
- Antigravity (agy) Chat mode now reads the model and reasoning effort from `transcript_full.jsonl`
  (`Model Selection` settings changes and `PLANNER_RESPONSE.model`) when the live terminal status
  row is unavailable (such as on `herdr-core` or a scrolled terminal).
- Antigravity (agy) Chat mode now attaches matching consecutive `GENERIC` tool outputs directly to
  their `PLANNER_RESPONSE` tool calls instead of emitting duplicate `Tool output` rows for every
  call.
