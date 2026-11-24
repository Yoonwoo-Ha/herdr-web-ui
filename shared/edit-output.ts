import type { ConversationPart } from "./protocol.ts";

type Tool = Extract<ConversationPart, { kind: "tool" }>;

/** The text representation understood by clients predating structured file edits. */
export const legacyEditText = (edits: Tool["edits"]): string =>
  edits?.map(edit => `--- ${edit.path}\n${edit.before}\n+++ ${edit.path}\n${edit.after}`).join("\n") ?? "";
