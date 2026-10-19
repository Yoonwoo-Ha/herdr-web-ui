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
and mobile, or `Reasoning —` when unavailable. A conversation read after each native
transcript change refreshes these labels even without a new message. Metadata is tagged with its
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

At the time of the September 22 audit, native image-only turns and omo's same-cwd session ambiguity remained. The follow-up below addresses both. A full
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


## September 27 transcript fidelity follow-up

Reviewed [chatmux at b258b576](https://github.com/devswha/chatmux/tree/b258b5766f0b6b6c3b5db1474eed220f53524efb).
The changes adapt its attachment, session-correlation, strict paste-envelope and
incremental-log patterns to this bridge. No provider implementation was copied:
chatmux declares AGPL-3.0-or-later, while this repository remains MIT. No new
runtime dependencies or provider database were introduced.

1. **Codex attachments:** `server/codex-images.ts` recognizes native event
   `local_images`/`images` and response `input_image`/`local_image` records, including
   image-only turns. Event/response duplicates become one turn. Conversation JSON
   holds opaque references; the existing pane image endpoint reads the attachment
   on demand from that pane's retained rollout chain. Backtracked-away records
   cannot authorize a fetch. Remote URLs and non-raster images are excluded; local
   files and inline images have an 8 MiB bound. A local file may change or disappear,
   so Codex image responses are not cached. Relative image paths use the pane cwd.
2. **omo identity:** `server/omo.ts` uses canonical store-contained descriptors,
   native session metadata and `--session-id`. Without exact evidence, only a
   single omo runtime and single session created during it may be associated.
   Another same-cwd runtime, an unreadable peer, conflicting claims, missing
   timestamps or ambiguous candidates leave the terminal fallback. The process
   tree takes precedence over an SDK child's Claude label. There is no persistent
   cwd/newest-session guess, and this evidence never controls terminal input.
3. **Claude pastes:** only complete native wrappers with matching valid IDs are
   removed. Partial or mismatched tags, literal lookalikes and ordinary whitespace
   remain untouched, including CRLF input.
4. **Codex live tasks:** completed JSONL records within the last task are folded
   once. Pending calls, duplicate message pairs, metadata and an unfinished final
   line survive polling. HTTP snapshots are detached from parser state, so later
   results do not mutate prior answers. The existing page/window bounds remain;
   at most eight incremental task states and 32 MiB of retained source coverage
   are cached. Observed truncation, replacement and same-size timestamp changes
   invalidate parser state and cursor generations. Rewrites indistinguishable in
   inode, size and filesystem timestamps cannot be detected without rereading.

Validation includes attachment parser/HTTP tests, same-cwd real-herdr omo panes,
partial UTF-8/JSONL and rewrite equivalence against cold reads, and desktop/mobile
chat browser QA with a loaded image-only thumbnail. Tests own their workspaces and
transcript stores. `bun scripts/benchmark-codex-transcript.ts` compares 25 updates
to a synthetic 12.1 MB task: on the development machine, reparsing took 238 ms
versus 11 ms incremental (21.3x), with identical output. This measures parser work,
not end-to-end browser or live-session latency.

## History boundaries and late responses — 2026-09-27

Follow-up to the fidelity transfer: inspected chatmux
[`b258b57`](https://github.com/devswha/chatmux/tree/b258b5766f0b6b6c3b5db1474eed220f53524efb).
Adapted the native-record rules and request ownership idea independently for this
MIT bridge; no AGPL implementation or dependency was copied.

- `server/transcript-records.ts` normalizes omp/omo/gjc string messages, hidden
  messages (`display: false`), tool name/input/ID aliases, string results and
  embedded tool-result blocks. Rendering, page boundaries, metadata and whole
  output reads use the same visibility/result rules.
- Pi `custom/context_clear` and complete Claude `/clear` command envelopes reset
  turns and pending calls. A chunked scan finds the latest reset and keeps its
  offset between polls, scanning new bytes on append. Cold reads scan the file
  once. Paging cannot cross that offset; old cursors return `409 history_changed`.
  Compaction, quoted commands and torn records do not clear history. Reset control
  records must fit within the 64 KiB scanner carry limit.
- `ConversationResponse.history_id` stays stable across appends and changes on
  observed transcript replacement or clear. The client discards loaded history
  and late page responses at that boundary, including a clear with no next user
  prompt. Metadata starts unknown until recorded again after the reset. Old
  Claude images and tool results are excluded from subsequent asset reads.
- Whole tool-output requests belong to one machine, pane, history and tool ref.
  Target changes/unmount abort them; identity checks also reject late success or
  failure when a transport ignores abort. Repeated clicks share the active fetch.

Verification: `server/chat-history.test.ts` covers native shapes, hidden paging,
clear while appending, cached/held cursors, chunk boundaries, metadata and output
reads. `bun scripts/chat-history-browser-qa.ts` bundles the real React components
and controls response timing in Chrome; it covers stale pages, reused tool IDs,
PC switches, cancellation and both late success/failure. It touches no herdr pane.
The existing real-herdr Codex HTTP test also checks the additive history identity.

Large-output chunk APIs and a broader provider abstraction remain deferred:
whole-output reads retain their existing 2,000,000-character response cap and
still read the native file on demand. This change does not alter the input path.

### GJC pane binding

GJC identity comes from its public broker-bound SDK CLI, not terminal content.
`server/gjc-sdk.ts` asks `gjc sdk session raw global --op session.list --page`
with attach-only mode and the SDK's workspace scope. A bounded Git root probe
supplies the scope's worktree identity; the broker validates it. Discovery matches
the requested pane's GJC process to a unique live SDK session, then resolves that exact session ID to the broker's
`savedSession` path. The two responses must agree on process and session identity.
Discovery is limited to eight pages of 100 rows in that workspace, with at most 1 MiB
of command output. Chat reads allow a 10-second total deadline and five seconds per
command; status discovery keeps the previous eight-second total and two seconds per command.
The SDK budget reserves five seconds of the 15-second local chat read for the work before
and after it; those other operations have their own timeouts, not a shared end-to-end bound.
An incomplete or ambiguous answer is not used; unrelated workspaces' retired
sessions do not consume the page budget.

Overlapping reads of the same pane and purpose share one lookup. A proven binding found by
either status discovery or chat serves both purposes; changing the SDK budget never evicts it.
It is kept for at most 30 seconds while the pane's process identity and transcript header still
match. The shared SDK index normally invalidates it, except for bounded,
checksum-valid, sequential version-4 heartbeat appends belonging to other
processes and sessions. The guard includes every session the SDK listed for the
pane's PIDs, including retired rows and generation-zero fences: a heartbeat can
revive a stale session even when the heartbeat's PID differs from its registered
PID. Ignoring an unrelated heartbeat never renews the binding's age.

This narrow exception follows GJC 0.18.9's `session-index.ts` reducer: heartbeats
change only their own identity's liveness, activity and heartbeat time, not its
registered ownership, location or ambiguity. A changed snapshot, replaced or
truncated log, incomplete row, invalid checksum or sequence, unrecognized record,
or append over 256 KiB requires another SDK lookup. The bridge does not select a
session from index records. Chat reads leave null results uncached, so the first saved
message after `/new` is discoverable without another index change.

Session snapshots retain the shorter status budget, including the worktree probe,
so `/api/session`, WebSocket connect snapshots and collector resyncs do not inherit
the longer cold-chat SDK wait. An unresolved transcript keeps herdr's status.
Only an actual SDK lookup's execution failure or unresolved result is kept for up to 30
seconds for status discovery. A failed herdr RPC, missing foreground GJC process or rejected
transcript is not a cached SDK failure. A status retry reads the pane's process identity
(fresh on Windows) and index stamp before reusing a failure; a changed PID, process birth,
index, pane or cwd invalidates it. Any index change invalidates a failed lookup, unlike the
narrow unrelated-heartbeat exception for a proven binding above.
Chat reads bypass the failure cache and may retry. Status and chat use separate single
flights, so neither inherits the other's SDK deadline. Successful reads clear the recent
failure, and an older overlapping flight cannot reinstate a failure after that success,
even when no readable index lets the successful binding be kept.

The native transcript must remain inside the canonical `~/.gjc/agent/sessions/`
store and its header must identify the selected session and workspace. The pane's
process is checked again after discovery. Session titles, visible answers, file
recency, open descriptors and terminal breadcrumbs no longer select a GJC chat.
The descriptor and breadcrumb helpers remain for omp, which still uses them.
GJC can retain a generation-zero direct-session GC fence after `/new`. Only the
known non-endpoint shape at the canonical agent root is excluded from candidate
selection; foreign-root or uncertain zero-generation rows still refuse a binding.

This requires GJC 0.18.9 or later, for its public SDK session CLI,
on the server PC's PATH and an already running broker. The bridge does not start
or restart that broker, attach to private SDK endpoints, or register a live
session observer. Missing, stale or unavailable identity returns `no_session_path`
and leaves Terminal available. A new session without a saved transcript has no
native chat yet. Custom transcript stores remain unsupported.

The first migration changes session identity only: herdr still owns terminals
and agent status; chat rendering, message submission and prompt answers retain
their existing contracts. Real Windows and macOS SDK integration require separate
validation.

`server/gjc.contract.test.ts` reproduces the copied-neighbor-answer failure and
checks exact-PID binding, same-process session switches and fail-closed SDK errors
on isolated herdr panes. `server/gjc-sdk.test.ts` covers the broker contract and
bounded pagination; `server/gjc-runtime.test.ts` covers path/header and process
race checks, including Windows process-table fixtures.

The opt-in `server/gjc-sdk-live.contract.test.ts` was run on Linux with real GJC
0.18.9, disposable HOME and herdr state, and no model requests. It resumes seeded
history, resolves the exact SDK-selected file despite an identical neighboring
answer, reads its chat, and refuses to fall back when the SDK CLI becomes
unavailable. It also runs `/new` in the real TUI and checks the new session's
SDK-selected history without sending a model request. Run it with:

```sh
HERDR_GJC_SDK_TEST_BIN=/absolute/path/to/gjc bun run check run bun test --timeout 90000 ./server/gjc-sdk-live.contract.test.ts
```
