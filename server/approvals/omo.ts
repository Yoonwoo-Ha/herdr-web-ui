/**
 * OmO's adapter to the approval hub (server/approvals/hub.ts). OmO asks its own permissions (its permission system,
 * under the user's preset and rules) in a dialog of its own; Ovis makes no policy of its own here. Its extension
 * (server/approvals/extension.ts) answers that very dialog for a shell command: the permission system announces each
 * request (`permission_asked`, with the command and the tool call it is for), then opens its dialog with
 * `ctx.ui.select`, which the extension runs alongside the hub, for Ovis's card. Whichever answers first wins and closes
 * the other; the dialog stays as OmO draws it, every option of it. Any other request (a file, a folder, a fetch) and
 * any request it cannot tie to its dialog are left to OmO's dialog alone. Measured on OmO 5.1.81 (senpi 2026.11.19-5).
 */
import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import { ALLOW_LABEL, DENY_LABEL, extensionApprovals } from "./extension.ts";

export const OMO_HOOK_MIN_VERSION = "5.1.81";

const GLUE = `
export default function ovisApprovals(pi) {
  let ui = null;
  const asked = new Map();
  const wrapped = new WeakSet();
  pi.on("session_start", (_event, ctx) => { ui = ctx?.hasUI ? ctx.ui : null; });
  pi.events.on("permission_asked", (request) => {
    const command = request?.metadata?.command;
    const call = request?.tool?.callID;
    if (request?.permission !== "bash" || typeof command !== "string" || typeof call !== "string" || ui === null) return;
    const description = typeof request.metadata.description === "string" ? request.metadata.description : null;
    asked.set(call, { tool: "bash", command, description });
    if (wrapped.has(ui)) return;
    wrapped.add(ui);
    const select = ui.select.bind(ui);
    ui.select = async (title, options, opts) => {
      const event = /^Permission required: bash\\n/.test(title) && options.includes(${JSON.stringify(ALLOW_LABEL)}) && options.includes(${JSON.stringify(DENY_LABEL)})
        ? asked.get(opts?.toolCallId) : undefined;
      if (event === undefined) return select(title, options, opts);
      asked.delete(opts.toolCallId);
      const closing = new AbortController();
      const signal = opts.signal ? AbortSignal.any([closing.signal, opts.signal]) : closing.signal;
      try {
        return await Promise.race([
          select(title, options, { ...opts, signal }),
          hubDecision(event, signal).then((decision) => decision === "allow" ? ${JSON.stringify(ALLOW_LABEL)} : ${JSON.stringify(DENY_LABEL)}),
        ]);
      } finally {
        closing.abort();
      }
    };
  });
}
`;

/** OmO 5.x from the one measured on: a later major may change the permission system under the hook. */
export const omoApprovals = extensionApprovals("omo", (version) => meetsMinVersion(version, OMO_HOOK_MIN_VERSION) && version.split(".")[0] === "5", GLUE);
