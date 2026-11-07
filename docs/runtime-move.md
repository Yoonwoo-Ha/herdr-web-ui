# Moving herdr's session to herdr-core

Settings > About offers "Move everything to herdr-core" on a PC whose Ovis serves herdr's TUI, has
herdr-core, can switch its runtime (Linux and macOS, started by Ovis's launcher) and has no Herdr app
installed (the app arranges a core in a document Ovis never writes). It moves all of herdr's session
or nothing.

On such a PC without herdr-core (Linux and macOS, x64 and arm64), the row reads "Install herdr-core
and move everything" instead. Its button installs herdr-core 0.1.17 the way herdr-core's own installer
does, into `~/.local/bin/herdr-core` (with `hc` linked beside it when no `hc` exists), without
sudo: the version and the SHA-256 of each archive are pinned in `server/herdr-core/install.ts`
(the same hc the desktop app carries), the download must match it and the program must answer
`--version` as that hc before anything is written there. A `herdr-core` already in `~/.local/bin` is
never replaced, and a failed install leaves the folder as it was. herdr's TUI and its config are not
touched. Once it is in, the move's plan opens as usual; nothing moves until "Move everything".

## What moves

| herdr | herdr-core |
|---|---|
| Workspaces, tabs, their order and names | the same, as `herdr.space` / `herdr.tab` / `ovis.*` labels and the `ovis-layout` document ([herdr-core-layout.md](herdr-core-layout.md)) |
| Splits and their ratios | the same tree, rebuilt from herdr's `split_<n>_<path>` ids |
| An idle Claude Code whose input box reads empty, its conversation in this PC's stores | ended by Ovis, reopened on that conversation (the commands Earlier sessions uses) |
| An idle Claude Code whose conversation cannot be told | ended by Ovis, started new in the same folder |
| An agent the person ended (the pane still names its conversation) | reopened on that conversation; nothing is typed |
| A shell with nothing running in front | a new shell in the same folder |

Scrollback, programs running in a shell and anything kept only in a process's memory do not move.
One conversation reopens in one pane only.

## What makes it wait

An agent at work, waiting for an answer, or with a message Ovis still holds for it; a shell whose
foreground process is not the shell (or whose processes herdr cannot tell): the move waits and goes
by itself once none is left, until it is cancelled. Any other agent, one with text typed in its
input line, or one Ovis has no exit command for, waits for the person to end it: Ovis cannot read
those input lines, and its exit command, sent as a message, would send what is typed there. Once
the person ends it, its conversation reopens on herdr-core.

While it waits, the dialog lets the person end a shell's command where they would with Ctrl+C
(`POST /api/runtime/move/stop`, only while the move waits and only for a shell running a command):

- End sends Ctrl+C to that pane through its input lane, behind anything typed or sent before it
  (and after keys typed into its terminal have settled), once the same process group is still in
  front of the same shell and the command is still the one the row showed.
- Force end is offered only when Ctrl+C was sent at least 3 s earlier and that same group still
  runs; it sends SIGTERM to the pane's foreground process group (the group herdr names in
  `pane.process_info`), never to a process found by name. The group is the job the shell runs, so
  everything in it ends. A pane running this Ovis server, its process group or its launcher is
  refused. This relies on herdr and the server sharing one PC's process ids, as the move does.
- End all and move now asks the server for the running commands it would end
  (`POST /api/runtime/move/stop-all` with `{}`), shows "Ends N running commands. Unsaved work may be
  lost." for that list, and sends its token on confirm. The server ends nothing when the list (panes,
  commands, process groups) is no longer the one it offered; the person is asked again. A token is
  used once and belongs to one wait.
- Nothing is sent or signalled when Ovis cannot tell its own process group (Linux reads
  `/proc/self/stat`, macOS asks `ps`), and a cancel that arrives while herdr answers the last look
  sends nothing: herdr checks the wait again right before it writes Ctrl+C.
- Force end signals only when this PC itself reports that group in front of the shell's terminal
  (`/proc/<shell>/stat` tpgid, or `ps -o tpgid=` on macOS); otherwise (`not_local`, e.g. Ovis and
  herdr in different pid namespaces) nothing is signalled. It is still not atomic: a process group
  has no pidfd, so between that last look and the kill the group could end and its id be reused.
- The command a row or End all's confirm showed is compared with the name from the same look as the
  group that is ended, and End all ends each pane only while it runs the shell and group the confirm
  covered. The confirm lists the commands its token covers. A server that stops drops any stop still
  on its way.

Agents are never ended from the wait: their row opens the agent's pane, where the person ends it.
A pane that does not end keeps the move waiting, as before.

## How it runs

1. Each agent Ovis ends is sent its own exit command (`/exit`, through herdr's agent.prompt) only
   while herdr still says it is idle and its input box reads empty, and must be gone within 10 s. If it takes work instead, nothing
   more is typed into it and the move rolls back.
2. Everything is built on herdr-core through an adapter of the move's own, on a socket in the state
   folder, while the server still serves herdr. Every terminal it starts carries `ovis.move=<id>`.
3. The agents start there; then the runtime switches to herdr-core.

herdr is never closed or changed. On any failure before the switch is taken, every terminal labeled
with the move is ended, then each agent ended in herdr starts again in its own pane on its own
conversation, unless the pane has an agent again or the conversation runs elsewhere (the result
names those). Each step is written to `runtime-move-<port>.json` in the state folder before it is
taken; a server that stops mid-move leaves the move `interrupted`, and nothing is retried by itself.

To go back after a move, switch the runtime to herdr in Settings: herdr's workspaces, tabs and
shells are where they were, but the agents the move ended there stay ended (their conversations
run on herdr-core); end those on herdr-core first, then reopen them in herdr from Earlier sessions.
