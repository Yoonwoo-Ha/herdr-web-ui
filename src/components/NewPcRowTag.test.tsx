import { afterEach, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pcHeld, setPcNewness } from "../lib/relay/newPcHere.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { NewPcRowTag } from "./NewPcRowTag.tsx";

afterEach(() => setPcNewness(null));

const render = (): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try { return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(NewPcRowTag, { serverId: "a".repeat(32) }) })); }
  finally { if (saved) Object.defineProperty(navigator, "languages", saved); else Reflect.deleteProperty(navigator, "languages"); }
};

it("#16, C3 pin 2: the page's own PC row carries the New PC tag and the one-tap removal while it is new, and nothing once known not new", () => {
  setPcNewness({ until: Date.now() + 3_600_000 });
  const html = render();
  expect(html).toContain("New PC");
  expect(html).toContain("I didn&#x27;t add this");
  setPcNewness("unknown");
  expect(render()).toBe("");
  setPcNewness({ until: Date.now() - 1 });
  expect(render()).toBe("");
  setPcNewness(null);
  expect(render()).toBe("");
});

it("#29: a PC added before this device joined gets no row in the sidebar, and stays held all the same", () => {
  setPcNewness({ until: Date.now() + 3_600_000, beforeYou: true });
  expect(render()).toBe("");
  expect(pcHeld()).toBe(true);
});
