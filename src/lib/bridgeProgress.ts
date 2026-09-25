import type { SetupProgress } from "../../shared/machines.ts";

const STAGES: ReadonlyArray<{ stage: SetupProgress["stage"]; label: string }> = [
  { stage: "download", label: "Downloading the bridge" },
  { stage: "upload", label: "Sending it to the PC" },
  { stage: "install", label: "Verifying and installing" },
  { stage: "restart", label: "Restarting the bridge" },
];

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** "about 2 min" / "about 40 s": a rate is a guess, so no more precision than that. */
export function formatRemaining(seconds: number): string {
  if (seconds >= 60) return `about ${Math.round(seconds / 60)} min`;
  return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
}

export interface ProgressView {
  /** "Step 2 of 4" */
  step: string;
  label: string;
  /** 0-100 when the stage has a size */
  percent: number | null;
  /** "45 MB of 130 MB · about 1 min left" */
  detail: string | null;
}

/** What a bridge install is doing, in words; null before it has a stage. */
export function describeProgress(progress: SetupProgress | null | undefined): ProgressView | null {
  if (!progress) return null;
  const index = STAGES.findIndex((entry) => entry.stage === progress.stage);
  const step = `Step ${index + 1} of ${STAGES.length}`;
  const label = STAGES[index]?.label ?? progress.stage;
  if (progress.total === null || progress.total <= 0) {
    return { step, label, percent: null, detail: progress.done > 0 ? formatBytes(progress.done) : null };
  }
  const done = Math.min(progress.done, progress.total);
  const percent = Math.floor((done / progress.total) * 100);
  const sizes = `${formatBytes(done)} of ${formatBytes(progress.total)}`;
  const left = progress.rate && progress.rate > 0 && done < progress.total ? ` · ${formatRemaining((progress.total - done) / progress.rate)} left` : "";
  return { step, label, percent, detail: sizes + left };
}
