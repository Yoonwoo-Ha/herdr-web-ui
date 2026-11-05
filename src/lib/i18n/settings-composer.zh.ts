/**
 * Chinese for the settings keys of Settings → Chat → Composer's optional buttons and chips: the rest of the
 * settings part (./settings.zh.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_ZH: Record<string, string> = {
  "New tab button": "新标签页按钮",
  "A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.": "输入框中的按钮可在该面板的工作区打开“带代理的新标签页…”。标签页菜单中始终可用。",
  "Artifacts chip": "Artifact 标签",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "在 Claude Code 面板的输入框中显示一个标签，列出该会话用 Artifact 工具发布的页面。",
  "Side conversations chip (experimental)": "旁支对话标签（实验性）",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "在 OMP 窗格的输入框中显示一个标签，列出该会话用 /btw 保存的旁支对话。",
  "Paste and send button": "粘贴并发送按钮",
  "A button in the empty message box sends the text copied on this device as a message.": "空输入框中的按钮会把在此设备上复制的文本作为消息发送。",
};
