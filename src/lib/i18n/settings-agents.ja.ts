/**
 * Japanese for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.ja.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.ja.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_JA: Record<string, string> = {
  "Read OpenCode subagent ends from their session (experimental)": "OpenCode のサブエージェントの終了をセッションの記録で判断（実験的）",
  "An OpenCode subagent counts as running, and holds its turn's BG wait, until the session that started it is told it ended, not as soon as the subagent goes idle. Its own background work may still run then. When off, the subagent's own rows tell.": "OpenCode のサブエージェントは、アイドルになった時点ではなく、それを始めたセッションに終了が伝えられるまで実行中として数え、そのターンの BG 待機も保ちます。そのとき、サブエージェント自身のバックグラウンド作業はまだ動いていることがあります。オフのときは、サブエージェント自身の記録で判断します。",
};
