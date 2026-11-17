import { spyOn } from "bun:test";
import { MachineManager } from "./machines.ts";
import { SshConnection } from "./ssh.ts";

type Tunnel = { tunnel(ssh: SshConnection, descriptor: { port: number; token: string }): Promise<{ url: string; token: string }> };
type Relay = ReturnType<typeof Bun.serve>;

export function tunnelRelays(relays: Relay[], serve: (remotePort: number) => Relay): { mockRestore(): void }[] {
  const forwarded = new Map<string, Relay[]>();
  const prototype = MachineManager.prototype as unknown as Tunnel;
  const tunnel = prototype.tunnel;
  return [
    spyOn(SshConnection.prototype, "forward").mockImplementation(async (port, remotePort) => {
      const relay = serve(remotePort);
      relays.push(relay);
      const key = `${port}:${remotePort}`;
      forwarded.set(key, [...forwarded.get(key) ?? [], relay]);
    }),
    spyOn(prototype, "tunnel").mockImplementation(async function (this: Tunnel, ssh, descriptor) {
      const opened = await tunnel.call(this, ssh, descriptor);
      const url = new URL(opened.url);
      const relay = url.hostname === "127.0.0.1" ? forwarded.get(`${url.port}:${descriptor.port}`)?.shift() : undefined;
      if (!relay) throw new Error(`The tunnel's address ${opened.url} is no port it forwarded`);
      return { url: `http://127.0.0.1:${relay.port}`, token: opened.token };
    }),
  ];
}
