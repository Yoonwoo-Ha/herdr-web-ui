/**
 * Imported first by every server entry point, before any module reads its settings: the settings
 * this process was started with under their names from before the rename (legacy-env.ts) fill
 * the OVIS_* names they now go by.
 */
import { adoptLegacyEnv } from "./legacy-env.ts";

adoptLegacyEnv(process.env);
