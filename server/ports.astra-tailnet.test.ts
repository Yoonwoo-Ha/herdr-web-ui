import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTailscale, serveTailscale } from "./tailscale.ts";

const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.example.ts.net." } });
it("the serve button makes no changes when it cannot inventory occupied ports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astra-ports-"));
  try {
    const bin = join(dir, "tailscale");
    const calls = join(dir, "mutation");
    writeFileSync(bin, `#!/bin/sh\ncase "$1:$2" in\nstatus:--json) printf '%s' '${status}';;\nserve:status) exit 1;;\n*) printf '%s' "$*" > "$(dirname "$0")/mutation"; exit 1;;\nesac\n`, { mode: 0o700 });
    await serveTailscale(7317, [443], bin);
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : null).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("the first free allowed port excludes foreground Serve listeners", () => {
  const foreground = { TCP: { "443": { HTTPS: true } }, Web: { "pc.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8000" } } } } };
  const access = parseTailscale({ status, serve: JSON.stringify({ Foreground: { "session-id": foreground } }) }, 7317, [443, 8443]);
  expect(access.serve_command).toContain("--https=8443");
});

for (const empty of ["null", "{}"]) {
  it(`a serve status of ${empty} is an empty config: the button serves on 443`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "astra-ports-empty-"));
    try {
      const bin = join(dir, "tailscale");
      writeFileSync(bin, `#!/bin/sh
D="$(dirname "$0")"
case "$1:$2" in
status:--json) printf '%s' '${status}';;
serve:status) if [ -e "$D/config" ]; then cat "$D/config"; else printf '%s' '${empty}'; fi;;
serve:--bg) printf '%s' "$*" > "$D/mutation"; port=\${3#--https=}; printf '{"TCP":{"%s":{"HTTPS":true}},"Web":{"pc.example.ts.net:%s":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$port" "$port" "$4" > "$D/config";;
*) exit 1;;
esac
`, { mode: 0o700 });
      const change = await serveTailscale(7317, [443, 8443], bin);
      expect(readFileSync(join(dir, "mutation"), "utf8")).toBe("serve --bg --https=443 http://127.0.0.1:7317");
      expect(change.ok && change.access.tailscale.serving_url).toBe("https://pc.example.ts.net");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
