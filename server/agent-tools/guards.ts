import { TOOL_SCHEMAS, isRecord, type HarnessVerb } from "../../shared/harness-tool.ts";

interface Field { readonly type?: string; readonly enum?: readonly string[]; readonly pattern?: string; readonly minimum?: number; readonly maximum?: number }
interface Input { required?: readonly string[]; properties: Readonly<Record<string, Field>> }
export function validArgs(verb: HarnessVerb, args: unknown): args is Record<string, unknown> {
  if (!isRecord(args)) return false;
  const schema: Input = TOOL_SCHEMAS[verb];
  if (schema.required?.some(k => !Object.hasOwn(args, k))) return false;
  return Object.entries(args).every(([name, val]) => {
    if (!Object.hasOwn(schema.properties, name)) return false;
    const field = schema.properties[name];
    if (!field) return false;
    if (field.type === "integer") return typeof val === "number" && Number.isSafeInteger(val) && val >= (field.minimum ?? 1) && val <= (field.maximum ?? 45);
    return typeof val === "string" && val.trim() !== "" && (!field.enum || field.enum.includes(val)) && (!field.pattern || new RegExp(field.pattern).test(val));
  });
}
