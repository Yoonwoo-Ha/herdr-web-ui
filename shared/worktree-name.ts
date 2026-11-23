/**
 * The branch herdr's own New worktree form starts with (the web's dialog and the screen's): `worktree/<adjective>-<noun>-<4 hex>`,
 * from herdr 0.9.3's word lists, and the workspace name it shows for it (the branch with its
 * slashes as dashes, which is also the checkout folder's name).
 */
const ADJECTIVES = ["brave", "clear", "green", "lucky", "rapid", "silver"] as const;
const NOUNS = ["river", "cloud", "field", "forest", "harbor", "meadow", "stone", "valley"] as const;

const pick = <T>(words: readonly T[], random: () => number): T => words[Math.min(words.length - 1, Math.floor(random() * words.length))] as T;

export function suggestWorktreeBranch(random: () => number = Math.random): string {
  const suffix = Math.min(0xffff, Math.floor(random() * 0x10000)).toString(16).padStart(4, "0");
  return `worktree/${pick(ADJECTIVES, random)}-${pick(NOUNS, random)}-${suffix}`;
}

export function worktreeLabel(branch: string): string {
  return branch.trim().replaceAll("/", "-");
}
