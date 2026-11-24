# Ovis and Herdr terminal performance

On this Linux host, Ovis used **3.11x the idle stack RSS** of native Herdr and took **235.297 ms to settle a resize, versus 94.512 ms**. A lone key echoed in **2.998 ms for Ovis and 0.732 ms for Herdr**; during a burst, the medians were **6.197 ms and 0.361 ms**. Ovis switched visible panes faster and completed the 50 MB flood sooner at the median. Both screens coalesced most flood updates, and an independent repeat saw a longer Ovis flood tail.

These numbers come from an earlier build of Ovis's screen with its Bun launcher, measured in November 2026 with Bun 1.4.4 and herdr-core 0.1.18. The other stack is Herdr 0.9.5's native client and server. These are measurements of the two complete terminal stacks, with no Ovis web server running in the scene. They are not measurements of the two servers in isolation.

## Comparison

Each entry is the median **[min, max]** of ten independent measurements. For key, resize and pane switch the per-run value is the median of the actions in that run. RSS is in KiB; the process counts are constant within each column.

| Metric | Herdr 0.9.5 | Ovis + herdr-core 0.1.18 |
| --- | ---: | ---: |
| Client launch to first frame (ms) | 257.829 [25.414, 260.767] | 167.422 [161.913, 187.291] |
| Idle RSS, 4 panes, stack only (KiB) | 36,174 [36,056, 36,276]; 2 processes | 112,478 [111,660, 113,712]; 4 processes |
| Idle RSS, 4 panes, including fixtures (KiB) | 44,096 [43,976, 44,200]; 6 processes | 120,384 [119,564, 121,620]; 8 processes |
| Idle RSS, 20 panes, stack only (KiB) | 38,236 [38,188, 38,336]; 2 processes | 118,860 [118,624, 119,316]; 4 processes |
| Idle RSS, 20 panes, including fixtures (KiB) | 77,848 [77,796, 77,932]; 22 processes | 158,394 [158,164, 158,848]; 24 processes |
| Idle CPU, 60 s, 4 panes (% of one CPU) | 0.250 [0.233, 0.350] | 0.283 [0.233, 0.333] |
| Lone key to visible echo (ms) | 0.732 [0.572, 0.778] | 2.998 [2.809, 3.229] |
| Burst key to visible echo (ms) | 0.361 [0.323, 0.530] | 6.197 [5.469, 6.747] |
| 50 MB flood to visible completion (ms) | 570.594 [560.295, 714.280] | 414.202 [411.484, 603.251] |
| Flood checkpoints never visible (out of 1,000) | 962.5 [956, 964] | 954 [938, 954] |
| Resize to settled display (ms) | 94.512 [87.130, 97.748] | 235.297 [233.307, 240.310] |
| Switch between visible split panes (ms) | 6.578 [6.038, 7.563] | 2.986 [2.720, 3.911] |
| RSS after 100 MB of output churn, 20 panes, stack only (KiB) | 38,934 [38,896, 38,980]; 2 processes | 143,418 [136,452, 156,408]; 4 processes |
| RSS change from 20-pane idle to after churn (KiB) | +688 [+624, +728] | +24,440 [+17,136, +37,504] |
| Attach to a pane with saturated scrollback, to visible frame (ms) | 255.749 [254.967, 256.596] | 164.077 [160.301, 167.644] |

Two Herdr starts landed near 25 ms; the other eight landed between 255 and 261 ms. Both groups stayed in the sample. The cause of the two startup bands was not established, so the median alone should not be read as a general startup advantage for either client.

An independent repeat of five Ovis flood runs had a median of 416.783 ms, close to the primary median. Two accepted runs took **925.547 ms and 1,322.511 ms**, beyond the slowest measured Herdr run (714.280 ms across the primary and repeat samples). The long Ovis runs used more CPU and showed 111 and 95 checkpoints instead of the usual 46. The cause of the tail was not established.

## How it was measured

One harness used the same Bun PTY, `xterm-256color`/truecolor settings, query answers (primary device attributes and synchronized output support), and host-side VT decoder for both sides. The outer PTY was 120 x 40 initially. The scene had one workspace, two side-by-side panes per tab and four pane programs at first (two tabs). It grew to 20 pane programs (ten tabs), with the same first tab still visible. Every pane used the same `/bin/sh` fixture, waiting on the shell's builtin `read` when idle. The native clients can reserve different numbers of cells for chrome, so the outer dimensions and split topology matched while the inner pane dimensions were allowed to differ.

