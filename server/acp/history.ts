import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { PlanStep } from "../../shared/plans.ts";
import { imageType } from "../codex-images.ts";
import { answerVersion, ConversationReadPending, ConversationUnavailable, HistoryChanged, type ConversationPage, type RecognizedConversation } from "../conversation-shared.ts";
import { parseLine, record, type Message, type Row } from "./messages.ts";
import { digestOf, projectUpdates, type Picture, type UpdateEvent } from "./updates.ts";

interface Span { start: number; end: number }
interface Prompt extends Span { tail: number; prior: readonly Span[]; replay: boolean; session: string; final?: boolean }
const byteCount = (p: Prompt) => p.prior.reduce((n, span) => n + span.end - span.start, p.end - p.tail);
interface History { generation: number; prompts: Prompt[]; pending: Map<string, Prompt>; finished: number; plan: PlanStep[] | null; user: boolean; session: string | null }
const empty = (generation: number, session: string | null = null): History => ({ generation, prompts: [], pending: new Map(), finished: 0, plan: null, user: false, session });
const MAX_BYTES = 64 * 1024 * 1024;
type Entry = { row: Row; message: Message | null };

function planSteps(entries: unknown[]): PlanStep[] {
  return entries.flatMap((value, i) => {
    const item = record(value);
    if (!item || typeof item.content !== "string" || !(item.status === "completed" || item.status === "pending" || item.status === "in_progress")) return [];
    return [{ id: String(i + 1), label: item.content, status: item.status, active: null, blocked_by: [], owner: null, started_at: null, ended_at: null }];
  });
}

/** The keeper streams the archive bytes verbatim. Index prompt boundaries on that one replay;
 * a browser poll reads only the page it asked for, never the whole archive or its image store. */
export class AcpHistory {
  readonly path: string;
  private active = empty(0);
  private loading: History | null = null;
  private incomplete = false;
  private resumeSpan = false;
  private position = 0;
  private fileId?: { dev: bigint; ino: bigint };

  constructor(root: string) { this.path = join(root, "archive.jsonl"); }

  get signature(): string { return `${this.active.generation}:${this.active.prompts.at(-1)?.end ?? 0}:${this.active.finished}`; }

  get plan(): PlanStep[] | null { return this.active.plan; }
  get session(): string | null { return (this.loading ?? this.active).session; }

