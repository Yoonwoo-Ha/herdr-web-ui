/**
 * Korean for the settings keys of Settings → Chat → Composer's optional buttons and chips, of Settings → Chat → Compaction and failed requests, of Settings → Terminal → Split into rows and columns, and of Settings → Appearance → Background workspaces apart: the rest of the
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
  "Split into rows and columns": "행과 열로 나누기",
  "Drop a pane on the edge of another in the split view to open it beside, above or below that pane, up to four at once, and drag the line between two panes to resize them. Off: the split view keeps two halves side by side.": "분할 보기에서 패널을 다른 패널의 가장자리에 놓으면 그 패널의 옆, 위, 아래에 열립니다. 한 번에 넷까지 열 수 있고, 두 패널 사이의 선을 끌어 크기를 바꿉니다. 끄면 분할 보기는 좌우 두 칸으로 나뉩니다.",
  "Compaction and failed requests": "압축과 실패한 요청",
  "On this device, a compaction names the token counts the agent recorded with it, and each run of back-to-back failed requests shows as one row that opens to their errors. OmO, omp and pi record them.": "이 기기에서 대화 압축에 에이전트가 함께 기록한 토큰 수를 보여 주고, 연달아 실패한 요청을 한 줄로 묶어 열면 오류를 볼 수 있게 합니다. OmO, omp, pi가 기록합니다.",
  "Background workspaces apart": "백그라운드 워크스페이스 따로 두기",
  "On this device, workspaces a tool tagged role=background (herdr workspace report-metadata --token role=background) stand after the others under a folded Background workspaces heading. The open one, and one whose agent asks a question, stay in sight.": "이 기기에서, 도구가 role=background 태그를 단 워크스페이스(herdr workspace report-metadata --token role=background)를 다른 워크스페이스 뒤의 접힌 백그라운드 워크스페이스 머리글 아래에 둡니다. 열려 있는 워크스페이스와 에이전트가 질문 중인 워크스페이스는 계속 보입니다.",
};