- **Launch and attach:** Start the clock just before spawning the client command against an already running, freshly seeded server. Stop when both visible pane markers have arrived, then verify they are both visible in the decoded grid. Launch includes Ovis's launcher. For history attach, detach the client, write 200,000 numbered lines to the first pane, verify its tail and that the oldest input was no longer available, then start a fresh client. Both clients had to paint the final history line, the completion marker and the other pane. Herdr reported 24,911 rows of scroll offset in a diagnostic run; its `pane read --source recent` exposed 997 numbered lines. The core read returned 2,884 numbered lines and reported the read was incomplete. Ovis requests 2,000 history lines on attach. This times the user's first usable frame with each stack's normal history policy, rather than transfer of an identical number of history bytes.
- **RSS and idle CPU:** Sum `/proc/<pid>/status` `VmRSS` for each living stack component. Herdr had the server and client; Ovis had the core server, holder, Bun launcher and Bun screen. The fixture rows add the 4 or 20 separate shell processes. Summed RSS can double-count shared pages; it is not PSS. A separate measurement took `/proc/<pid>/stat` user and system tick deltas across 60 seconds of idle with four pane programs and no harness input. The report expresses the sum as a share of one logical CPU. The primary idle windows lasted 60.00024 to 60.00062 s.
- **Key and pane switch:** For a lone key, send Enter by itself after 100 ms without a paint. For a burst key, send Enter immediately after preloading a short token and start the next press as soon as the preceding echo is observed. In both cases disable TTY echo and time to the fixture's first visible echo, eight presses per variant. Switch with `Ctrl+B` then `h` or `l` (eight switches); time to the last paint before 100 ms of quiet, then verify focus by reading back a token from the new pane.
- **Resize:** Alternate the outer PTY between 120 x 40 and 140 x 44 four times. The pane's `SIGWINCH` trap reads its current size and gives each report a new serial number. For each resize, require a report newer than the preceding resize, at the exact target pane size, both in the fixture log and in the decoded grid. Also verify the new bottom edge. Wait for 100 ms of quiet *after* the new size appears before starting the next resize; the timed endpoint is the last paint, excluding that quiet interval. This rules out a repaint of an old size and a resize back while the pane is still waiting to reattach.
- **Throughput and missed frames:** The focused pane emits exactly 50,000,000 bytes, made of 1,000 ordered 50,000-byte blocks. Each block puts its numbered checkpoint on the first row while the rows below scroll. Time from Enter to a distinct completion marker in the host PTY. The common VT observer counts unique checkpoint IDs seen in changed screen rows at PTY read boundaries; a missed ID means that intermediate checkpoint was not observed. This measures visible updates at the observer boundary, including client coalescing and read batching, not lost pane bytes.
- **Churn:** With all 20 panes live, the same focused pane emits two more 50 MB floods. Sample RSS after the completion marker and 100 ms of quiet, without a forced GC. This is a compressed byte-equivalent for an hour carrying 100 MB of output (about 27.8 kB/s averaged over an hour). It stresses scrolling and rendering but does not measure an hour of wall-clock behavior or prove a leak.

Both batches ran one scene at a time, alternating which stack went first, on an AMD Threadripper PRO 3995WX with Linux 7.0.0-42-generic. Each batch was pinned to two cores and their SMT siblings. Every sample had a separate scratch HOME, XDG folders and socket paths. The harness stopped the client and its own server and checked that the recorded fixture processes and scratch sockets were gone before moving to the next sample. It sampled `/proc/pressure/cpu` once a second and at the start and end of every sample. The primary maximum `some avg10` was 5.52%; the corrected batch's accepted maximum was 18.24%. Three Ovis attempts exceeded 20% and were rejected; the missing runs were completed after pressure fell.

## Where Ovis costs more

The extra idle RSS mainly comes from the two Bun processes. At 20 panes the medians by process were 73,384 KiB for the Ovis screen, 35,132 for the launcher, 6,712 for the core server and 3,624 for its holder. Herdr used 24,014 KiB for its server and 14,222 for its client. The two core processes together used less RSS than the Herdr server; the difference is on the client side.

