import { join } from "node:path";
import { notarizeApp } from "./notarize-dmg.mjs";

/** @param {{ electronPlatformName: string, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  await notarizeApp(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}
