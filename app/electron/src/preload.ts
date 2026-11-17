import { contextBridge, ipcRenderer } from "electron";
import { linkHold } from "./openLink.ts";

contextBridge.exposeInMainWorld("ovisUpdate", {
  current: (): Promise<unknown> => ipcRenderer.invoke("ovis:update"),
  onChange: (listener: (update: unknown) => void): (() => void) => {
    const heard = (_event: unknown, update: unknown) => listener(update);
    ipcRenderer.on("ovis:update", heard);
    return () => { ipcRenderer.removeListener("ovis:update", heard); };
  },
  install: (): Promise<void> => ipcRenderer.invoke("ovis:update-install"),
  close: (version: string): void => ipcRenderer.send("ovis:update-close", version),
});

const isConnectionScreen = location.protocol === "file:";
if (isConnectionScreen) {
  contextBridge.exposeInMainWorld("ovisDesktop", {
    status: () => ipcRenderer.invoke("ovis:status"),
    onStatus: (listener: (status: unknown) => void) => {
      ipcRenderer.on("ovis:status", (_event, status: unknown) => listener(status));
    },
    retry: () => ipcRenderer.send("ovis:retry"),
    showLogs: () => ipcRenderer.send("ovis:logs"),
  });
} else {
  const links = linkHold();
  ipcRenderer.on("ovis:open-link", (_event, query: unknown) => links.receive(query));
  contextBridge.exposeInMainWorld("ovisLink", {
    onOpen: (listener: (query: string) => void): void => links.onOpen(listener),
  });
  const named = ipcRenderer.sendSync("ovis:account-service") as { service?: unknown; providers?: unknown } | null;
  if (typeof named?.service === "string") {
    contextBridge.exposeInMainWorld("ovisAccount", {
      service: named.service,
      providers: Array.isArray(named.providers) ? named.providers.filter((name): name is string => typeof name === "string") : [],
      start: (): Promise<string> => ipcRenderer.invoke("ovis:account-start"),
      open: (url: string): Promise<string> => ipcRenderer.invoke("ovis:account-open", url),
    });
  }
}
