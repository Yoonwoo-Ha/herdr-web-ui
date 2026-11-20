// Run by browserTabs.test.ts as an Electron main process: drives BrowserTabs against the test's server and prints what happened.
import { app, BrowserWindow, session, type WebContents } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserTabs, MAX_BROWSER_TABS, type BrowserProfile } from "./browserTabs.ts";

const port = Number(process.env["OVIS_TEST_PORT"]);
const ovisPort = Number(process.env["OVIS_TEST_OVIS_PORT"]);
const ownPort = Number(process.env["OVIS_TEST_OWN_PORT"]);
const A = `http://a.localhost:${port}`, B = `http://b.localhost:${port}`;
app.setPath("userData", mkdtempSync(join(tmpdir(), "ovis-browser-tabs-")));

function settled(contents: WebContents): Promise<void> {
  return new Promise((done) => contents.once("did-stop-loading", () => done()));
}

void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  // 127.0.0.2 stands in for one of this PC's own addresses outside loopback (a LAN or tailnet one)
  const heard: ((url: string) => void)[] = [];
  const tabs = new BrowserTabs(() => window, { blocked: ["b.localhost"], ovis: [{ host: "localhost", port: ovisPort }] }, join(app.getPath("userData"), "downloads"), () => {}, () => ["127.0.0.2"], (url) => { for (const listener of heard) listener(url); }, 1024);
  const reached = (url: string) => new Promise<void>((done) => heard.push((seen) => { if (seen === url) done(); }));
  const opened: WebContents[] = [];
  app.on("web-contents-created", (_event, contents) => opened.push(contents));
  const tab = async (url: string, profile: BrowserProfile) => {
    const before = opened.length;
    const id = tabs.open(url, profile);
    const contents = opened[before];
    if (id === null || contents === undefined) throw new Error(`${url} did not open`);
    await settled(contents);
    return { id, contents };
  };
  const result: Record<string, unknown> = {
    blockedTab: tabs.open(`${B}/tab`, "agent"),
    ovisTab: tabs.open(`http://127.0.0.1:${ovisPort}/`, "mine"),
  };
  const unlisted = tabs.open(`${A}/slow`, "agent");
  result["listedBeforeCommit"] = tabs.list().length;
  if (unlisted !== null) tabs.close(unlisted);
  const page = await tab(`${A}/?token=secret`, "agent");
  result["listed"] = tabs.list().map(({ address, profile }) => ({ address, profile }));
  const before = opened.length;
  result["page"] = await page.contents.executeJavaScript("window.attacks()");
  result["popupTabs"] = opened.length - before;
  if (opened[before]) await new Promise<void>((done) => opened[before]!.isLoading() ? settled(opened[before]!).then(done) : done());
  // the main frame, as the app loads it and as the page does: straight there, and through a redirect
  const loads = async (url: string) => {
    const { contents } = await tab(`${A}/blank`, "mine");
    return contents.loadURL(url).then(() => contents.getURL(), (error: Error) => error.message.split(" ")[0]);
  };
  result["direct"] = await loads(`${B}/direct`);
  result["redirect"] = await loads(`${A}/redirect?to=${encodeURIComponent(`${B}/redirected`)}`);
  // a link the page follows: refused, the tab stays on its page; then one of its own site goes
  const clicked = await tab(`${A}/blank`, "mine");
  const failed = new Promise<string>((done) => session.fromPartition("persist:ovis-browser-mine").webRequest.onErrorOccurred({ urls: [`${B}/link`] }, (details) => done(details.error)));
  await clicked.contents.executeJavaScript(`location.href = ${JSON.stringify(`${B}/link`)}; true`);
  result["link"] = { error: await failed, url: clicked.contents.getURL() };
  const after = new Promise<void>((done) => clicked.contents.on("did-navigate", (_event, url) => { if (url.endsWith("/after")) done(); }));
  void clicked.contents.executeJavaScript(`location.href = ${JSON.stringify(`${A}/after`)}; true`).catch(() => {});
  await after;
  // first loads that end without a page (204) free their tab's place
  const listedBefore = tabs.list().length;
  const emptyIds: (number | null)[] = [];
  for (let n = 0; n < MAX_BROWSER_TABS; n++) {
    const id = tabs.open(`${A}/empty`, "mine");
    emptyIds.push(id);
    const contents = opened.at(-1)!;
    if (id !== null) await new Promise<void>((done) => contents.isDestroyed() ? done() : contents.once("destroyed", () => done()));
  }
  result["afterEmpty"] = { opened: emptyIds.every((id) => id !== null), listed: tabs.list().length - listedBefore };
  result["ownIp"] = await loads(`http://127.0.0.2:${ownPort}/own-ip`);
  result["ownName"] = await loads(`http://own.test:${ownPort}/own-name`);
  // a download past the size cap is cancelled, one below it is kept
  const downloadState = (url: string) => new Promise<string>((done) => {
    session.fromPartition("persist:ovis-browser-mine").once("will-download", (_event, item) => {
      // the guard's listener runs first, and may have cancelled the item already
      if (item.getState() !== "progressing") done(item.getState());
      else item.once("done", (_done, state) => done(state));
    });
    waitingTab.contents.downloadURL(url);
  });
  tabs.closeAll();
  const waitingTab = await tab(`${A}/blank`, "mine");
  result["bigDownload"] = await downloadState(`${A}/big`);
  result["smallDownload"] = await downloadState(`${A}/small`);
  result["results"] = tabs.results().map(({ kind, name, done, tab: from, profile }) => ({ kind, name, done, fromTab: from === waitingTab.id, profile }));
  result["resultPath"] = tabs.results().every(({ id, done }) => (tabs.resultPath(id) !== null) === done);
  // a site blocked while a request's name resolves: the request is decided again by the policy as it is then
  tabs.closeAll();
  const waiting = await tab(`${A}/blank`, "mine");
  const started = reached(`http://late.test:${port}/late`);
  const late = waiting.contents.loadURL(`http://late.test:${port}/late`).then(() => waiting.contents.getURL(), (error: Error) => error.message.split(" ")[0]);
  await started;
  tabs.setPolicy({ blocked: ["b.localhost", "late.test"], ovis: [{ host: "localhost", port: ovisPort }] });
  result["late"] = await late;
  tabs.setPolicy({ blocked: ["b.localhost"], ovis: [{ host: "localhost", port: ovisPort }] });
  tabs.closeAll();
  // a block that now refuses a tab's page closes that tab, and no more tabs than the limit open
  const kept = await tab(`${A}/kept`, "mine");
  tabs.setPolicy({ blocked: ["b.localhost", "a.localhost"], ovis: [{ host: "localhost", port: ovisPort }] });
  const listed = tabs.list().length;
  await new Promise<void>((done) => kept.contents.isDestroyed() ? done() : kept.contents.once("destroyed", () => done()));
  result["afterBlock"] = { listed, destroyed: kept.contents.isDestroyed() };
  tabs.setPolicy({ blocked: ["b.localhost"], ovis: [{ host: "localhost", port: ovisPort }] });
  const ids: (number | null)[] = [];
  for (let n = 0; n < MAX_BROWSER_TABS + 1; n++) ids.push(tabs.open(`${A}/many`, "mine"));
  result["overLimit"] = ids.at(-1);
  result["atLimit"] = ids.slice(0, MAX_BROWSER_TABS).every((id) => id !== null);
  // the agents' tabs have a limit of their own, which the person's full one leaves untouched
  const agentIds: (number | null)[] = [];
  for (let n = 0; n < MAX_BROWSER_TABS + 1; n++) agentIds.push(tabs.open(`${A}/many`, "agent"));
  result["agentLimit"] = { atLimit: agentIds.slice(0, MAX_BROWSER_TABS).every((id) => id !== null), over: agentIds.at(-1) };
  result["tabs"] = tabs.list().length;
  tabs.closeAll();
  result["afterClose"] = tabs.list().length;
  // the setting turned off and on: a new BrowserTabs over the same sessions, whose policy is the one requests meet
  const again = new BrowserTabs(() => window, { blocked: ["b.localhost", "c.localhost"], ovis: [{ host: "localhost", port: ovisPort }] }, join(app.getPath("userData"), "downloads"), () => {});
  const againId = again.open(`${A}/blank`, "mine");
  const againContents = opened.at(-1)!;
  if (againId === null) throw new Error("the tab after turning on again did not open");
  await settled(againContents);
  result["afterReenable"] = {
    fetch: await againContents.executeJavaScript(`fetch("http://c.localhost:${port}/c-fetch", { mode: "no-cors" }).then(() => "loaded", () => "refused")`),
    load: await againContents.loadURL(`http://c.localhost:${port}/c-load`).then(() => "loaded", (error: Error) => error.message.split(" ")[0]),
  };
  again.closeAll();
  console.log(`RESULT ${JSON.stringify(result)}`);
  app.quit();
}).catch((error: unknown) => {
  console.log(`RESULT ${JSON.stringify({ error: String(error) })}`);
  app.exit(1);
});
