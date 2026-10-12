import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FONT_FAMILY_MAX_CHARS } from "./fontFamily.ts";
import { DEFAULT_KEY_BAR_ITEMS, migrateKeyBarItems } from "./keyBar.ts";
import { SHARED_SETTING_KEYS } from "../../shared/preferences.ts";
import { SETTING_SCOPE, changedSettings, alertPrefs, CHAT_FONT_MAX, CHAT_FONT_MIN, CHAT_LANE_MAX_REM, CHAT_LANE_MIN, CHAT_WIDTHS, chatFontSize, chatLaneLength, chatLaneWidth, DEFAULT_SETTINGS, MARKDOWN_WIDTHS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, quickReplyButtons, sanitizeSettings, terminalTheme, forgetPaneViews, DICTATION_LANGUAGES, VOICE_BUTTONS, wantsVoiceInput } from "./settings.ts";

it("keeps a tab's pane while out of use until this device turns the pause on", () => {
  expect(DEFAULT_SETTINGS.releasePaneAway).toBe(false);
  expect(sanitizeSettings({}).releasePaneAway).toBe(false);
  expect(sanitizeSettings({ releasePaneAway: true }).releasePaneAway).toBe(true);
  expect(sanitizeSettings({ releasePaneAway: "true" }).releasePaneAway).toBe(false);
});

it("shrinks a narrow split pane's font until this device turns it off", () => {
  expect(DEFAULT_SETTINGS.narrowPaneFont).toBe(true);
  expect(sanitizeSettings({}).narrowPaneFont).toBe(true);
  expect(sanitizeSettings({ narrowPaneFont: false }).narrowPaneFont).toBe(false);
  expect(sanitizeSettings({ narrowPaneFont: "false" }).narrowPaneFont).toBe(true);
});

it("keeps the screen wake lock off until this device explicitly enables it", () => {
  expect(DEFAULT_SETTINGS.keepScreenOn).toBe(false);
  expect(sanitizeSettings({}).keepScreenOn).toBe(false);
  expect(sanitizeSettings({ keepScreenOn: true }).keepScreenOn).toBe(true);
  expect(sanitizeSettings({ keepScreenOn: "true" }).keepScreenOn).toBe(false);
  // the terminal's wheel speed: one report per wheel event unless chosen, whole and bounded
  expect(sanitizeSettings({}).terminalWheelSpeed).toBe(1);
  expect(sanitizeSettings({ terminalWheelSpeed: 3 }).terminalWheelSpeed).toBe(3);
  expect(sanitizeSettings({ terminalWheelSpeed: 2.6 }).terminalWheelSpeed).toBe(3);
  expect(sanitizeSettings({ terminalWheelSpeed: 99 }).terminalWheelSpeed).toBe(10);
  expect(sanitizeSettings({ terminalWheelSpeed: 0 }).terminalWheelSpeed).toBe(1);
  expect(sanitizeSettings({ terminalWheelSpeed: "3" }).terminalWheelSpeed).toBe(1);
});

it("keeps the terminal cursor at a block that blinks unless a saved shape or blink says otherwise", () => {
  expect(DEFAULT_SETTINGS.terminalCursorStyle).toBe("block");
  expect(DEFAULT_SETTINGS.terminalCursorBlink).toBe(true);
  expect(sanitizeSettings({}).terminalCursorStyle).toBe("block");
  expect(sanitizeSettings({}).terminalCursorBlink).toBe(true);
  expect(sanitizeSettings({ terminalCursorStyle: "bar" }).terminalCursorStyle).toBe("bar");
  expect(sanitizeSettings({ terminalCursorStyle: "underline" }).terminalCursorStyle).toBe("underline");
  // a value no shape answers for falls back, never breaking the UI on a stale or hand-edited record
  expect(sanitizeSettings({ terminalCursorStyle: "pipe" }).terminalCursorStyle).toBe("block");
  expect(sanitizeSettings({ terminalCursorBlink: false }).terminalCursorBlink).toBe(false);
  expect(sanitizeSettings({ terminalCursorBlink: "false" }).terminalCursorBlink).toBe(true);
});

it("keeps sidebar rows on two lines unless one line was chosen", () => {
  expect(sanitizeSettings({}).sidebarRows).toBe("two");
  expect(sanitizeSettings({ sidebarRows: "one" }).sidebarRows).toBe("one");
  for (const sidebarRows of [null, true, "three", 2]) {
    expect(sanitizeSettings({ sidebarRows }).sidebarRows).toBe("two");
  }
});

it("draws workspace cards in the Agents list only when they were turned on", () => {
  expect(DEFAULT_SETTINGS.agentCards).toBe(false);
  expect(sanitizeSettings({}).agentCards).toBe(false);
  expect(sanitizeSettings({ agentCards: true }).agentCards).toBe(true);
  for (const agentCards of [null, "true", 1]) {
    expect(sanitizeSettings({ agentCards }).agentCards).toBe(false);
  }
});

