import { TOOL_SCHEMAS, harnessVerb, refuse } from "../shared/harness-tool.ts";
import { callHarness } from "../server/agent-tools/mcp.ts";

/** This command has no fallback to the owner's HTTP door, the current pane or another run. */
export async function runAgent(words: readonly string[]): Promise<number> {
  const [word, ...rest] = words;
  const verb = word === "list" ? "ls" : word === "cancel" ? "stop" : word;
  const bad = () => { console.log(JSON.stringify(refuse("bad_request", "Invalid command. See ovis agent --help."))); return 2; };
  if (!harnessVerb(verb)) return bad();
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) return bad();
    if (arg === "--") { positional.push(...rest.slice(i + 1)); break; }
    if (arg === "--json") continue;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    let name = arg.slice(2).replaceAll("-", "_");
    let value: unknown;
    if (verb === "read" && ["screen","state","result","transcript"].includes(name)) { value = name; name = "what"; }
    else { value = rest[++i]; if (value === undefined) return bad(); }
    if (!Object.hasOwn(TOOL_SCHEMAS[verb].properties, name) || Object.hasOwn(args, name)) return bad();
    args[name] = name === "timeout_s" ? Number(value) : value;
  }
  for (const key of ["session","task"]) if (positional.length && Object.hasOwn(TOOL_SCHEMAS[verb].properties, key) && !(key in args)) args[key] = positional.shift();
  if (positional.length) return bad();
  const socket = process.env["OVIS_AGENT_SOCKET"], tokenFile = process.env["OVIS_AGENT_TOKEN_FILE"];
  const value = socket && tokenFile ? await callHarness({ socket, tokenFile }, verb, args) : refuse("not_granted", "This shell has no Ovis agent run.");
  console.log(JSON.stringify(value));
  return value.kind === "refusal" ? 1 : 0;
}
