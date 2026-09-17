import { describe, expect, it } from "bun:test";
import { PtySession } from "./session.ts";

/**
 * The attach command is `herdr terminal attach`, and herdr's CLI picks its socket from
 * HERDR_SOCKET_PATH, so the session must be able to hand the command an environment
 * of its own on top of the server's - otherwise a non-default session's terminals
 * are looked up on the default socket and the attach dies.
 */
describe("PtySession", () => {
  it("forwards extra env to the command running on the pty", async () => {
    const sentinel = "/tmp/herdr-web-ui-session-test.sock";
    let output = "";
    const printed = new Promise<string>((resolve) => {
      new PtySession({
        command: "sh",
        args: ["-c", 'printf "[%s]" "$HERDR_SOCKET_PATH"'],
        cols: 40,
        rows: 5,
        env: { HERDR_SOCKET_PATH: sentinel },
        onData: (data) => {
          output += data;
          if (output.includes("]")) resolve(output);
        },
        onExit: () => {},
      });
    });
    expect(await printed).toContain("[" + sentinel + "]");
  }, 10000);
});
