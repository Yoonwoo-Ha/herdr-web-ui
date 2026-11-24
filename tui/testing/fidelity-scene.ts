import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { IsolatedCore } from "../../scripts/test-hc.ts";
import { HcConnection } from "../../server/herdr-core/connection.ts";
import { PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { connectCoreSocket } from "../../server/herdr-core/socket-transport.ts";
import { coreWire } from "./core-wire.ts";
import { DETACH, entryEnv, entryPty, SOURCE_OVIS } from "./entry-pty.ts";
import type { SupervisedRun } from "./pty.ts";

/** Scripted output travels over a separate stream so it cannot replace or be confused with terminal input. */
const PROGRAM = `
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
const [name, inbox, control, init] = process.argv.slice(2);
const commands = createInterface({ input: createConnection(control), crlfDelay: Infinity });
commands.on("line", (line) => {
  const { bytes, mark, end } = JSON.parse(line);
  if (end) process.exit(0);
  process.stdout.write(bytes + mark);
});
process.stdin.setRawMode(true);
let total = 0;
process.stdin.on("data", (bytes) => {
  appendFileSync(inbox, bytes);
  total += bytes.length;
  if (!/^\\x1b\\[\\d+;\\d+R$/.test(bytes.toString("latin1"))) {
    process.stdout.write("RX:" + total + ":" + bytes.toString("hex") + "\\r\\n");
  }
});
process.stdout.write(init + name + "-READY\\r\\n");
`;

export interface SeedPane {
  readonly id: string;
  readonly name: string;
  readonly input: () => Buffer;
  emit(bytes: string, mark?: string): void;
  finish(): void;
  nextSize(): Promise<{ cols: number; rows: number }>;
  received(length: number): Promise<Buffer>;
}

export async function fidelityScene(core: IsolatedCore) {
  const socket = join(core.root, "wire.sock");
  const wire = await coreWire(socket, core.socket);
  const hc = new HcConnection(await connectCoreSocket(core.socket).then((transport) => () => transport));
  const script = join(core.root, "program.ts");
  writeFileSync(script, PROGRAM);
  const stopControls: (() => Promise<void>)[] = [];
  let count = 0;
  const seed = async (name: string, init = "", tab = "one", workspace = "work"): Promise<SeedPane> => {
    const base = join(core.root, `pane-${++count}`);
    const inbox = `${base}.in`;
    const control = `${base}.sock`;
    writeFileSync(inbox, "");
    let output: Socket | undefined;
    const queued: string[] = [];
    const send = (command: { bytes: string; mark: string } | { end: true }) => {
      const line = JSON.stringify(command) + "\n";
      if (output) output.write(line);
      else queued.push(line);
    };
    const server = createServer((socket) => {
      output = socket;
      socket.on("error", () => socket.destroy());
      for (const line of queued.splice(0)) socket.write(line);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(control, resolve);
    });
    stopControls.push(() => {
      output?.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const { address: id } = await hc.call("terminal.run", {
      argv: [process.execPath, script, name, inbox, control, init], cwd: core.root,
      labels: { [SPACE_LABEL]: workspace, [WORKSPACE_NAME_LABEL]: workspace, [TAB_LABEL]: tab, [TAB_NAME_LABEL]: tab, [PANE_NAME_LABEL]: name },
    });
    const input = () => readFileSync(inbox);
    return {
      id, name, input,
      emit: (bytes, mark = "") => send({ bytes, mark }),
      finish: () => send({ end: true }),
      nextSize: async () => {
        const { cols, rows } = await hc.call("terminal.get", { terminal: id });
        return { cols, rows };
      },
      received: (length) => new Promise<Buffer>((resolve, reject) => {
        const poll = setInterval(read, 10);
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error(`${name} did not receive ${length} bytes: ${input().toString("hex")}`));
        }, 5_000);
        function read() {
          const got = input();
          if (got.length < length) return;
          clearTimeout(timer);
          clearInterval(poll);
          resolve(got);
        }
        read();
      }),
    };
  };
  const screen = (options: Parameters<typeof entryPty>[4] = {}, cols = 100, rows = 30, entry: readonly string[] = [...SOURCE_OVIS, "tui"], extra: Record<string, string> = {}): SupervisedRun =>
    entryPty(entry, { ...entryEnv(core, core.bin), HC_SOCKET: socket, ...extra }, cols, rows, options);
  return {
    core, hc, wire, seed, screen,
    close: async () => { hc.close(); await Promise.all([wire.close(), ...stopControls.map((stop) => stop())]); },
  };
}

export async function livePane(run: SupervisedRun, name: string): Promise<void> {
  await run.until(new RegExp(`${name}-READY[\\s\\S]*\\x1b\\[\\?25h`), `live ${name} pane`);
}

export async function detach(run: SupervisedRun): Promise<number> {
  run.type(DETACH);
  return (await run.ended).code;
}