  observe({ row, message }: Entry, length: number): void {
    const start = this.position;
    if (start === 0) {
      // Bind the later page/asset opens to the keeper file, not a replacement at its path.
      const stat = lstatSync(this.path, { bigint: true, throwIfNoEntry: false });
      if (stat?.isFile()) this.fileId = { dev: stat.dev, ino: stat.ino };
    }
    this.position += length;
    if (message === null || (row.dir === "keeper" && message.method === "_keeper/oversize")) {
      if (this.loading) this.incomplete = true;
      return;
    }
    const params = message.params;
    if (row.dir === "keeper" && message.method === "_keeper/mode" && params?.mode === "acp") {
      if (params.phase === "start") {
        this.loading = empty(row.seq, typeof params.sessionId === "string" ? params.sessionId : this.active.session);
        this.incomplete = false;
      }
      if ((params.phase === "ready" || params.phase === "failed") && this.loading) {
        this.resumeSpan = params.phase === "failed" || this.incomplete;
        if (!this.resumeSpan) this.active = this.loading;
        this.loading = null;
      }
      return;
    }
    const state = this.loading ?? this.active;
    if (row.dir === "from-agent" && message.method === undefined && typeof message.id === "string") {
      const answered = state.pending.get(message.id);
      state.pending.delete(message.id);
      if (answered && message.result?.stopReason === "end_turn" && !message.error) {
        answered.final = true;
        state.finished = row.seq;
      }
      return;
    }
    if (row.dir === "keeper" && (message.method === "_keeper/agent_exit" || message.method === "_keeper/ready")) state.pending.clear();
    if ((row.dir === "keeper" && message.method === "_keeper/session")
      || (row.dir === "to-agent" && message.method === "session/load" && typeof message.id === "string" && message.id.startsWith("keeper-"))) {
      const session = typeof params?.sessionId === "string" ? params.sessionId : null;
      if (session !== state.session) {
        if (this.loading) this.loading = empty(row.seq, session);
        else this.active = empty(row.seq, session);
      }
      return;
    }
    if (!state.session || params?.sessionId !== state.session) return;
    const update = row.dir === "from-agent" && message.method === "session/update" ? record(params?.update) : null;
    if (update?.sessionUpdate === "plan" && Array.isArray(update.entries)) state.plan = planSteps(update.entries);
    const prompt = row.dir === "to-agent" && message.method === "session/prompt";
    const user = update?.sessionUpdate === "user_message_chunk";
    if (!prompt && (typeof update?.sessionUpdate !== "string" || !["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "user_message_chunk"].includes(update.sessionUpdate))) return;
    if (user && !this.loading) return; // the agent's echo of the outgoing prompt, not another user turn
    if (prompt || (user && !state.user) || !state.prompts.length) state.prompts.push({ start, end: this.position, tail: start, prior: [], replay: this.loading !== null, session: state.session });
    const last = state.prompts.at(-1);
    if (last) {
      if (prompt && typeof message.id === "string") state.pending.set(message.id, last);
      if (!this.loading && this.resumeSpan && last.start !== start) {
        last.prior = [...last.prior, { start: last.tail, end: last.end }];
        last.tail = start;
      }
      if (!this.loading) this.resumeSpan = false;
      last.end = this.position;
    }
    state.user = user;
  }

  private async read(prompt: Prompt, asset?: { ref: string; image?: Picture; output?: string }) {
    const { start, end } = prompt;
    const size = byteCount(prompt);
    const spans = [...prompt.prior, { start: prompt.tail, end }];
    if (size > MAX_BYTES) throw new ConversationUnavailable("transcript_unreadable");

    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.dev !== this.fileId?.dev || stat.ino !== this.fileId.ino) throw new ConversationUnavailable("transcript_unreadable");
      bytes = Buffer.alloc(size);
      let at = 0;
      for (const span of spans) {
        for (let pos = span.start; pos < span.end;) {
          const { bytesRead } = await file.read(bytes, at, span.end - pos, pos);
          if (!bytesRead) throw new ConversationReadPending();
          at += bytesRead;
          pos += bytesRead;
        }
      }
    } finally { await file.close(); }
    function* updates(): Generator<UpdateEvent> {
      for (const line of bytes.toString("utf8").split("\n")) {
        const entry = parseLine(line);
        if (!entry || !("row" in entry)) continue;
        const { row, message } = entry;
        if (!message || message.params?.sessionId !== prompt.session) continue;
        const ts = typeof row.ts === "number" && Number.isFinite(row.ts) && Math.abs(row.ts) <= 8.64e15 ? new Date(row.ts).toISOString() : null;
        if (row.dir === "to-agent" && message.method === "session/prompt" && Array.isArray(message.params?.prompt)) {
          for (const content of message.params.prompt) yield { ts, update: { sessionUpdate: "user_message_chunk", content } };
        } else if (row.dir === "from-agent" && message.method === "session/update") {
          const update = record(message.params?.update);
          if (update && (prompt.replay || update.sessionUpdate !== "user_message_chunk") && update.sessionUpdate !== "rewind_marker") yield { ts, update };
        }
      }
    }
    const turns = projectUpdates(updates(), {
      keeper: true,
      imageRef: (picture) => {
        const ref = `acp-image:${start}:${digestOf(picture.data)}`;
        if (asset?.ref === ref) asset.image = picture;
        return ref;
      },
      outputRef: (id, output) => {
        const ref = `acp-tool:${start}:${createHash("sha256").update(JSON.stringify([id, output])).digest("hex")}`;
        if (asset?.ref === ref) asset.output = output.length > 2_000_000 ? `${output.slice(0, 2_000_000)}\n… trimmed` : output;
        return ref;
      },
    });
    if (prompt.final) {
      const last = turns.at(-1);
      if (last?.role === "assistant") {
        for (let i = last.parts.length - 1; i >= 0; i--) {
          const part = last.parts[i];
          if (part?.kind === "text") { part.phase = "final_answer"; break; }
        }
      }
    }
    return turns;
  }

  async page(page: ConversationPage): Promise<RecognizedConversation> {
    const state = this.active;
    const history_id = answerVersion(this.path, String(state.generation));
    const cursor = (index: number) => `${history_id}:${index}`;
    const offset = (asked: string | undefined, fallback: number) => {
      if (asked === undefined) return fallback;
      const index = Number(asked.split(":")[1]);
      if (!Number.isSafeInteger(index) || index < 0 || index > state.prompts.length || asked !== cursor(index)) throw new HistoryChanged();
      return index;
    };
    const end = offset(page.before, state.prompts.length);
    const floor = offset(page.before === undefined ? page.from : page.since, 0);
    if (floor > end) throw new HistoryChanged();
    const count = Math.min(50, Math.max(1, page.prompts ?? 50));
    let start = end, bytes = 0;
    while (start > floor && end - start < count) {
      const prompt = state.prompts[start - 1];
      if (!prompt || (bytes > 0 && bytes + byteCount(prompt) > MAX_BYTES)) break;
      bytes += byteCount(prompt);
      start--;
    }
    const selection = state.prompts.slice(start, end).map(prompt => ({ ...prompt }));
    const turns = [];
    for (const prompt of selection) turns.push(...await this.read(prompt));
    if (this.active !== state) throw new HistoryChanged();
    return { source: "acp", turns, cursor: start ? cursor(start) : null, history_id, metadata: { model: null, reasoning_effort: null },
      version: answerVersion(history_id, `${start}:${end}:${selection.at(-1)?.end ?? 0}:${selection.map(p => p.final ? 1 : 0).join("")}`) };
  }

  async asset(ref: string) {
    const match = /^acp-(image|tool):(\d+):[0-9a-f]{64}$/.exec(ref);
    const state = this.active;
    const prompt = match && state.prompts.find(p => p.start === Number(match[2]));
    if (!prompt) return null;
    const asset: { ref: string; image?: Picture; output?: string } = { ref };
    const through = prompt.end;
    const turns = await this.read(prompt, asset);
    if (state !== this.active || prompt.end !== through) return null;
    const parts = turns.flatMap(turn => turn.parts);
    if (asset.image && parts.some(p => p.kind === "image" ? p.ref === ref : p.kind === "tool" && p.images?.some(i => i.ref === ref))) {
      const bytes = Buffer.from(asset.image.data, "base64");
      if (imageType(bytes) === asset.image.mediaType) return { mediaType: asset.image.mediaType, bytes: new Uint8Array(bytes) };
    }
    return asset.output !== undefined && parts.some(p => p.kind === "tool" && p.output_ref === ref) ? asset.output : null;
  }
}
