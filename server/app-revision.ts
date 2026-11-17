import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVISION } from "../shared/update.ts";
import { ASSETS } from "./entries.ts";

export function buildRevision(root = ASSETS, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env["OVIS_DESKTOP_APP"] !== "1") {
    const named = env["OVIS_REVISION"];
    return named && REVISION.test(named) ? named : undefined;
  }
  try {
    const build = JSON.parse(readFileSync(join(root, "dist", "build.json"), "utf8")) as { revision?: unknown; dirty?: unknown };
    return typeof build.revision === "string" && REVISION.test(build.revision) && build.dirty === false ? build.revision : undefined;
  } catch { return undefined; }
}

const atStart = buildRevision();
export const appBuild = { revision: (): string | undefined => atStart };
