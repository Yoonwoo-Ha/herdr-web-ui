import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { checked, signedHelpers } from "./server-release-files.ts";

/** Read the published documents, but hash the private snapshot the repair job will upload. */
export async function verifyRepair(assets: string, docs: string, version: string) {
  const signed = await signedHelpers(pathToFileURL(resolve(docs)).href, version);
  for (const entry of [...Object.values(signed.hosts), ...Object.values(signed.keepers)]) {
    await checked(pathToFileURL(resolve(assets)).href, entry);
  }
}
if (import.meta.main) {
  const [assets, docs, version] = process.argv.slice(2);
  if (!assets || !docs || !version) throw new Error("Expected asset folder, published manifests folder and version");
  await verifyRepair(assets, docs, version);
}