it("shows the Agents list's pin stars only when they were turned on", () => {
  expect(DEFAULT_SETTINGS.agentPins).toBe(false);
  expect(sanitizeSettings({}).agentPins).toBe(false);
  expect(sanitizeSettings({ agentPins: true }).agentPins).toBe(true);
  for (const agentPins of [null, "true", 1]) {
    expect(sanitizeSettings({ agentPins }).agentPins).toBe(false);
  }
});

it("draws agent logos in their brand colors unless Mono was chosen", () => {
  expect(DEFAULT_SETTINGS.agentMarks).toBe("color");
  expect(sanitizeSettings({}).agentMarks).toBe("color");
  expect(sanitizeSettings({ agentMarks: "mono" }).agentMarks).toBe("mono");
  for (const agentMarks of [null, "Mono", "off", 1]) {
    expect(sanitizeSettings({ agentMarks }).agentMarks).toBe("color");
  }
});

it("names the appearance settings changed from their defaults, and no other setting", () => {
  expect(changedSettings(DEFAULT_SETTINGS)).toEqual([]);
  expect(changedSettings({ ...DEFAULT_SETTINGS, agentPins: true, theme: "light", agentCards: true })).toEqual(["theme", "agentCards", "agentPins"]);
  // a setting the user types, or one outside the list, is never named
  expect(changedSettings({ ...DEFAULT_SETTINGS, terminalFontFamily: "D2Coding", terminalFontSize: 16, quietOpenedDone: true })).toEqual([]);
});

describe("clipboard from a pane", () => {
  it("is on in a fresh install", () => {
    expect(DEFAULT_SETTINGS.paneClipboard).toBe(true);
    expect(sanitizeSettings({}).paneClipboard).toBe(true);
  });

  it("turns on for a 0.4.1 record, whose false was saved with any other change", () => {
    const loaded = sanitizeSettings(JSON.parse(JSON.stringify({ theme: "light", terminalOsc52: false })));
    expect(loaded.paneClipboard).toBe(true);
    expect(loaded).not.toHaveProperty("terminalOsc52");
  });

  it("stays off once turned off, across a save and a reload", () => {
    const chosen = sanitizeSettings({ ...sanitizeSettings({ terminalOsc52: false }), paneClipboard: false });
    const reloaded = sanitizeSettings(JSON.parse(JSON.stringify(chosen)));
    expect(reloaded.paneClipboard).toBe(false);
    expect(sanitizeSettings({ ...reloaded, theme: "dark" }).paneClipboard).toBe(false);
    expect(sanitizeSettings({ paneClipboard: "false" }).paneClipboard).toBe(true);
  });
});

it("drops the folder grouping an older version stored", () => {
  expect(sanitizeSettings({ sidebarGrouping: "directory" })).not.toHaveProperty("sidebarGrouping");
});

describe("chat font size", () => {
  it("follows the density until one is chosen, and keeps a chosen one within bounds", () => {
    expect(chatFontSize(DEFAULT_SETTINGS)).toBe(14);
    expect(chatFontSize(sanitizeSettings({ density: "compact" }))).toBe(13);
    expect(chatFontSize(sanitizeSettings({ density: "compact", chatFontSize: 17 }))).toBe(17);
    expect(sanitizeSettings({ chatFontSize: 99 }).chatFontSize).toBe(CHAT_FONT_MAX);
    expect(sanitizeSettings({ chatFontSize: 2 }).chatFontSize).toBe(CHAT_FONT_MIN);
    expect(sanitizeSettings({ chatFontSize: 15.6 }).chatFontSize).toBe(16);
    expect(sanitizeSettings({ chatFontSize: "18" }).chatFontSize).toBeNull();
    expect(sanitizeSettings({ terminalFontSize: 15 }).chatFontSize).toBeNull();
  });

  it("sizes the message box too: with a mouse at the transcript's size, on touch never under --fs-input", () => {
    const css = readFileSync(join(import.meta.dir, "..", "components", "Composer.css"), "utf8");
    const sizes = [...css.matchAll(/\.composer-text \{[^}]*?font-size: ([^;]+);/g)].map((match) => match[1]);
    expect(sizes).toEqual([
      "max(var(--fs-input), calc(var(--fs-chat) * var(--chat-scale, 1)))",
      "calc(var(--fs-chat) * var(--chat-scale, 1))",
    ]);
  });
});

