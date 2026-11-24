/**
 * Korean for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.ko.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.ko.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_KO: Record<string, string> = {
  "OpenCode: subagent ends from their session": "OpenCode 완료 확인을 상위 세션에서 받기",
  "OMP on macOS herdr-core: chat from the session it holds open": "OMP (macOS herdr-core): 열어 둔 세션에서 채팅 읽기",
  "Notes kept for your agents. Agents do not get them yet; later they get only notes you confirmed.": "에이전트에게 줄 메모를 모아 둡니다. 아직 에이전트에게 넣지 않으며, 나중에 확인한 메모만 넣습니다.",
  "notes remember agents confirm": "메모 기억 에이전트 확인",
};
