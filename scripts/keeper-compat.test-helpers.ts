import { join } from "node:path";

const releases = [
  ["v0.5.4", "b9d079808f0b0565fa9c380237d92f81d1164e0d"],
  ["v0.5.9", "b87b57b23c38548b47cf51c0f9ee5affeda56a54"],
] as const;

/** Use only the immutable reader, writer, updater and their imports, not a whole clone or another install. */
export async function previousInstallers(scratch: string) {
  const fixtures = [];
  for (const [tag, sha] of releases) {
    const files = ["install.sh", "package.json", "scripts/pty-sidecar.ts", "scripts/server-manifest.ts", "scripts/server-install.ts", "server/updater.ts", "server/update-state.ts", "server/release-notes.ts", "shared/update.ts"];
    if (tag === "v0.5.9") files.push("server/pc-update.ts", "server/remote-json.ts");
    const archive = Bun.spawnSync(["git", "archive", sha, "--", ...files], { cwd: join(import.meta.dir,".."), env: { ...process.env, GIT_MASTER: "1" } });
    if (archive.exitCode !== 0) {
      const reason = "Missing pinned keeper fixture: git fetch origin tag " + tag;
      if (process.env["CI"]) throw new Error(reason);
      console.warn(reason); continue;
    }
    const dir = join(scratch,tag);
    await new Bun.Archive(archive.stdout).extract(dir);
    const manifests: typeof import("./server-manifest.ts") = await import(join(dir,"scripts/server-manifest.ts"));
    const { installServer }: typeof import("./server-install.ts") = await import(join(dir,"scripts/server-install.ts"));
    const updater: typeof import("../server/updater.ts") = await import(join(dir,"server/updater.ts"));
    fixtures.push({ tag, dir, manifests, install: installServer, updater });
  }
  return fixtures;
}