describe("chat width", () => {
  it("is the default lane until one is chosen, and accepts only the four steps", () => {
    expect(DEFAULT_SETTINGS.chatWidth).toBe("default");
    expect(sanitizeSettings({}).chatWidth).toBe("default");
    expect([...CHAT_WIDTHS]).toEqual(["narrow", "default", "wide", "full"]);
    for (const chatWidth of CHAT_WIDTHS) expect(sanitizeSettings({ chatWidth }).chatWidth).toBe(chatWidth);
    for (const chatWidth of [null, true, 960, "huge", "Wide", ["wide"]]) expect(sanitizeSettings({ chatWidth }).chatWidth).toBe("default");
  });

  it("has one lane token with an override per step, and the dialogs keep their own width", () => {
    const css = (name: string): string => readFileSync(join(import.meta.dir, "..", name), "utf8");
    const tokens = css("styles.css");
    expect(tokens).toContain("--content-w: 820px;");
    // unmeasured, the lane is the Default rule's floor; the measured one is chatLaneLength's
    expect(tokens).toContain("--chat-w: var(--content-w);");
    expect(tokens).toContain(`--content-w: ${CHAT_LANE_MIN}px;`);
    const step = (name: string): string | undefined => new RegExp(`\\[data-chat-width="${name}"\\] \\{\\s*--chat-w: ([^;]+);`).exec(tokens)?.[1];
    expect(step("narrow")).toBe("var(--content-w)");
    expect(step("wide")).toBe("72rem");
    expect(step("full")).toBe("100%");
    // the default step has no rule here: PaneTerminal writes its pane's lane on .terminal-stack, and a
    // file viewer, outside every pane, the lane of the pane that opened it on itself (lib/chatLane.ts)
    expect(step("default")).toBeUndefined();
    // a percentage in the token would resolve against each column's own box; Full is the one
    // step that means exactly that
    expect([...tokens.matchAll(/--chat-w: ([^;]+);/g)].map((match) => match[1]).filter((value) => value?.includes("%"))).toEqual(["100%"]);
    // one rule for both, so a change to it cannot miss the viewer
    expect(css("lib/chatLane.ts")).toContain(`setProperty("--chat-w", chatLaneLength(`);
    expect(css("components/PaneTerminal.tsx")).toContain("usePaneLane(stackRef)");
    expect(css("components/FileViewer.tsx")).toContain("useOpeningPaneLane(");
    for (const name of ["components/PaneTerminal.tsx", "components/FileViewer.tsx"]) expect(css(name)).not.toContain("chatLaneLength(");
    // the root font size is not read in JS: the ceiling is 60rem in the length itself
    expect(css("lib/chatLane.ts")).not.toContain("chatLaneWidth(");
    // Settings and New workspace stay on --content-w. That the chat columns share the lane is
    // measured in the browser (scripts/ui-regression.ts), not read from the stylesheets
    for (const file of ["components/SettingsDialog.css", "components/NewSessionDialog.css"]) {
      expect(css(file)).toContain("var(--content-w)");
      expect(css(file)).not.toContain("var(--chat-w)");
    }
  });
});

