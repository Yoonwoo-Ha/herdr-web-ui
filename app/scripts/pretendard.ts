import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CHUNK = /url\(\.\/woff2-dynamic-subset\/(PretendardVariable\.subset\.\d+)\.woff2\)/g;

/**
 * The hosted page's typeface for the app's own pages (index.html links pretendard.css): upstream's dynamic-subset
 * stylesheet (`source`, src/fonts/pretendard), each chunk pointed at the file the bundled demo already carries under
 * `demo/assets` (Vite names it `<chunk>-<hash>.woff2`), so the app holds the font once. A chunk the demo does not carry
 * fails the build rather than drawing a page in another face.
 */
export function pretendardCss(source: string, demo: string): string {
  const assets = readdirSync(join(demo, "assets"));
  return readFileSync(source, "utf8").replace(CHUNK, (_, chunk: string) => {
    const file = assets.find((name) => name.startsWith(`${chunk}-`) && name.endsWith(".woff2") && /^[^.]+$/.test(name.slice(chunk.length + 1, -".woff2".length)));
    if (file === undefined) throw new Error(`the demo carries no ${chunk}.woff2 for the app's own pages (app/scripts/pretendard.ts)`);
    return `url(./demo/assets/${file})`;
  });
}
