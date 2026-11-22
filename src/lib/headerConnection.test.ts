import { afterEach, describe, expect, it } from "bun:test";
import { connectionWord, headerConnection, NO_TRACK, stepConnection, type ConnectionFacts, type ConnectionTrack } from "./headerConnection.ts";
import { nativeTransport, setTransport } from "./transport.ts";

const live: ConnectionFacts = { scope: "a:local", reportedBy: "a:local", connected: true, connectedBefore: true, outputStopped: false };

/**
 * `"1s"` is the reconnect lasting RECONNECTING_SHOWN_AFTER_MS: the hook's timer marks the loss shown; `"10s"` is it lasting
 * RECONNECT_FAILED_AFTER_MS, which marks it failed
 */
function lines(sequence: (ConnectionFacts | "1s" | "10s")[]): (string | null)[] {
  let track: ConnectionTrack = NO_TRACK;
  let facts = live;
  return sequence.map((step) => {
    if (step === "1s") track = track.lostOn === null ? track : { ...track, shown: true };
    else if (step === "10s") track = track.lostOn === null ? track : { ...track, shown: true, failed: true };
    else { facts = step; track = stepConnection(track, facts); }
    return headerConnection(facts, track);
  });
}
const shownLoss = (scope = "a:local"): ConnectionTrack => ({ lostOn: scope, recoveredOn: null, shown: true, failed: false });

describe("headerConnection", () => {
  it("says nothing while the PC is connected: the crumb has the line", () => {
    expect(headerConnection(live, NO_TRACK)).toBeNull();
  });

  it("says Reconnecting once a connection this page had has been lost for a second", () => {
    expect(headerConnection({ ...live, connected: false }, { ...shownLoss(), shown: false })).toBeNull();
    expect(headerConnection({ ...live, connected: false }, shownLoss())).toBe("reconnecting");
  });

  it("promises no reconnect for output stopped by a stall: nothing retries, the chip says Disconnected", () => {
    expect(headerConnection({ ...live, connected: false, outputStopped: true }, shownLoss())).toBeNull();
  });

  it("leaves the first connection to the chip: a pane opening is not a reconnect", () => {
    expect(headerConnection({ ...live, connected: false, connectedBefore: false }, shownLoss())).toBeNull();
  });

  it("says Connected while the scope it came back on is the one shown", () => {
    expect(headerConnection(live, { lostOn: null, recoveredOn: "a:local", shown: false, failed: false })).toBe("connected");
    expect(headerConnection({ ...live, connected: false }, { lostOn: null, recoveredOn: "a:local", shown: false, failed: false })).toBeNull();
  });

  it("keeps each PC's recovery to that PC", () => {
    expect(headerConnection({ ...live, scope: "a:devbox", reportedBy: "a:devbox" }, { lostOn: null, recoveredOn: "a:local", shown: false, failed: false })).toBeNull();
  });
});

describe("connectionWord", () => {
  afterEach(() => setTransport(nativeTransport));
  const t = (text: string): string => text;

  it("says the PC is off once the relay has waited for it, and that it can't be reached when no relay answered", () => {
    setTransport({ ...nativeTransport, unreached: "pc" });
    expect(connectionWord("failed", t)).toBe("Turn on Ovis on the PC");
    setTransport({ ...nativeTransport, unreached: "relay" });
    expect(connectionWord("failed", t)).toBe("Can't reach the PC");
    setTransport(nativeTransport);
    expect(connectionWord("failed", t)).toBe("Can't reach the PC");
    expect(connectionWord("reconnecting", t)).toBe("Reconnecting…");
    expect(connectionWord("connected", t)).toBe("Connected");
  });
});

describe("the line over time", () => {
  it("goes Reconnecting a second into a loss, then Connected, once the same connection is back", () => {
    expect(lines([live, { ...live, connected: false }, "1s", live])).toEqual([null, null, "reconnecting", "connected"]);
  });

  it("names nothing for a reconnect over within a second, neither the loss nor its return", () => {
    expect(lines([live, { ...live, connected: false }, live])).toEqual([null, null, null]);
  });

  it("stops promising a reconnect ten seconds into a loss, and still says Connected when it comes back", () => {
    const lostHere = { ...live, connected: false };
    expect(lines([live, lostHere, "1s", lostHere, "10s", lostHere, live])).toEqual([null, null, "reconnecting", "reconnecting", "failed", "failed", "connected"]);
  });

  it("keeps the loss's second running while it stays lost", () => {
    const lostHere = { ...live, connected: false };
    expect(lines([live, lostHere, lostHere, "1s", lostHere])).toEqual([null, null, null, "reconnecting", "reconnecting"]);
  });

  it("does not say Connected after an output stall: that connection was never said to be reconnecting", () => {
    expect(lines([live, { ...live, connected: false, outputStopped: true }, "1s", live])).toEqual([null, null, null, null]);
  });

  it("resets on a switch to another PC: its first connection is not a return", () => {
    const lostHere = { ...live, connected: false };
    const switched = { ...live, scope: "a:devbox", reportedBy: "a:local", connected: false, connectedBefore: false };
    const devboxUp = { ...live, scope: "a:devbox", reportedBy: "a:devbox" };
    expect(lines([live, lostHere, "1s", switched, devboxUp])).toEqual([null, null, "reconnecting", null, null]);
  });

  it("says Connected the render the connection is back, before the effect moves the track: the crumb never flashes", () => {
    let track: ConnectionTrack = { ...stepConnection(stepConnection(NO_TRACK, live), { ...live, connected: false }), shown: true };
    expect(headerConnection(live, track)).toBe("connected");
    track = stepConnection(track, live);
    expect(headerConnection(live, track)).toBe("connected");
  });

  it("says nothing for the other split half on one PC that never dropped", () => {
    const aLost = { ...live, connected: false };
    const bActiveStale = { ...aLost, scope: "b:local" };
    const bReports = { ...live, scope: "b:local", reportedBy: "b:local" };
    expect(lines([live, aLost, "1s", bActiveStale, bReports])).toEqual([null, null, "reconnecting", null, null]);
  });
});
