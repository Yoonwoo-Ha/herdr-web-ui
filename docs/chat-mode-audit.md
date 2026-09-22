# Chat mode audit — 2026-09-22

Target: `herdr-web-ui`. Reference: local
`devswha/chatmux`, `main` at `3b1f3b49216157399e3fb9666a49c942908c3e32`.
Inspected its Codex session provider and native-session discovery. Chatmux is
AGPL-3.0 and this project is MIT: only behavior and native record shapes informed
the implementation; no source implementation was copied and no dependency added.

## Findings and changes

| Priority | Finding | Change | Effort / risk |
| --- | --- | --- | --- |
| 1 | Codex had no native transcript parser; terminal menus, tool displays and status lines became assistant messages. | Added `server/codex.ts`, connected through `server/conversation.ts`; ignore internal context, pair duplicate user/event records, attach tool outputs by call ID, preserve commentary/final phases. | Medium / session identity requires evidence. |
| 2 | Claude user messages stored as text-block arrays disappeared. | Preserve text alongside tool-result blocks; omit explicit metadata/compaction entries. | Small / parser regression tests. |
| 3 | Progress prose after the last tool appeared as a final answer. | `src/lib/workBlocks.ts` honors Codex commentary and final-answer phases. | Small / backward-compatible optional fields. |
| 4 | Old work blocks remained open after a new turn arrived. | Automatic folding follows the newest turn while explicit user toggles persist. | Small / browser verified. |
| 5 | Sending reset chat history and scroll state; slow interval polls could return out of order. | Reset only on pane changes and schedule the next conversation poll after completion. | Small / delayed real-request browser check. |
| 6 | Work duration included time waiting for the next user message. | Optional `end_ts` records the assistant's last activity; use task-completion timestamps when available. | Small / parser and browser checks. |
| 7 | Transcript cache missed same-size replacements and could cache an append under the wrong size. | Signature includes inode, size and mtime captured before reading; bound cache to 32 files. | Small / native-file HTTP regression. |

`src/components/ChatView.tsx` also renders Codex `cmd` inputs as commands, omits
fallback status rows, and keeps unresolved Codex terminal output in an explicitly
labelled, collapsed fallback. `ChatView.css` adds token-based fallback styling.
The HTTP source union and optional text phase/end timestamp are documented in
`shared/protocol.ts`. `createServer({ codexHome })` permits an isolated native
store in tests; production defaults to `CODEX_HOME` or `~/.codex`.

## Model and reasoning display

The conversation API now includes the latest recorded `metadata.model` and
`metadata.reasoning_effort`. `server/conversation-metadata.ts` reads Codex turn
contexts (including collaboration-mode settings), omp/omo model and thinking
changes, and Claude assistant-message models. Missing effort stays `null`; it is
never inferred from reasoning text. Model and effort are cached with the turns.

The composer status line displays the model and `Reasoning <level>` on desktop
and mobile, or `Reasoning —` when unavailable. Existing conversation polling
refreshes these labels even without a new message. Metadata is tagged with its
pane so a pane switch cannot display another conversation's settings; scrollback
fallback clears it. The live Codex API returned the configured model and `xhigh`
effort after the change. Refresh the page to load the rebuilt client.

## Session selection and limits

Resolution first checks herdr's native session path or open rollout descriptors
in this pane's Codex processes. Native session IDs can resolve through the local
read-only state database. Canonical paths must remain inside the Codex session
store; non-session files and subagent metadata are rejected.

The installed shared app-server TUI does not keep a rollout descriptor open, and
herdr did not return `agent_session` for the inspected live Codex pane. For this
case, read at most 32 cwd-matched state records and a 1 MiB tail per file; require
a substantial assistant-text match unique to one candidate in the pane's recent
output. This is a display-only inference, never an input/session binding. Never
choose a session solely because it is newest or shares the cwd. Ambiguous or
short-only output remains in the collapsed fallback. A new welcome card excludes
the preceding terminal output from matching.

Other deliberate limits: native image-only turns/attachment previews are not
added by this change; omo's existing same-cwd session ambiguity remains. A full
chatmux provider/database architecture migration was rejected as unnecessary for
this terminal bridge. Copying its provider implementation was rejected because
of the different licenses. Input transport, approval navigation, agent launching
and terminal flow control were not part of this change.

## Verification

- `server/codex.test.ts`: injected context, duplicated messages, repeated real
  prompts, commentary/final separation, tool results, reasoning, durations,
  truncated records, output/history bounds, path containment, subagent rejection,
  ambiguous sessions and welcome-card boundaries.
- `server/conversation.test.ts` and `src/lib/workBlocks.test.ts`: Claude array
  user messages, metadata exclusion and explicit phase boundaries.
- `server/codex.contract.test.ts`: real herdr workspace + native files + HTTP;
  session resolution, same-size file replacement and missing-file fallback.
- `bun run typecheck` and `bun run build` passed. Full `bun test`: 226 passed,
  0 failed across 30 files (24.39s), including native metadata extraction and
  cached HTTP metadata responses.
- `bun scripts/chat-browser-qa.ts`: real backend and owned pane; final answer,
  hidden context, tool expansion, duration, automatic/manual folding, send-time
  history preservation, non-overlapping polls and collapsed fallback. Desktop
  and 390px mobile screenshots are in `evidence/chat-mode/` (gitignored). Model /
  reasoning updates without new messages and mobile label visibility also passed.
- Existing `bun scripts/ui-regression.ts` also passed: settings/theme, approval
  queue behavior, pane-owned drafts/uploads, session creation and mobile input.
- Read-only inspection of the existing Codex pane returned `codex-transcript`
  and excluded the injected project instructions. No input was sent to it.

The backend was restarted at the user's request on 2026-09-22, preserving its
watch mode, environment, token authentication and existing listen address.
The authenticated health check passed and the live Codex conversation endpoint
returned `codex-transcript`. The working tree's pre-existing terminal flow-control
changes were preserved and are included in the running tree.
