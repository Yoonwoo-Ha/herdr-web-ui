import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { sshCandidates, sshConfigHosts } from "./ssh-candidates.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function sshDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-candidates-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** `tailscale status --json` with this PC as user 1 and the named peers online, of the same login */
const status = (peers: string[]): string => JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "self.tail.ts.net.", UserID: 1 },
  Peer: Object.fromEntries(peers.map((name, index) => [`k${index}`, { DNSName: `${name}.tail.ts.net.`, UserID: 1, Online: true, OS: "linux" }])),
});

it("lists the hosts a config names with their first HostName and User, leaving out patterns and Match", async () => {
  const hosts = await sshConfigHosts([
    "# a comment",
    "Host *",
    "  User everyone",
    "Host nuc12 nuc",
    "  HostName 100.127.218.1",
    "  User rise",
    "  User ignored",
    "Host web-*",
    "  HostName web.example",
    "Host=github.com",
    "  User git",
    "Match host something",
    "  HostName matched.example",
    "Host \"quoted\"",
    "  HostName=q.example",
    "Host keep db-* !nuc",
    "  User k",
    "Host nuc",
    "  HostName later.example",
  ].join("\n"));
  expect(hosts).toEqual([
    { alias: "nuc12", hostname: "100.127.218.1", user: "rise" },
    { alias: "nuc", hostname: "100.127.218.1", user: "rise" },
    { alias: "github.com", hostname: null, user: "git" },
    { alias: "quoted", hostname: "q.example", user: null },
    { alias: "keep", hostname: null, user: "k" },
  ]);
});

it("leaves out an alias a negated pattern on its own Host line matches, as ssh does", async () => {
  expect(await sshConfigHosts("Host web01 !web*\n  User skipped\nHost db01 !web*\n  User kept\n")).toEqual([{ alias: "db01", hostname: null, user: "kept" }]);
});

it("matches a negated pattern in linear time, so a crafted one cannot hold the server", async () => {
  const alias = "a".repeat(45);
  const started = performance.now();
  const hosts = await sshConfigHosts(`Host ${alias} !${"*a".repeat(12)}b\nHost w0b01 !w?b*\nHost web02 !*0?\n`);
  expect(performance.now() - started).toBeLessThan(250);
  expect(hosts.map((host) => host.alias)).toEqual([alias]);
});

it("starts each file one Include names in the Host block of the Include", async () => {
  const dir = sshDir({ config: "Host lab\n  Include a b\n", a: "Host other\n", b: "User alice\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => null });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail])).toEqual([["lab", "alice@lab"], ["other", null]]);
});

it("stops a line at a word that starts a comment", async () => {
  expect(await sshConfigHosts("Host lab # work machine\n  HostName lab.example # the desk\n")).toEqual([{ alias: "lab", hostname: "lab.example", user: null }]);
});

it("reads an Include inside a Host block as part of that block", async () => {
  const dir = sshDir({ config: "Host lab\n  Include lab.conf\nHost after\n", "lab.conf": "HostName lab-pc.tail.ts.net\nUser alice\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["lab-pc"]) });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.source])).toEqual([
    ["lab", "alice@lab-pc.tail.ts.net", "ssh_config"], ["after", null, "ssh_config"],
  ]);
});

it("reads the hosts of the files an Include names, in their place", async () => {
  const dir = sshDir({
    config: "Host first\n  HostName one.example\nInclude conf.d/*\nHost last\n",
    "conf.d/b": "Host from-b\n",
    "conf.d/a": "Host from-a\n  User a\n",
  });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => null });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail])).toEqual([
    ["first", "one.example"], ["from-a", "a@from-a"], ["from-b", null], ["last", null],
  ]);
  expect(candidates.every((candidate) => candidate.source === "ssh_config" && candidate.destination === candidate.name)).toBe(true);
});

it.skipIf(process.platform === "win32")("reads an Include only inside the home or ssh folder, never through an absolute path, `..` or a link out of them", async () => {
  const home = sshDir({ ".ssh/config": "", "notes/hosts": "Host in-home\n" });
  const outside = sshDir({ secret: "Host leaked\n  HostName secret.example\n  User root\n" });
  symlinkSync(join(outside, "secret"), join(home, ".ssh", "link"));
  writeFileSync(join(home, ".ssh", "config"), [
    `Include ${join(outside, "secret")}`, `Include ../../${basename(outside)}/secret`, "Include link", `Include ${outside}/*`,
    "Include ~/notes/hosts", "Host own",
  ].join("\n"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => null });
  expect(candidates.map((candidate) => candidate.name)).toEqual(["in-home", "own"]);
});

it.skipIf(process.platform === "win32")("skips an included FIFO or oversized file without waiting on it or reading it", async () => {
  const home = sshDir({ ".ssh/big": `Host too-big\n${"#".repeat(300 * 1024)}\n`, ".ssh/small": "Host small\n", ".ssh/config": "Include pipe\nInclude big\nInclude small\n" });
  await Bun.$`mkfifo ${join(home, ".ssh", "pipe")}`;
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => null });
  expect(candidates.map((candidate) => candidate.name)).toEqual(["small"]);
});

it("reads at most 64 included files across every Include", async () => {
  const files: Record<string, string> = { config: "Include a/*\nInclude b/*\n" };
  for (let index = 0; index < 40; index++) {
    files[`a/${String(index).padStart(2, "0")}`] = `Host a${index}\n`;
    files[`b/${String(index).padStart(2, "0")}`] = `Host b${index}\n`;
  }
  const dir = sshDir(files);
  expect(await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => null })).toHaveLength(64);
});

it("lists 200 PCs at most, Tailscale PCs included", async () => {
  const dir = sshDir({ config: Array.from({ length: 200 }, (_, index) => `Host h${index}`).join("\n") });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["extra"]) });
  expect(candidates).toHaveLength(200);
  expect(candidates.some((candidate) => candidate.source === "tailscale")).toBe(false);
});

it("adds the Tailscale PCs no config host already names, and names the Tailscale PC a config host is", async () => {
  const dir = sshDir({ config: "Host lab\n  HostName lab-pc.tail.ts.net\nHost eamac\nHost build\n  HostName build.example\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["lab-pc", "eamac", "winvm"]) });
  expect(candidates).toEqual([
    { name: "lab", destination: "lab", detail: "lab-pc.tail.ts.net", source: "ssh_config", tailnet: "lab-pc.tail.ts.net" },
    { name: "eamac", destination: "eamac", detail: null, source: "ssh_config", tailnet: "eamac.tail.ts.net" },
    { name: "build", destination: "build", detail: "build.example", source: "ssh_config" },
    { name: "winvm", destination: "winvm.tail.ts.net", detail: "winvm.tail.ts.net", source: "tailscale", tailnet: "winvm.tail.ts.net" },
  ]);
});

it("lists only the other source when one is missing", async () => {
  const empty = sshDir({});
  expect(await sshCandidates({ sshDir: empty, readStatus: async () => null })).toEqual([]);
  expect((await sshCandidates({ sshDir: empty, readStatus: async () => status(["box"]) })).map((candidate) => candidate.destination)).toEqual(["box.tail.ts.net"]);
});
