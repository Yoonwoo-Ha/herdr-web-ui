/**
 * Chinese for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.zh.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.zh.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_ZH: Record<string, string> = {
  "OpenCode: subagent ends from their session": "OpenCode：从父会话读取子代理结束",
  "OMP on macOS herdr-core: chat from the session it holds open": "OMP（macOS 上的 herdr-core）：从打开的会话读取聊天",
  "Notes kept for your agents. Agents do not get them yet; later they get only notes you confirmed.": "为代理保存的笔记。目前还不会交给代理，以后只提供你确认过的笔记。",
  "notes remember agents confirm": "笔记 记住 代理 确认",
};
