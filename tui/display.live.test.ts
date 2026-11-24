import { describe, expect, it } from "bun:test";
import { readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { constants } from "node:os";
import { basename, dirname, join } from "node:path";
import { coreFolder, IsolatedCore, stoppedCleanly } from "../scripts/test-hc.ts";
import { FRAME_AUTOMATIC_INPUT, FRAME_DATA, FRAME_FACTS, FRAME_RESIZE, HcConnection, makeFrameReader, type Frame } from "../server/herdr-core/connection.ts";
import { coreSocket } from "../server/herdr-core/core-socket.ts";
import { connectCoreSocket } from "../server/herdr-core/socket-transport.ts";
import { runSupervised, stopAllPtyRuns, type SupervisedRun } from "./testing/pty.ts";

const bin = process.env["OVIS_TEST_HC_BIN"];
const kitty = "\x1b_Gi=7,a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\";
const refusal = "\x1b_Gi=7;ENOTSUP:graphics are not supported\x1b\\";
const da1 = "\x1b[c";
const palette = { fg: "#123456", bg: "#abcdef", cell: [9, 20] };
const osc = "\x1b]10;?\x07\x1b]11;?\x07";
const initial = "\x1b]10;rgb:1212/3434/5656\x07\x1b]11;rgb:abab/cdcd/efef\x07";
const updated = "\x1b]11;rgb:2323/4545/6767\x07";
const answers = [
  ["\x1b]10;?\x1b\\", "\x1b]10;rgb:1212/3434/5656\x1b\\"],
  ["\x1b]11;?\x1b\\", "\x1b]11;rgb:abab/cdcd/efef\x1b\\"],
  ["\x1b[16t", "\x1b[6;20;9t"],
  ["\x1b[c", "\x1b[?62;22c"],
] as const;

const program = `
import { readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
const [inbox, control] = process.argv.slice(2);
watch(dirname(control), (event, file) => {
  if (event === "rename" && file === basename(control)) process.stdout.write(readFileSync(control, "utf8"));
});
process.stdin.setRawMode(true);
let input = Buffer.alloc(0);
process.stdin.on("data", (bytes) => {
  input = Buffer.concat([input, bytes]);
  writeFileSync(inbox + ".new", input);
  renameSync(inbox + ".new", inbox);
});
process.stdout.write("PANE-READY\\r\\n");
`;

/** The pane receives bytes at the slave PTY, independently of the viewer's output and socket frame cuts. */
async function received(inbox: string, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const read = (deadline = false) => {
      const bytes = readFileSync(inbox);
      if (bytes.length < length && !deadline) return;
      close();
      if (bytes.length >= length) resolve(bytes);
      else reject(new Error(`expected ${length} pane input bytes; got ${bytes.toString("hex")}`));
    };
    // Watch the directory for each published snapshot, not the inode replaced by the next write.
    const watcher = watch(dirname(inbox), (_event, name) => {
      if (name === null || name === basename(inbox)) read();
    });
    // Notifications can coalesce. Check the latest snapshot again before declaring a timeout.
    const timer = setTimeout(() => read(true), 5_000);
    const close = () => { clearTimeout(timer); watcher.close(); };
    read();
  });
}

