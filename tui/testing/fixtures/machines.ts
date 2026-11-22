import { type Fixture, place } from "./fixture.ts";

/** This PC's core and two machines it reaches, each running a terminal; the screen shows this PC's. */
export const machines: Fixture = {
  options: {
    machines: [
      { id: "m-build", name: "build", host: "build.local", state: "connected", target: "build", version: "0.1.18" },
      { id: "m-lab", name: "lab", host: "lab.local", state: "connected", target: "lab", version: "0.1.18" },
    ],
  },
  build(core) {
    place(core, { space: "w-home", spaceName: "home", tab: "t-home", tabName: "home" }, "this pc\r\n");
    place(core, { space: "w-build", spaceName: "build", tab: "t-build", tabName: "build", on: "build" }, "build machine\r\n");
    place(core, { space: "w-lab", spaceName: "lab", tab: "t-lab", tabName: "lab", on: "lab" }, "lab machine\r\n");
  },
};
