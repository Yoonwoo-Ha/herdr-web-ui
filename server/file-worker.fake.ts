import { closeSync, constants, openSync, readSync } from "node:fs";

import { type FileTask, runFileTask, transferablesOf } from "./file-tasks.ts";
import { pageFileHooks } from "./file-view.ts";

declare const self: Worker;

type Gate = { cells: SharedArrayBuffer; fifo: string };

/** Opens the gate's FIFO (which never waits), names it in cell 2 and `fd` in cell 1 (`Atomics.notify`), then blocks in a read of it. */
const holdOnFifo = (gate: Gate, fd: number): void => {
  const cells = new Int32Array(gate.cells);
  const fifo = openSync(gate.fifo, constants.O_RDWR);
  Atomics.store(cells, 2, fifo);
  Atomics.store(cells, 1, fd);
  Atomics.notify(cells, 1);
  try { readSync(fifo, new Uint8Array(1), 0, 1, null); } finally { if (Atomics.exchange(cells, 2, -1) >= 0) closeSync(fifo); }
};

self.onmessage = (event: MessageEvent<FileTask & { gate?: SharedArrayBuffer; readGate?: Gate; authorizeGate?: Gate }>) => {
  const task = event.data;
  if ("path" in task && (task.path.endsWith("/stuck") || (task.op === "open" && task.path.endsWith("/held-open")))) return;
  const readGate = task.readGate;
  if (readGate !== undefined) {
    pageFileHooks.readSync = (fd, buffer, offset, length, position) => {
      holdOnFifo(readGate, fd);
      return readSync(fd, buffer, offset, length, position);
    };
  }
  const authorizeGate = task.authorizeGate;
  if (authorizeGate !== undefined) {
    pageFileHooks.afterAuthorize = () => holdOnFifo(authorizeGate, "opened" in task && task.opened !== undefined ? task.opened[0]! : -2);
  }
  let result;
  try { result = runFileTask(task); } finally { delete pageFileHooks.readSync; delete pageFileHooks.afterAuthorize; }
  if (task.gate !== undefined) {
    const cells = new Int32Array(task.gate);
    const opened = task.op === "open" && task.opened !== undefined ? task.opened[0]! : -1;
    const fd = result !== null && typeof result === "object" && "fd" in result && result.fd !== null ? result.fd : opened;
    Atomics.store(cells, 1, fd >= 0 ? fd : -2);
    Atomics.notify(cells, 1);
    Atomics.wait(cells, 0, 0);
  }
  postMessage({ result }, transferablesOf(result));
};
