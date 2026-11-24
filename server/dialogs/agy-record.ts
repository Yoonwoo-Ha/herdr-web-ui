import { type AgentRecord, OpenRequests } from "./record.ts";

/** A step of Antigravity's conversation database (`steps`) that waits on the user, as server/agy.ts reads it. */
export interface AgyPendingStep {
  readonly idx: number;
  readonly payload: Uint8Array;
}

type Field = { readonly number: number; readonly bytes: Uint8Array | null };

function varint(bytes: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  for (let shift = 0, index = at; index < bytes.length && shift < 64; shift += 7, index += 1) {
    const byte = bytes[index]!;
    if (shift < 53) value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: index + 1 };
  }
  return null;
}

/** A protobuf message's fields, the length-delimited ones with their bytes; null for bytes that are no message. */
function fields(bytes: Uint8Array): Field[] | null {
  const found: Field[] = [];
  for (let at = 0; at < bytes.length;) {
    const tag = varint(bytes, at);
    if (tag === null || tag.value < 8) return null;
    const [number, wire] = [Math.floor(tag.value / 8), tag.value % 8];
    at = tag.next;
    if (wire === 0) {
      const value = varint(bytes, at);
      if (value === null) return null;
      at = value.next;
      found.push({ number, bytes: null });
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      if (at > bytes.length) return null;
      found.push({ number, bytes: null });
    } else if (wire === 2) {
      const length = varint(bytes, at);
      if (length === null || length.next + length.value > bytes.length) return null;
      found.push({ number, bytes: bytes.subarray(length.next, length.next + length.value) });
      at = length.next + length.value;
    } else return null;
  }
  return found;
}

const text = (bytes: Uint8Array | null | undefined): string | null => bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null;

function first(bytes: Uint8Array | null | undefined, ...path: number[]): Uint8Array | null {
  let at = bytes ?? null;
  for (const number of path) at = (at && fields(at)?.find((field) => field.number === number)?.bytes) ?? null;
  return at;
}

/**
 * The command a waiting step asks to run: Antigravity CLI (1.5.15) writes a tool call's step (`step_type` 132) with
 * `status` 9 while it waits on the user, and only then a permission request in its payload, field 56: under its 21,
 * key/value entries (1), the one keyed `command` (1) holding the command (2). Its call id is the payload's 5.4.1.
 * Once answered the same step turns to 3 (run) or 7 (refused) and drops field 56.
 */
function command(payload: Uint8Array): { call: string | null; command: string | null } {
  try {
    const entries = fields(first(payload, 56, 21) ?? new Uint8Array()) ?? [];
    const keyed = entries.filter((entry) => entry.number === 1).find((entry) => text(first(entry.bytes, 1)) === "command");
    return { call: text(first(payload, 5, 4, 1)), command: text(first(keyed?.bytes, 2)) };
  } catch {
    return { call: null, command: null };
  }
}

/**
 * The one step that waits on the user to run a shell command (none, or more than one, waiting names none), and its
 * dialog, as Antigravity draws it:
 *
 *   Requesting permission for:
 *      touch am-short.flag
 *
 *   Run this command?
 *   > 1. Yes, run command
 */
export const agyRecord: AgentRecord<readonly AgyPendingStep[]> = {
  dialog: /^Requesting permission for:$/u,
  pending(steps) {
    const waiting = new OpenRequests();
    for (const step of steps) {
      const { call, command: shell } = command(step.payload);
      waiting.open(`${step.idx}:${call ?? ""}`, shell);
    }
    return waiting.only();
  },
};