describe("the default chat lane", () => {
  it("is 71.43% of the pane, never under 820px or over 60rem (960px at a 16px root)", () => {
    expect(CHAT_LANE_MIN).toBe(820);
    expect(CHAT_LANE_MAX_REM).toBe(60);
    // the pane beside a 320px sidebar in a 1280, 1440, 1680 and 1920 window
    expect([960, 1120, 1360, 1600].map((pane) => chatLaneWidth(pane))).toEqual([820, 820, 960, 960]);
    // between the two ends it follows the pane, in whole px
    expect(chatLaneWidth(1148)).toBe(820);
    expect(chatLaneWidth(1149)).toBe(821);
    expect(chatLaneWidth(1200)).toBe(857);
    expect(chatLaneWidth(1300)).toBe(929);
    expect(chatLaneWidth(1343)).toBe(959);
    expect(chatLaneWidth(1344)).toBe(960);
  });

  it("is the floor for a phone, an unmeasured pane or a width that is not a number", () => {
    for (const width of [0, 390, 780, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(chatLaneWidth(width)).toBe(820);
  });

  it("has its ceiling in rem, so it is never wider than Wide's 72rem at a root font of 11.4px and up", () => {
    const wide = (root: number): number => 72 * root;
    // 16px: the sizes above, whether the root is passed or not
    expect([960, 1149, 1300, 1344, 1600, 4000].map((pane) => chatLaneWidth(pane, 16))).toEqual([820, 821, 929, 960, 960, 960]);
    // 20px: 60rem is 1200px, reached by a 1680px pane; Wide is 1440px
    expect([1148, 1344, 1600, 1679, 1680, 4000].map((pane) => chatLaneWidth(pane, 20))).toEqual([820, 960, 1143, 1199, 1200, 1200]);
    // 13px: 60rem is 780px, under the 820px floor. The floor wins: the lane is Narrow's at every
    // pane, and Wide (936px) is still the wider one. Before, a large pane got 960px here
    expect([960, 1149, 1344, 1600, 4000].map((pane) => chatLaneWidth(pane, 13))).toEqual([820, 820, 820, 820, 820]);
    // the two ends meet at 820 / 60 = 13.67px; a root just over it has a ceiling just over the floor
    expect(chatLaneWidth(4000, 14)).toBe(840);
    // a fractional root
    expect(chatLaneWidth(4000, 17.6)).toBe(1056);
    for (const root of [13, 14, 16, 17.6, 20, 24]) {
      for (const pane of [0, 960, 1344, 1920, 4000]) {
        const lane = chatLaneWidth(pane, root);
        expect(lane).toBeGreaterThanOrEqual(CHAT_LANE_MIN);
        expect(lane).toBeLessThanOrEqual(wide(root));
      }
    }
  });

  it("resolves the ceiling at 16px when the root font size is not a usable number", () => {
    for (const root of [0, -16, Number.NaN, Number.POSITIVE_INFINITY]) expect(chatLaneWidth(4000, root)).toBe(960);
  });

  it("is written as one length with the ceiling left in rem, so it follows the root font size without being measured again", () => {
    expect(chatLaneLength(1600)).toBe("min(max(820px, 60rem), 1143px)");
    expect(chatLaneLength(4000)).toBe("min(max(820px, 60rem), 2857px)");
    for (const pane of [0, 390, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(chatLaneLength(pane)).toBe("min(max(820px, 60rem), 820px)");
    // no percentage (each column would resolve it against its own box), and no root size baked in
    // as px: the only px in it are the floor and the pane's share
    const resolve = (length: string, root: number): number => {
      const match = /^min\(max\((\d+)px, (\d+)rem\), (\d+)px\)$/.exec(length);
      if (!match) throw new Error(`not the lane's form: ${length}`);
      return Math.min(Math.max(Number(match[1]), Number(match[2]) * root), Number(match[3]));
    };
    // one length, written once at a 16px root, is right at every other root: a font size changed
    // while the tab is open needs no new measurement. A px ceiling written at 16px stayed 960px
    // at 13px, wider than Wide's 936px, until the pane was next resized
    const written = chatLaneLength(4000);
    expect([13, 14, 16, 17.6, 20].map((root) => resolve(written, root))).toEqual([820, 840, 960, 1056, 1200]);
    for (const root of [13, 14, 16, 17.6, 20, 24]) {
      for (const pane of [0, 960, 1149, 1344, 1600, 1920, 4000]) {
        expect(resolve(chatLaneLength(pane), root)).toBe(chatLaneWidth(pane, root));
        expect(resolve(chatLaneLength(pane), root)).toBeLessThanOrEqual(72 * root);
      }
    }
  });
});

describe("font families", () => {
  const family = (value: unknown): string => sanitizeSettings({ terminalFontFamily: value }).terminalFontFamily;

  it("keep today's fonts until a list is typed, and ignore anything that is not text", () => {
    expect(DEFAULT_SETTINGS.terminalFontFamily).toBe("");
    expect(DEFAULT_SETTINGS.chatFontFamily).toBe("");
    expect(sanitizeSettings({}).terminalFontFamily).toBe("");
    expect(sanitizeSettings({}).chatFontFamily).toBe("");
    for (const value of [undefined, null, 7, true, ["D2Coding"], { name: "D2Coding" }]) expect(family(value)).toBe("");
    expect(family("")).toBe("");
    expect(family("   ")).toBe("");
    expect(family(" , ,, ")).toBe("");
  });

  it("trim each name, drop empty ones and join them the CSS way", () => {
    expect(family("  D2Coding  ")).toBe("D2Coding");
    expect(family("D2Coding,,  , monospace,")).toBe("D2Coding, monospace");
    expect(family(",D2Coding")).toBe("D2Coding");
  });

  it("quote names with spaces once, and keep quoted names quoted", () => {
    expect(family("Cascadia Mono")).toBe('"Cascadia Mono"');
    expect(family("  Cascadia    Mono  ")).toBe('"Cascadia Mono"');
    expect(family('D2Coding, "Cascadia Mono", monospace')).toBe('D2Coding, "Cascadia Mono", monospace');
    expect(family("'Cascadia Mono'")).toBe('"Cascadia Mono"');
    expect(family('" Cascadia Mono "')).toBe('"Cascadia Mono"');
    // quoted, a generic name is a font by that name: the user's quotes stay
    expect(family('"monospace"')).toBe('"monospace"');
    // a stray or unbalanced quote cannot end the CSS string early
    expect(family('Cascadia"Mono')).toBe("CascadiaMono");
    expect(family('"Cascadia Mono')).toBe('"Cascadia Mono"');
    expect(family('""')).toBe("");
  });

  it("quote what CSS cannot read bare", () => {
    expect(family("3270 Nerd Font")).toBe('"3270 Nerd Font"');
    expect(family("1942report")).toBe('"1942report"');
    expect(family("inherit, D2Coding")).toBe('"inherit", D2Coding');
    expect(family("나눔고딕코딩")).toBe("나눔고딕코딩");
    expect(family("Sarasa-Mono-K")).toBe("Sarasa-Mono-K");
  });

  it("compose a decomposed name, so it matches the installed font", () => {
    const decomposed = "나눔고딕코딩".normalize("NFD");
    expect(decomposed).not.toBe("나눔고딕코딩");
    expect(family(decomposed)).toBe("나눔고딕코딩");
    expect(family(`D2Coding, ${"나눔 고딕".normalize("NFD")}`)).toBe('D2Coding, "나눔 고딕"');
  });

  it("strip what could leave the declaration", () => {
    expect(family("D2Coding; color: red")).toBe('"D2Coding color: red"');
    expect(family("D2Coding} body { color: red")).toBe('"D2Coding body color: red"');
    expect(family("</style><script>x</script>")).toBe('"/stylescriptx/script"');
    expect(family("D2\\Coding")).toBe("D2Coding");
    expect(family("D2\u0000Coding\nMono\t")).toBe("D2CodingMono");
    for (const unsafe of [";", "{", "}", "<", ">", "\\", "\u0000", "\u001f", "\u007f"]) expect(family(`x${unsafe}y`)).toBe("xy");
  });

  it("stay within the length limit, dropping whole names past it", () => {
    const long = Array.from({ length: 40 }, (_, index) => `Font Name ${index}`).join(", ");
    const kept = family(long);
    expect(kept.length).toBeLessThanOrEqual(FONT_FAMILY_MAX_CHARS);
    expect(kept.startsWith('"Font Name 0", "Font Name 1"')).toBe(true);
    // every name that made it is whole: its quotes pair up
    expect(kept.split(", ").every((name) => /^"Font Name \d+"$/.test(name))).toBe(true);
    expect(family("x".repeat(FONT_FAMILY_MAX_CHARS + 1))).toBe("");
    expect(family("x".repeat(FONT_FAMILY_MAX_CHARS))).toBe("x".repeat(FONT_FAMILY_MAX_CHARS));
  });

  it("are the same list after a second pass, so a saved one never drifts", () => {
    for (const typed of ['D2Coding, "Cascadia Mono", monospace', "'Fira Code' ,  Menlo", "inherit, 3270 Nerd Font"]) {
      const once = family(typed);
      expect(family(once)).toBe(once);
    }
  });

  it("sanitize the chat's list the same way, apart from the terminal's", () => {
    const both = sanitizeSettings({ terminalFontFamily: "D2Coding", chatFontFamily: " Pretendard ; , Noto Sans KR" });
    expect(both.terminalFontFamily).toBe("D2Coding");
    expect(both.chatFontFamily).toBe('Pretendard, "Noto Sans KR"');
  });
});

describe("alert choices", () => {
  it("keep alerts on unless this device turned them off with the bell", () => {
    expect(DEFAULT_SETTINGS.alertsOn).toBe(true);
    expect(sanitizeSettings({}).alertsOn).toBe(true);
    expect(sanitizeSettings({ alertsOn: false }).alertsOn).toBe(false);
    expect(sanitizeSettings({ alertsOn: "no" }).alertsOn).toBe(true);
  });

  it("keep the alert sound off until this device chooses it", () => {
    expect(DEFAULT_SETTINGS.alertSound).toBe(false);
    expect(sanitizeSettings({ alertSound: true }).alertSound).toBe(true);
    expect(sanitizeSettings({ alertSound: "yes" }).alertSound).toBe(false);
  });

  it("default to questions and long turns, and drop anything unknown to the default", () => {
    expect(alertPrefs(DEFAULT_SETTINGS)).toEqual({ input: true, done: "long" });
    expect(alertPrefs(sanitizeSettings({ alertInput: false, alertDone: "always" }))).toEqual({ input: false, done: "always" });
    expect(alertPrefs(sanitizeSettings({ alertInput: "no", alertDone: "sometimes" }))).toEqual({ input: true, done: "long" });
  });
});

describe("quick replies", () => {
  it("keep replies as typed, bounded, and show only the ones with something to send", () => {
    expect(quickReplyButtons(DEFAULT_SETTINGS)).toEqual(["continue", "yes", "no", "commit and push", "retry"]);
    // a trailing space is the next word being typed: it stays
    const typed = sanitizeSettings({ quickReplies: ["run the ", "", "  ", 7, "ship it"] });
    expect(typed.quickReplies).toEqual(["run the ", "", "  ", "ship it"]);
    expect(quickReplyButtons(typed)).toEqual(["run the ", "ship it"]);
    const many = sanitizeSettings({ quickReplies: Array.from({ length: 20 }, (_, index) => "x".repeat(300) + index) });
    expect(many.quickReplies).toHaveLength(QUICK_REPLIES_MAX);
    expect(many.quickReplies.every((reply) => reply.length === QUICK_REPLY_MAX_CHARS)).toBe(true);
    // an emptied list is a choice, not a broken record
    expect(sanitizeSettings({ quickReplies: [] }).quickReplies).toEqual([]);
    expect(sanitizeSettings({}).quickReplies).toEqual(DEFAULT_SETTINGS.quickReplies);
  });
});

describe("microphone button", () => {
  it("is automatic until chosen, and reads a record from before it had three places", () => {
    expect(DEFAULT_SETTINGS.voiceInput).toBe("auto");
    expect(sanitizeSettings({}).voiceInput).toBe("auto");
    for (const voiceInput of VOICE_BUTTONS) expect(sanitizeSettings({ voiceInput }).voiceInput).toBe(voiceInput);
    // the old toggle: on was a choice, off was also what an untouched device stored
    expect(sanitizeSettings({ voiceInput: true }).voiceInput).toBe("on");
    expect(sanitizeSettings({ voiceInput: false }).voiceInput).toBe("auto");
    for (const voiceInput of [null, 1, "yes", "ON"]) expect(sanitizeSettings({ voiceInput }).voiceInput).toBe("auto");
  });

  it("listens for the browser's language until another is chosen from the list", () => {
    expect(DEFAULT_SETTINGS.voiceLanguage).toBe("auto");
    expect(sanitizeSettings({}).voiceLanguage).toBe("auto");
    for (const voiceLanguage of DICTATION_LANGUAGES) expect(sanitizeSettings({ voiceLanguage }).voiceLanguage).toBe(voiceLanguage);
    for (const voiceLanguage of [null, 1, "", "hu", "hu-hu", "xx-XX", "auto "]) expect(sanitizeSettings({ voiceLanguage }).voiceLanguage).toBe("auto");
  });

  it("is asked for in the chat off a phone on auto, everywhere when on and nowhere when off", () => {
    expect(wantsVoiceInput("auto", "chat", false)).toBe(true);
    expect(wantsVoiceInput("auto", "chat", true)).toBe(false);
    expect(wantsVoiceInput("auto", "terminal", false)).toBe(false);
    for (const mode of ["chat", "terminal"] as const) {
      for (const phone of [false, true]) {
        expect(wantsVoiceInput("on", mode, phone)).toBe(true);
        expect(wantsVoiceInput("off", mode, phone)).toBe(false);
      }
    }
  });
});

describe("suggestion chip", () => {
  it("stays on until turned off in settings", () => {
    expect(DEFAULT_SETTINGS.showSuggestionChip).toBe(true);
    expect(sanitizeSettings({}).showSuggestionChip).toBe(true);
    expect(sanitizeSettings({ showSuggestionChip: false }).showSuggestionChip).toBe(false);
    expect(sanitizeSettings({ showSuggestionChip: "no" }).showSuggestionChip).toBe(true);
  });
});

describe("quick replies row", () => {
  it("stays hidden until chosen in settings", () => {
    expect(DEFAULT_SETTINGS.showQuickReplies).toBe(false);
    expect(sanitizeSettings({ showQuickReplies: true }).showQuickReplies).toBe(true);
    expect(sanitizeSettings({ showQuickReplies: "yes" }).showQuickReplies).toBe(false);
    expect(DEFAULT_SETTINGS.showUsage).toBe(false);
    expect(sanitizeSettings({ showUsage: true }).showUsage).toBe(true);
    expect(sanitizeSettings({ showUsage: 1 }).showUsage).toBe(false);
    expect(DEFAULT_SETTINGS.usageCount).toBe("used");
    // the pace is shown only once chosen
    expect(DEFAULT_SETTINGS.usagePace).toBe(false);
    expect(sanitizeSettings({ usagePace: true }).usagePace).toBe(true);
    expect(sanitizeSettings({ usagePace: "yes" }).usagePace).toBe(false);
    expect(sanitizeSettings({ usageCount: "left" }).usageCount).toBe("left");
    expect(sanitizeSettings({ usageCount: "half" }).usageCount).toBe("used");
    expect(DEFAULT_SETTINGS.usageGlance).toBe("week");
    expect(sanitizeSettings({ usageGlance: "session" }).usageGlance).toBe("session");
    expect(sanitizeSettings({ usageGlance: "nearest" }).usageGlance).toBe("week");
    expect(sanitizeSettings({ usageOrder: ["codex:a", 3, "codex:a", "", "claude:b"] }).usageOrder).toEqual(["codex:a", "claude:b"]);
    expect(sanitizeSettings({ usageHidden: Array.from({ length: 100 }, (_, index) => `k${index}`) }).usageHidden).toHaveLength(64);
    expect(sanitizeSettings({ usageHidden: "codex:a" }).usageHidden).toEqual([]);
  });
});

describe("palette", () => {
  it("defaults to amber, the look before this setting, and keeps only a known palette", () => {
    expect(DEFAULT_SETTINGS.palette).toBe("amber");
    // settings stored before palettes existed carry no palette key
    expect(sanitizeSettings({ theme: "light" }).palette).toBe("amber");
    expect(sanitizeSettings({ palette: "report" }).palette).toBe("report");
    expect(sanitizeSettings({ palette: "charcoal" }).palette).toBe("charcoal");
    expect(sanitizeSettings({ palette: "catppuccin" }).palette).toBe("catppuccin");
    expect(sanitizeSettings({ palette: "lilac" }).palette).toBe("lilac");
    expect(sanitizeSettings({ palette: "forest" }).palette).toBe("forest");
    expect(sanitizeSettings({ palette: "pink" }).palette).toBe("amber");
  });

  it("preserves Forest through a saved settings round-trip and unrelated edits", () => {
    const saved = sanitizeSettings({ palette: "forest", theme: "dark" });
    const reloaded = sanitizeSettings(JSON.parse(JSON.stringify(saved)));
    expect(reloaded.palette).toBe("forest");
    expect(sanitizeSettings({ ...reloaded, theme: "light" }).palette).toBe("forest");
  });

  const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };
  const paper = '[data-theme="light"]:is([data-palette="report"], [data-palette="charcoal"])';
  // each case lists its blocks from the most specific to the base; the first one naming a token wins
  const cases = [
    { theme: "dark", palette: "amber", layers: [":root"] },
    { theme: "light", palette: "amber", layers: ['[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "report", layers: ['[data-theme="dark"][data-palette="report"]', ":root"] },
    { theme: "light", palette: "report", layers: [paper, '[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "charcoal", layers: ['[data-theme="dark"][data-palette="charcoal"]', ":root"] },
    { theme: "light", palette: "charcoal", layers: ['[data-theme="light"][data-palette="charcoal"]', paper, '[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "catppuccin", layers: ['[data-theme="dark"][data-palette="catppuccin"]', ":root"] },
    { theme: "light", palette: "catppuccin", layers: ['[data-theme="light"][data-palette="catppuccin"]', '[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "lilac", layers: ['[data-theme="dark"][data-palette="lilac"]', ":root"] },
    { theme: "light", palette: "lilac", layers: ['[data-theme="light"][data-palette="lilac"]', '[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "forest", layers: ['[data-theme="dark"][data-palette="forest"]', ":root"] },
    { theme: "light", palette: "forest", layers: ['[data-theme="light"][data-palette="forest"]', '[data-theme="light"]', ":root"] },
  ] as const;
  const tokens = (layers: readonly string[]) => (name: string): string =>
    layers.map((selector) => block(selector).match(new RegExp(`--${name}: ([^;]+);`))?.[1]).find((value) => value !== undefined)!;

  it("mirrors each palette's --term-* tokens of styles.css for xterm", () => {
    for (const { theme, palette, layers } of cases) {
      const read = tokens(layers);
      expect(terminalTheme(theme, palette)).toEqual({ background: read("term-bg"), foreground: read("term-fg"), cursor: read("term-cursor"), selectionBackground: read("term-selection") });
    }
  });

  it("keeps text and agent states readable (WCAG AA 4.5:1) on every surface of every palette", () => {
    type Rgb = [number, number, number];
    const rgba = (value: string): [Rgb, number] => {
      const hex = value.match(/^#([0-9a-f]{6})$/);
      if (hex) return [[0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb, 1];
      const parts = value.match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/)!;
      return [[Number(parts[1]), Number(parts[2]), Number(parts[3])], Number(parts[4])];
    };
    const over = (top: string, under: Rgb): Rgb => {
      const [rgb, alpha] = rgba(top);
      return rgb.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as Rgb;
    };
    const luminance = (rgb: Rgb): number => {
      const [r, g, b] = rgb.map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)) as Rgb;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: Rgb, b: Rgb): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const failures: string[] = [];
    for (const { theme, palette, layers } of cases) {
      const read = tokens(layers);
      const color = (name: string): Rgb => rgba(read(name))[0];
      for (const surface of ["bg", "bg-panel", "bg-elevated", "bg-hover"]) {
        for (const text of ["text", "text-dim"]) {
          if (ratio(color(text), color(surface)) < 4.5) failures.push(`${theme}/${palette} ${text} on ${surface}`);
        }
        // a status badge: its color on its tint, over a (hovered or selected) row
        for (const state of ["working", "blocked", "done"]) {
          const backdrop = over(read(`status-${state}-tint`), color(surface));
          if (ratio(color(`status-${state}`), backdrop) < 4.5) failures.push(`${theme}/${palette} ${state} badge on ${surface}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("paints amber before settings load: the base blocks are the default palette's", () => {
    const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    expect(root).toContain(`--term-bg: ${terminalTheme("dark").background};`);
    expect(root).toContain(`--term-cursor: ${terminalTheme("dark").cursor};`);
    expect(terminalTheme("dark")).toEqual(terminalTheme("dark", "amber"));
  });
});

describe("agent marks", () => {
  it("drops the icon choice 0.3.36 stored, so every pane shows its provider logo", () => {
    const settings = sanitizeSettings({ claudeMark: "mascot", codexMark: "app" });
    expect(settings).not.toHaveProperty("claudeMark");
    expect(settings).not.toHaveProperty("codexMark");
  });
});

it("sanitizes input modes and shortcut overrides without accepting arbitrary commands", () => {
  expect(sanitizeSettings({ terminalInputMode: "bad" }).terminalInputMode).toBe("auto");
  expect(sanitizeSettings({ terminalInputMode: "line" }).terminalInputMode).toBe("line");
  expect(sanitizeSettings({ shortcutOverrides: { palette: "p", settings: null, voice: "x", unknown: "x", "next-pane": "rm -rf" } }).shortcutOverrides).toEqual({ palette: "p", settings: null });
});

describe("key bar settings", () => {
  it("uses the new default for fresh partial records and migrates explicit legacy records", () => {
    expect(DEFAULT_SETTINGS.keyBarItems).toEqual(DEFAULT_KEY_BAR_ITEMS);
    expect(sanitizeSettings({}).keyBarItems).toEqual(DEFAULT_KEY_BAR_ITEMS);
    expect(sanitizeSettings({ theme: "light" }).keyBarItems).toEqual(DEFAULT_KEY_BAR_ITEMS);
    expect(sanitizeSettings({ keyBarExtras: ["alt"] }).keyBarItems).toEqual(migrateKeyBarItems(["alt"]));
    expect(sanitizeSettings({ keyBarExtras: ["home-end", "slash", "unknown"] }).keyBarItems).toEqual(migrateKeyBarItems(["home-end", "slash"]));
    expect(sanitizeSettings({ keyBarExtras: [], keyBarItems: [] }).keyBarItems).toEqual([]);
    expect(sanitizeSettings({ keyBarExtras: ["alt"], keyBarItems: [] }).keyBarItems).toEqual([]);
    expect(sanitizeSettings({ keyBarExtras: [], keyBarItems: "bad" }).keyBarItems).toEqual(migrateKeyBarItems([]));
  });

  it("preserves a custom chord and new order through a saved settings round-trip and unrelated edits", () => {
    const settings = sanitizeSettings({ keyBarExtras: ["alt"], keyBarItems: [
      { type: "key", key: "ArrowLeft", modifiers: { ctrl: true, alt: true, shift: false } },
      { type: "modifier", modifier: "shift" }, { type: "key", key: "Enter" },
    ] });
    const reloaded = sanitizeSettings(JSON.parse(JSON.stringify(settings)));
    expect(reloaded.keyBarItems).toEqual(settings.keyBarItems);
    expect(sanitizeSettings({ ...reloaded, theme: "light" }).keyBarItems).toEqual(settings.keyBarItems);
    expect(settings.keyBarItems.map((item) => item.type === "modifier" ? item.modifier : item.key)).toEqual(["ArrowLeft", "shift", "Enter"]);
  });
});

describe("default lens", () => {
  it("keeps only a known choice, auto by default", () => {
    expect(DEFAULT_SETTINGS.defaultView).toBe("auto");
    expect(sanitizeSettings({ defaultView: "chat" }).defaultView).toBe("chat");
    expect(sanitizeSettings({ defaultView: "split" }).defaultView).toBe("auto");
  });
  it("forgets every pane's own lens and nothing else", () => {
    const data = new Map<string, string>([["herdr-web-ui:view:local:w1:p1", "terminal"], ["herdr-web-ui:view:remote:pc:w2:p1", "chat"], ["herdr-web-ui:settings", "{}"]]);
    const storage = { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, removeItem: (k: string) => { data.delete(k); } };
    expect(forgetPaneViews(storage)).toBe(2);
    expect([...data.keys()]).toEqual(["herdr-web-ui:settings"]);
  });
});

it("highlights code unless turned off, and keeps a stored choice only when it is a boolean", () => {
  expect(DEFAULT_SETTINGS.highlightCode).toBe(true);
  expect(sanitizeSettings({ highlightCode: false }).highlightCode).toBe(false);
  expect(sanitizeSettings({ highlightCode: "no" }).highlightCode).toBe(true);
  expect(sanitizeSettings({}).highlightCode).toBe(true);
});

it("keeps the file viewer's wrap setting only when it is a boolean", () => {
  expect(DEFAULT_SETTINGS.wrapCode).toBe(false);
  expect(sanitizeSettings({ wrapCode: true }).wrapCode).toBe(true);
  expect(sanitizeSettings({ wrapCode: "yes" }).wrapCode).toBe(false);
});

it("keeps the Markdown preview's width to readable or full, readable by default", () => {
  expect(DEFAULT_SETTINGS.markdownWidth).toBe("readable");
  for (const width of MARKDOWN_WIDTHS) expect(sanitizeSettings({ markdownWidth: width }).markdownWidth).toBe(width);
  for (const bad of ["narrow", "medium", "wide", "", null, 80]) expect(sanitizeSettings({ markdownWidth: bad }).markdownWidth).toBe("readable");
});

describe("shared settings", () => {
  it("shares exactly the settings SETTING_SCOPE marks shared", () => {
    const shared = Object.entries(SETTING_SCOPE).filter(([, scope]) => scope === "shared").map(([key]) => key).sort();
    expect([...SHARED_SETTING_KEYS].sort() as string[]).toEqual(shared);
    expect(Object.keys(SETTING_SCOPE).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});
