import { join } from "node:path";

import type { FileInfo } from "../shared/protocol.ts";
import { findFile } from "./file-view.ts";

export const FAVICON_CANDIDATES = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
  "app/icon.svg", "app/icon.png", "app/favicon.ico",
  "src/app/icon.svg", "src/app/icon.png", "src/app/favicon.ico",
  "public/icon.svg", "public/icon.png", "public/apple-touch-icon.png",
  "icon.svg", "icon.png", "build/icon.png", "resources/icon.png", "assets/icon.png",
  "logo.svg", "logo.png", "assets/logo.svg", "assets/logo.png", "public/logo.svg", "public/logo.png",
  "src/assets/logo.svg", "src/assets/logo.png", ".github/logo.svg", ".github/logo.png",
] as const;

export async function findProjectFavicon(root: string): Promise<FileInfo | null> {
  for (const candidate of FAVICON_CANDIDATES) {
    const found = await findFile(join(root, candidate), null, () => Promise.resolve(null));
    if (found !== null && "info" in found && found.info.kind === "image") return found.info;
  }
  return null;
}