After churn, the Ovis screen's median RSS was 90,422 KiB, with anonymous RSS rising from 34,548 to 50,242 KiB. The core server also grew, from 6,712 to 12,140 KiB; the launcher stayed near 35,132 KiB. Separate Bun heap snapshots at detach reported 11.5 MiB of JS heap for the screen and 2.0 MiB for the launcher. The snapshots do not account for WASM, allocator reservations or file mappings, so they cannot attribute all the resident growth. A separate CPU profile found work in the painter, protocol line reader and Ghostty WASM. A useful next measurement would check how much RSS stays resident after longer idle, then compare the stack with a launcher that hands off its process, before proposing a change.

Ovis key echo was **4.1x** the Herdr median for a lone press and **17.2x** in a burst. Two independent quiet-screen Ovis medians were 2.452 and 2.794 ms. Our socket tap measured the core and fixture leg at 0.285 ms for lone input and 0.178 ms in the burst, about 0.2 ms. From the core's echo at the tap to the echo observed at the host PTY, the medians were 1.883 ms and 4.796 ms. The screen therefore has about a 2 ms floor of its own; closely spaced presses also hit the 8 ms frame-pass limit in `tui/loop.ts` and `tui/model/deadlines.ts`. The whole key-to-echo latency includes the host-to-core input path as well.

