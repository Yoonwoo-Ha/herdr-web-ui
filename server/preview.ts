export function fleetPreview(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env["OVIS_PREVIEW"] ?? "").split(",").some((word) => word.trim() === "fleet");
}
