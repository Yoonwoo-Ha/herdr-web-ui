import { createHash } from "node:crypto";
import { legacyEditText } from "../../shared/edit-output.ts";
import type { ConversationPart, ConversationTurn, SkillActivity } from "../../shared/protocol.ts";
import { inlineImageType } from "../codex-images.ts";
import { skillDocument } from "../skill-activity.ts";
import { grokPromptSkill } from "../skill-invocations/grok.ts";
import { toolSummary } from "../transcript-records.ts";
import { trimOutput } from "../tool-output.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const hash = (value: string): string => createHash("sha256").update(value).digest("base64url");
export const digestOf = (data: string): string => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
export interface UpdateEvent { update: RecordValue; ts: string | null }
export interface Picture { mediaType: string; data: string }
interface ProjectionOptions {
  keeper?: boolean;
  wholeCall?: string;
  imageRef(picture: Picture): string;
  outputRef(id: string, output: string): string;
}
export class UpdateUnavailable extends Error {
  constructor() { super("Grok history cannot be reconstructed"); this.name = "GrokUnavailable"; }
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = record(item);
    const content = record(block.content);
    if (block.type === "content" && content.type === "text" && typeof content.text === "string") return content.text;
    // This is a native reference, not terminal output we have fetched via ACP.
    if (block.type === "terminal" && typeof block.terminalId === "string") return JSON.stringify(block);
    return "";
  }).filter(Boolean).join("\n");
}

/** The pictures `blocks` carry that the chat shows: a raster declared as one, within MAX_IMAGE_BYTES (inlineImageType). */
function pictures(blocks: unknown[]): { mediaType: string; data: string }[] {
  return blocks.flatMap((block) => {
    const image = record(block);
    if (image.type !== "image" || typeof image.data !== "string") return [];
    const mediaType = inlineImageType(image.mimeType, image.data);
    return mediaType === null ? [] : [{ mediaType, data: image.data }];
  });
}

/** The pictures one update carries: a visible prompt chunk's, or a tool update's content blocks'. */
export function updatePictures(u: RecordValue): { mediaType: string; data: string }[] {
  if (u.sessionUpdate === "user_message_chunk") return record(u._meta).hideFromScrollback === true ? [] : pictures([u.content]);
  if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update" || !Array.isArray(u.content)) return [];
  return pictures(u.content.flatMap((block) => record(block).type === "content" ? [record(block).content] : []));
}

