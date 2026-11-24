import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../process-start.ts";
import { record } from "./messages.ts";

/** Whether the keeper `root`'s process.json names still runs. */
export function keeperRunning(root: string): boolean {
  let pid: unknown;
  try {
    pid = record(JSON.parse(readFileSync(join(root, "process.json"), "utf8")))?.["keeper"];
  } catch {
    return false;
  }
  return typeof pid === "number" && processAlive(pid);
}
