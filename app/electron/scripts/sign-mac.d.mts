import type { Run } from "./notarize-dmg.mjs";

export declare function signHostAndRecordHash(host: string, signing: { identity: string; keychain?: string; entitlements?: string }, exec?: Run): Promise<void>;
type SignOptions = { app: string; identity: string; keychain?: string; ignore: (file: string) => boolean; optionsForFile: (file: string) => { entitlements?: string } };
export declare function signNativeBinaries(opts: SignOptions, exec?: Run): Promise<SignOptions["ignore"]>;
export default function sign(opts: SignOptions): Promise<unknown>;
