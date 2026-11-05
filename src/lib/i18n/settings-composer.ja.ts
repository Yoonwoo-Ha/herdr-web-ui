/**
 * Japanese for the settings keys of Settings → Chat → Composer's optional buttons and chips: the rest of the
 * settings part (./settings.ja.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_JA: Record<string, string> = {
  "New tab button": "新しいタブボタン",
  "A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.": "入力欄のボタンで、このペインのワークスペースに「エージェント付きの新しいタブ…」を開きます。タブメニューからはいつでも開けます。",
  "Artifacts chip": "アーティファクトチップ",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "Claude Code のペインの入力欄に、セッションが Artifact ツールで公開したページの一覧を出すチップを表示します。",
  "Side conversations chip (experimental)": "サイド会話チップ（実験的）",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "OMP ペインの入力欄に、セッションが /btw で保存したサイド会話の一覧を開くチップを表示します。",
  "Paste and send button": "貼り付けて送信ボタン",
  "A button in the empty message box sends the text copied on this device as a message.": "空の入力欄のボタンで、このデバイスでコピーしたテキストをメッセージとして送ります。",
};