Ovis was **2.49x** slower to settle a resize in this scene. In the build measured, `tui/model/deadlines.ts` set a 150 ms wait after the last rectangle change so a drag does not force an attach on every step (32 ms since: see "After the resize change"). As described in [the parity notes](parity.md#differs-from-herdr), Ovis then closes and reopens the attach. While the pane has no viewer, herdr-core gives it the unviewed size of 200 x 120. The fixture logged that intermediate size and then the target size on all 40 measured Ovis resizes. Herdr gave the fixture just the target size on all 40. The 150 ms wait is the main structural difference; the close, intermediate resize, reattach and paint are included in the remaining time.

## After the resize change

A pane now attaches again 32 ms after the last change of its own rectangle instead of 150 ms; while another viewer's size change is still settling it waits the 150 ms as before, and the size rules are unchanged. Measured afterwards with the same harness, ten runs per build, Ovis only, each build from its own clean checkout, one run at a time; median [min, max]:

| Metric | Before | After |
| --- | ---: | ---: |
| Resize to settled display (ms) | 227.551 [226.715, 233.16] | 109.798 [108.492, 112.556] |
| RSS change from 20-pane idle to after churn (KiB) | 33436 [23964, 36336] | 34790 [30968, 51356] |
| Lone key to visible echo (ms) | 2.164 [2.01, 3.069] | 2.186 [1.925, 2.659] |

The build measured after also launched the screen differently; the launch path takes no part in a resize, a churn or a key echo.

- **Churn:** not changed. The screen's growth is not its JS heap, its engines' history or a queue: a probe from inside the screen found the JS heap, ArrayBuffers and the engines' WebAssembly memory back at their idle sizes, and repeated churns adding nothing after the first. The runtime keeps the first burst's peak pages and gives most of them back on its own within about 20 s (+8 to +10 MB stays); at the harness's sample, 100 ms after the churn, they are still held.

## Raw numbers

All times are milliseconds, memory is stack RSS in KiB, and CPU and pressure are percentages. `Missed` counts unobserved flood checkpoints. `Churn +` is relative to the matching 20-pane idle sample. Process counts are in the comparison table. The lone key, burst key, resize and corrected pressure columns come from the corrected ten-run batch; the other columns come from the original batch.

| Stack | Run | Launch | RSS 4 | RSS 20 | Idle CPU | Lone key | Burst key | Flood | Missed | Resize | Switch | Churn RSS | Churn + | History attach | Primary avg10 | Corrected avg10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Herdr | 1 | 258.265 | 36276 | 38212 | 0.283 | 0.737 | 0.530 | 577.108 | 963 | 92.993 | 7.226 | 38896 | 684 | 256.127 | 5.52 | 4.80 |
| Herdr | 2 | 259.055 | 36136 | 38292 | 0.233 | 0.601 | 0.388 | 561.040 | 963 | 94.603 | 6.566 | 38948 | 656 | 256.346 | 1.04 | 5.46 |
| Herdr | 3 | 25.703 | 36068 | 38236 | 0.267 | 0.749 | 0.339 | 560.744 | 963 | 95.988 | 6.038 | 38964 | 728 | 255.394 | 0.54 | 5.69 |
| Herdr | 4 | 260.767 | 36272 | 38212 | 0.250 | 0.611 | 0.365 | 560.295 | 964 | 93.860 | 6.604 | 38932 | 720 | 256.389 | 0.91 | 7.58 |
| Herdr | 5 | 257.393 | 36152 | 38296 | 0.300 | 0.690 | 0.333 | 564.079 | 963 | 97.748 | 7.563 | 38944 | 648 | 256.596 | 1.67 | 9.34 |
| Herdr | 6 | 256.874 | 36140 | 38312 | 0.350 | 0.728 | 0.352 | 562.254 | 962 | 94.770 | 6.589 | 38936 | 624 | 254.967 | 2.04 | 12.28 |
| Herdr | 7 | 255.958 | 36276 | 38232 | 0.250 | 0.766 | 0.323 | 579.754 | 962 | 94.475 | 6.520 | 38932 | 700 | 255.485 | 1.04 | 11.31 |
| Herdr | 8 | 259.540 | 36196 | 38336 | 0.233 | 0.778 | 0.357 | 714.280 | 956 | 94.423 | 6.420 | 38980 | 644 | 255.248 | 1.20 | 16.10 |
| Herdr | 9 | 259.174 | 36264 | 38188 | 0.250 | 0.740 | 0.383 | 579.783 | 961 | 94.549 | 6.454 | 38896 | 708 | 255.502 | 0.44 | 18.24 |
| Herdr | 10 | 25.414 | 36056 | 38236 | 0.233 | 0.572 | 0.441 | 580.181 | 962 | 87.130 | 6.909 | 38928 | 692 | 255.995 | 3.66 | 6.69 |
| Ovis | 1 | 187.291 | 113712 | 118820 | 0.333 | 3.229 | 5.508 | 411.720 | 954 | 237.498 | 2.928 | 138304 | 19484 | 163.748 | 5.52 | 4.72 |
| Ovis | 2 | 167.637 | 112344 | 118736 | 0.317 | 3.034 | 6.603 | 414.249 | 954 | 233.705 | 2.857 | 138568 | 19832 | 165.957 | 1.04 | 5.46 |
| Ovis | 3 | 167.545 | 113000 | 119272 | 0.283 | 2.952 | 6.747 | 413.073 | 954 | 235.286 | 3.101 | 145048 | 25776 | 167.644 | 2.06 | 5.69 |
| Ovis | 4 | 169.154 | 112848 | 119192 | 0.283 | 3.108 | 6.289 | 420.003 | 953 | 233.404 | 2.968 | 143212 | 24020 | 165.618 | 3.55 | 5.60 |
| Ovis | 5 | 166.872 | 112492 | 118900 | 0.283 | 2.824 | 5.469 | 414.154 | 954 | 236.918 | 3.083 | 144884 | 25984 | 165.173 | 1.79 | 14.01 |
| Ovis | 6 | 167.298 | 112304 | 118904 | 0.300 | 2.809 | 6.438 | 603.251 | 938 | 233.307 | 3.225 | 156408 | 37504 | 164.405 | 1.46 | 13.82 |
| Ovis | 7 | 173.258 | 112056 | 118624 | 0.317 | 3.170 | 5.949 | 415.337 | 954 | 234.753 | 3.005 | 141080 | 22456 | 163.742 | 1.39 | 11.65 |
| Ovis | 8 | 166.939 | 113016 | 118628 | 0.233 | 3.069 | 6.085 | 415.025 | 954 | 240.310 | 2.720 | 143624 | 24996 | 160.301 | 0.74 | 13.54 |
| Ovis | 9 | 164.661 | 112464 | 119316 | 0.250 | 2.963 | 6.106 | 413.356 | 954 | 236.957 | 3.911 | 136452 | 17136 | 162.281 | 0.47 | 15.72 |
| Ovis | 10 | 161.913 | 111660 | 118796 | 0.233 | 2.954 | 6.532 | 411.484 | 954 | 235.308 | 2.804 | 143656 | 24860 | 160.358 | 1.04 | 12.52 |

In the reversed repeat pair, both key variants fell within the corrected ranges on both stacks: Herdr 0.635 ms lone and 0.408 ms burst; Ovis 2.847 ms lone and 5.679 ms burst. All three repeat pairs also proved every resize reached its target. Herdr's resize medians were 94.091, 93.831 and 97.639 ms, within its ten-run range. Ovis's were 232.924, 232.867 and 230.947 ms, 0.383 to 2.361 ms below its ten-run minimum. Those repeats are kept separately from the main table.

The measuring harness drove both stacks through one Bun pseudo-terminal and VT decoder, as described above; it is not part of this repository.
