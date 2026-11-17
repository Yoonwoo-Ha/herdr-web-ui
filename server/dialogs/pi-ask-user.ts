import type { DialogReader } from "./registry.ts";

export const readers: readonly DialogReader[] = [{
  id: "pi-ask-user",
  agents: ["pi"],
  priority: 85,
  parse: () => null,
  reread: "before-commit",
  list: "none",
}];
