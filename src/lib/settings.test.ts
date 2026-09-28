import { describe, expect, it } from "bun:test";

import { alertPrefs, CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, DEFAULT_SETTINGS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, quickReplyButtons, sanitizeSettings } from "./settings.ts";

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
});

describe("alert choices", () => {
  it("keep alerts on unless this device turned them off with the bell", () => {
    expect(DEFAULT_SETTINGS.alertsOn).toBe(true);
    expect(sanitizeSettings({}).alertsOn).toBe(true);
    expect(sanitizeSettings({ alertsOn: false }).alertsOn).toBe(false);
    expect(sanitizeSettings({ alertsOn: "no" }).alertsOn).toBe(true);
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

describe("quick replies row", () => {
  it("stays hidden until chosen in settings", () => {
    expect(DEFAULT_SETTINGS.showQuickReplies).toBe(false);
    expect(sanitizeSettings({ showQuickReplies: true }).showQuickReplies).toBe(true);
    expect(sanitizeSettings({ showQuickReplies: "yes" }).showQuickReplies).toBe(false);
  });
});
