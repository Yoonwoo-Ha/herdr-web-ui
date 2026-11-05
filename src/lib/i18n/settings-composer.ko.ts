/**
 * Korean for the settings keys of Settings → Chat → Composer's optional buttons and chips: the rest of the
 * settings part (./settings.ko.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_KO: Record<string, string> = {
  "New tab button": "새 탭 버튼",
  "A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.": "입력창의 버튼으로 이 패널의 워크스페이스에 에이전트와 함께 새 탭…을 엽니다. 탭 메뉴에서는 언제든 열 수 있습니다.",
  "Artifacts chip": "아티팩트 칩",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "Claude Code 패널의 입력창에 세션이 Artifact 도구로 게시한 페이지 목록을 여는 칩을 표시합니다.",
  "Side conversations chip (experimental)": "곁가지 대화 칩 (실험적)",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "OMP 패널의 입력창에 세션이 /btw로 저장한 곁가지 대화 목록을 여는 칩을 표시합니다.",
  "Paste and send button": "붙여넣고 보내기 버튼",
  "A button in the empty message box sends the text copied on this device as a message.": "빈 입력창의 버튼으로 이 기기에서 복사한 글을 메시지로 보냅니다.",
};
