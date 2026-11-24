/**
 * The PC's own proof on its listing (docs/account.md, "PC API"): for 30 days after `ovis logout` left an
 * account, PUT /v1/pcs/{server_id} answers 409 `pc_left` unless it carries the PC's own fresh `{ challenge_id, proof }`.
 * Only the PC itself can make one (POST /api/account/pc-proof: its own window or its CLI), so the way back is a sign-in
 * on the PC. Shared by the window's Add this PC and the CLI's `ovis login`.
 */

/** The fields a PUT /v1/pcs body carries beside its entry: the proof, or nothing where this PC gave none. */
export interface PcProofFields { readonly challenge_id?: string; readonly proof?: string }

/** How long a listing waits for the PC's proof before it goes without one (the PUT then answers as before). */
export const PC_PROOF_MS = 10_000;

/**
 * Asks this PC for a fresh proof that it is `serverId`, to spread into the PUT body right away: the proof is single-use
 * and lapses after a minute. `post` sends a POST of `{}` to this PC's own API at that path and resolves its JSON answer,
 * rejecting on a refusal (the window's apiFetch, the CLI's local api). Nothing (`{}`) when the PC gives none: an Ovis
 * from before the route (404), a window that is not this PC's own (403), the service away, no answer in PC_PROOF_MS,
 * or a proof for another PC than `serverId`.
 */
export async function ownPcProof(serverId: string, post: (path: string) => Promise<unknown>): Promise<PcProofFields> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // fixed wait: a deadline for a PC that does not answer, not a pause
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PC_PROOF_MS); });
  const asked = post("/api/account/pc-proof").then((answer) => (typeof answer === "object" && answer !== null ? answer : null) as { server_id?: unknown; challenge_id?: unknown; proof?: unknown } | null, (error: unknown) => {
    console.warn("Ovis: this PC gave no proof for its listing", error instanceof Error ? error.name : error);
    return null;
  });
  const body = await Promise.race([asked, late]).finally(() => clearTimeout(timer));
  if (body === null || body.server_id !== serverId || typeof body.challenge_id !== "string" || typeof body.proof !== "string") return {};
  return { challenge_id: body.challenge_id, proof: body.proof };
}