describe.skipIf(!bin || process.platform === "win32")("terminal display queries through the real entry", () => {
  async function scene(check: (scene: {
    run: SupervisedRun; frames: Frame[]; attaches: Record<string, unknown>[];
    ask: (bytes: string) => void; receive: (length: number) => Promise<Buffer>; version: string;
    changeBackground: () => void; changed: Promise<Frame>;
    size: () => Promise<number[]>;
  }) => Promise<void>, rival = false): Promise<void> {
    const folder = coreFolder();
    const { root } = folder;
    const core = new IsolatedCore(bin!, folder);
    const frames: Frame[] = [];
    const attaches: Record<string, unknown>[] = [];
    const facts = Promise.withResolvers<Frame>();
    const path = join(root, "wire.sock");
    const proxy = createServer((client) => {
      const upstream = createConnection(core.socket);
      client.on("error", () => client.destroy()).on("close", () => upstream.destroy());
      upstream.on("error", () => upstream.destroy()).on("close", () => client.destroy());
      client.pipe(upstream).pipe(client);
      const read = makeFrameReader((frame) => {
        if (frame.channel === 0 && frame.kind === FRAME_DATA) {
          const request = JSON.parse(Buffer.from(frame.payload).toString());
          if (request.method === "terminal.attach") attaches.push(request.params);
        } else {
          frames.push(frame);
          if (frame.kind === FRAME_FACTS) facts.resolve(frame);
        }
      }, (message) => client.destroy(new Error(message)));
      let greeted = false;
      client.on("data", (bytes: Buffer) => {
        if (greeted) return read(bytes);
        const end = bytes.indexOf(10);
        if (end < 0) return;
        greeted = true;
        read(bytes.subarray(end + 1));
      });
    });
    let hc: HcConnection | undefined;
    let cleanup: Promise<void> | undefined;
    const stop = () => (cleanup ??= (async () => {
      await stopAllPtyRuns();
      hc?.close();
      if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
      expect(stoppedCleanly(await core.stop())).toBe(true);
    })());
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const interrupted = (signal: NodeJS.Signals) => { void stop().finally(() => process.exit(128 + constants.signals[signal])); };
    for (const signal of signals) process.once(signal, interrupted);
    try {
      await core.start();
      const transport = await connectCoreSocket(core.socket);
      hc = new HcConnection(() => transport);
      const version = (await hc.hello()).version;
      const inbox = join(root, "input");
      const control = join(root, "control");
      const script = join(root, "program.ts");
      writeFileSync(inbox, "");
      writeFileSync(script, program);
      const { address: terminal } = await hc.call("terminal.run", { argv: [process.execPath, script, inbox, control], cwd: root });
      if (rival) {
        const { channel } = await hc.open("terminal.attach", { terminal, cols: 120, rows: 40 }, { onData() {}, onClose() {} });
        channel.write("R");
        await received(inbox, 1);
      }
      await new Promise<void>((resolve, reject) => proxy.once("error", reject).listen(path, resolve));
      const env = {
        ...core.env, HC_SOCKET: path, PORT: "1", HERDR_PLUGIN_CONFIG_DIR: join(root, "plugin"),
        TERM: "xterm-256color", OVIS_TUI_STATE_DIR: join(root, "tui-state"), TMPDIR: root,
      };
      expect(coreSocket({ env }).path).toBe(path);
      let tail = "";
      let background: string | undefined;
      const run = runSupervised({
        entry: [process.execPath, join(import.meta.dir, "main.ts")], env, cols: 100, rows: 30, deadlineMs: 12_000,
        onData(text) {
          const window = tail + text;
          const seen = answers.flatMap(([query, answer]) => {
            const at = window.indexOf(query, Math.max(0, tail.length - query.length + 1));
            return at < 0 ? [] : [{ at, answer: background && query === "\x1b]11;?\x1b\\" ? background : answer }];
          });
          for (const { answer } of seen.sort((a, b) => a.at - b.at)) run.type(answer);
          tail = window.slice(-16);
        },
      });
      await run.until(/PANE-READY[\s\S]*\x1b\[\?25h/, "the live pane");
      await check({
        run, frames, attaches, version, changed: facts.promise,
        changeBackground: () => {
          background = updated;
          run.type("\x1b[?997;1n");
        },
        ask: (bytes) => {
          writeFileSync(control + ".new", bytes);
          renameSync(control + ".new", control);
        },
        receive: (length) => received(inbox, length),
        size: async () => {
          const { cols, rows } = await hc!.call("terminal.get", { terminal });
          return [cols, rows];
        },
      });
      run.type("\x02q");
      expect((await run.ended).code).toBe(0);
    } finally {
      await stop();
      for (const signal of signals) process.off(signal, interrupted);
    }
  }

  it("C2 answers OSC 10/11 from attach and updates OSC 11 through FACTS", async () => {
    await scene(async ({ run, attaches, ask, receive, version, changeBackground, changed }) => {
      ask(osc);
      const first = await receive(initial.length);
      console.log(version, "attach", JSON.stringify(attaches[0]), "input", first.toString("hex"));
      expect(attaches[0]?.["display"]).toEqual(palette);
      expect(first.toString()).toBe(initial);
      await run.until("\x1b[?2031h", "the color scheme subscription");
      changeBackground();
      const { payload } = await Promise.race([
        changed,
        run.ended.then(() => { throw new Error("the viewer ended without sending changed display facts"); }),
      ]);
      expect(JSON.parse(Buffer.from(payload).toString())).toEqual({ ...palette, bg: "#234567" });
      // Seeing FACTS on the socket does not tell us whether the core handled it before the pane's query.
      const previous = initial.slice(initial.indexOf("\x1b]11;"));
      let offset = first.length;
      let answer = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        ask("\x1b]11;?\x07");
        answer = (await receive(offset + previous.length)).subarray(offset).toString();
        if (answer !== previous) break;
        offset += previous.length;
      }
      expect(answer).toBe(updated);
    });
    await scene(async ({ frames, attaches, changeBackground, changed, run, size }) => {
      changeBackground();
      await Promise.race([changed, run.ended.then(() => { throw new Error("no FACTS beside the driving viewer"); })]);
      expect([attaches[0]?.["display"], await size(), frames.some(({ kind }) => kind === FRAME_RESIZE)])
        .toEqual([palette, [120, 40], false]);
    }, true);
  }, 45_000);

  it("C3 refuses Kitty in one reply and does not advertise sixel in DA1", async () => {
    await scene(async ({ run, frames, ask, receive, version }) => {
      const old = version === "0.1.17";
      // DATA counts as typing on 0.1.17, so first make ourselves the driver there.
      const prefix = old ? "A" : "";
      if (old) {
        run.type(prefix);
        await receive(prefix.length);
      }
      ask(kitty);
      const graphics = await receive(prefix.length + refusal.length);
      console.log(version, "graphics input", graphics.toString("hex"));
      expect(run.output()).not.toContain(kitty);
      expect(graphics.toString()).toBe(prefix + refusal);
      expect(frames.filter(({ payload }) => Buffer.from(payload).includes(refusal)).map(({ kind }) => kind)).toEqual([old ? FRAME_DATA : FRAME_AUTOMATIC_INPUT]);
      ask(da1);
      const attributes = (await receive(graphics.length + 5)).subarray(graphics.length).toString();
      expect(attributes).toMatch(/^\x1b\[\?\d+(?:;\d+)*c$/);
      expect(attributes.slice(3, -1).split(";").slice(1)).not.toContain("4");
    });
  }, 45_000);
});
