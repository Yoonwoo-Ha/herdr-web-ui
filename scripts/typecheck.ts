import { availableParallelism } from "node:os";
import { existsSync } from "node:fs";

export {};

// Native TypeScript uses Go's GC. Trade RAM for CPU: no proportional collection, only a
const env = {
  ...process.env,
  GOGC: process.env["GOGC"] ?? "off",
  GOMEMLIMIT: process.env["GOMEMLIMIT"] ?? "8GiB",
  GOMAXPROCS: process.env["GOMAXPROCS"] ?? String(Math.min(32, availableParallelism())),
};

const vendor = "shared/vendor/paseo-e2ee/tsconfig.json";
if (existsSync(vendor)) {
  const child = Bun.spawn([process.execPath, "--bun", "tsc", "-p", vendor, "--emitDeclarationOnly"], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}

for (const args of [[], ["-p", "tsconfig.tools.json"]]) {
  const child = Bun.spawn([process.execPath, "--bun", "tsc", "--noEmit", ...args], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