type Tool = Extract<ConversationPart, { kind: "tool" }>;
export function projectUpdates(events: Iterable<UpdateEvent | null>, options: ProjectionOptions): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let user: ConversationTurn | undefined;
  let assistant: ConversationTurn | undefined;
  let prompt: number | undefined;
  const calls = new Map<string, { fields: RecordValue; part: Tool; diffs: Map<string, NonNullable<Tool["edits"]>[number]> }>();
  const promptSkills = new Map<ConversationTurn, SkillActivity>();
  const appendText = (turn: ConversationTurn, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    const last = turn.parts.at(-1);
    if (last?.kind === "text") last.text += value; else turn.parts.push({ kind: "text", text: value });
  };
  for (const event of events) {
    if (!event) continue;
    const u = event.update;
    const meta = record(u._meta);
    if (u.sessionUpdate === "rewind_marker") throw new UpdateUnavailable();
    if (u.sessionUpdate === "turn_completed") {
      const last = assistant?.parts.at(-1);
      if (last?.kind === "text") last.phase = "final_answer";
      assistant = undefined; continue;
    }
    if (u.sessionUpdate === "user_message_chunk") {
      const index = options.keeper ? 0 : meta.promptIndex;
      if (typeof index !== "number" || !Number.isSafeInteger(index)) throw new UpdateUnavailable();
      if (!user || prompt !== index) {
        prompt = index;
        user = { role: "user", ts: event.ts, parts: [] };
        assistant = undefined; calls.clear(); turns.push(user);
      }
      if (meta.hideFromScrollback !== true) {
        appendText(user, record(u.content).text);
        const skill = options.keeper ? null : grokPromptSkill(u.content);
        if (skill) promptSkills.set(user, skill);
      }
      for (const picture of updatePictures(u)) user.parts.push({ kind: "image", media_type: picture.mediaType, ref: options.imageRef(picture) });
      continue;
    }
    const plan = options.keeper && u.sessionUpdate === "plan" && Array.isArray(u.entries);
    const thought = options.keeper && u.sessionUpdate === "agent_thought_chunk";
    if (!plan && !thought && (typeof u.sessionUpdate !== "string" || !["agent_message_chunk", "tool_call", "tool_call_update"].includes(u.sessionUpdate))) continue;
    if (prompt === undefined && !options.keeper) throw new UpdateUnavailable();
    if (!assistant) { assistant = { role: "assistant", ts: event.ts, parts: [] }; turns.push(assistant); }
    if (event.ts !== null) assistant.end_ts = event.ts;
    if (plan) {
      assistant.parts.push({ kind: "tool", name: "plan", summary: "", input: JSON.stringify({ todos: u.entries }), output: "" });
      continue;
    }
    if (thought) {
      const value = record(u.content).text;
      if (typeof value === "string" && value) {
        const last = assistant.parts.at(-1);
        if (last?.kind === "thinking") last.text += value; else assistant.parts.push({ kind: "thinking", text: value });
      }
      continue;
    }
    if (u.sessionUpdate === "agent_message_chunk") { appendText(assistant, record(u.content).text); continue; }
    const id = u.toolCallId;
    if (typeof id !== "string") { if (options.keeper) continue; throw new UpdateUnavailable(); }
    let call = calls.get(id);
    if (options.keeper ? !call : u.sessionUpdate === "tool_call") {
      if (call) throw new UpdateUnavailable();
      call = { fields: {}, part: { kind: "tool", name: "", summary: "", input: "", output: "" }, diffs: new Map() };
      calls.set(id, call); assistant.parts.push(call.part);
    }
    if (!call) throw new UpdateUnavailable();
    for (const [key, value] of Object.entries(u)) {
      // ACP uses null for "unchanged" in these optional fields.
      if (value === null && (["rawInput", "rawOutput", "name"].includes(key) || (u.sessionUpdate === "tool_call_update" && (key === "kind" || key === "status")))) continue;
      call.fields[key] = value;
    }
    const fields = call.fields;
    const input = record(fields.rawInput);
    const name = fields.name ?? record(record(fields._meta)["x.ai/tool"]).name;
    call.part.name = typeof name === "string" ? name
      : fields.kind === "search" && (input.variant === "WebSearch" || input.variant === "XSearch") ? input.variant
      : typeof fields.kind === "string" ? fields.kind : id;
    call.part.summary = typeof fields.title === "string" && fields.title ? fields.title.slice(0, 120) : toolSummary(call.part.name, input);
    call.part.input = typeof fields.rawInput === "string" ? fields.rawInput : fields.rawInput === undefined ? "" : JSON.stringify(fields.rawInput);
    call.part.error = fields.status === "failed";
    if (options.keeper) {
      call.part.call_id = id;
      call.part.state = fields.status === "failed" ? "error" : fields.status === "completed" ? "ok" : "pending";
    }
    const skill = call.part.name === "read_file" ? skillDocument(input.target_file) : null;
    if (skill) call.part.skill = { ...skill, status: fields.status === "completed" ? "loaded" : fields.status === "failed" ? "failed" : "requested" };
    else delete call.part.skill;
    // ACP replaces content as a whole. Keep the edit evidence separately so a later
    // completion message cannot erase a diff that the tool already displayed.
    const content = Array.isArray(fields.content) ? fields.content : [];
    for (const value of content) {
      const block = record(value);
      if (block.type !== "diff" || typeof block.path !== "string" || typeof block.newText !== "string" || (block.oldText != null && typeof block.oldText !== "string")) continue;
      const edit = { path: block.path, before: block.oldText ?? "", after: block.newText };
      call.diffs.set(hash(JSON.stringify(edit)), edit);
    }
    if (call.diffs.size) call.part.edits = [...call.diffs.values()];
    const output = [legacyEditText(call.part.edits), outputText(content)].filter(Boolean).join("\n");
    const images = [...new Set(updatePictures(fields).map((picture) => `${picture.mediaType}\0${options.imageRef(picture)}`))]
      .map((key) => ({ media_type: key.slice(0, key.indexOf("\0")), ref: key.slice(key.indexOf("\0") + 1) }));
    if (images.length > 0) call.part.images = images; else delete call.part.images;
    delete call.part.output_ref; delete call.part.output_size;
    if (options.wholeCall === id) call.part.output = output.length > 2_000_000 ? `${output.slice(0, 2_000_000)}\n… trimmed` : output;
    else trimOutput(call.part, output, options.outputRef(id, output));
  }
  for (const [turn, skill] of promptSkills) turn.parts.push({ kind: "skill", skill });
  return turns.filter((turn) => turn.parts.length > 0);
}
