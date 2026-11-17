import type { TailnetPcsOptions } from "./tailnet-pcs.ts";
import type { SshCandidatesOptions } from "./ssh-candidates.ts";
import "./adopt-legacy-env.ts";
import { claimServerState, machineEngine, machineFailure, machineHerdrBinary, machineSnapshot, machineSocket, machineSocketRefusal, machineUnauthorized, MACHINE_DIRECT_CARRIER_ENABLED, ownerSocketPath } from "./machine-profile.ts";
import { ProfileFolderError, profileFolderRefusal } from "./profile-marker.ts";
import { holdForLife, OwnerGuardBusy } from "./owner-guard.ts";
import { fleetPreview } from "./preview.ts";
import type { RelaySocket } from "../shared/relay-channel.ts";
import { createCore, type SocketData } from "./core/index.ts";
import { ClientConnectionLog } from "./client-connection-log.ts";
import { RequestLog } from "./request-log.ts";
import { RelayReceiptIds } from "./machine-relay.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { OrderSequence } from "./order-sequence.ts";
import { readHerdrProfiles, type HerdrMachineProfile } from "./herdr-profiles.ts";
import { accessSync, chmodSync, constants, mkdirSync, rmSync, statSync } from "node:fs";
import { version } from "../package.json";
import { dirname, join } from "node:path";
import type { PendingMessage, SessionSnapshot } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { isLoopbackBind, lanExposed } from "./access.ts";
import { DeviceStore, mergeAccountTombstones } from "./devices.ts";
import { PreferenceStore } from "./preferences.ts";
import { readOmpHeldFilesSetting } from "./omp.ts";
import { SeenStore } from "./seen.ts";
import type { SeenFinish } from "../shared/seen.ts";
import { TailnetIdentitySource } from "./tailscale.ts";
import { SHELL_AGENTS, ShellAgentLocator } from "./shell-agent.ts";
import { AgentDetector, catalogLocator, defaultLoginProbe } from "./agent-catalog-detect.ts";
import { InstalledLookup } from "./installed-lookup.ts";
import { agentCatalogFor } from "./agent-catalog-routes.ts";
import { AGENT_CATALOG, catalogPlatform } from "../shared/agent-catalog.ts";
import { AgentInstaller } from "./agent-catalog-install.ts";
import { type BackgroundAgentDeps } from "./background-agent.ts";
import { herdrSocketPath, ping } from "./herdr/client.ts";
import { coreConnection, coreSeenMarker, hcBin, hcMachine, NoAltRuntimeError, NoHerdrCoreError, runtime, setRuntime, startRuntime } from "./herdr-core/runtime.ts";
import { capabilities } from "./runtime/capabilities.ts";
import { chooseRuntime, runtimeService, type RuntimeChoice, type RuntimeService } from "./herdr-core/runtime-choice.ts";
import { moveService, type HcInstaller } from "./runtime-move-service.ts";
import { moveLockPath } from "./runtime-move-lock.ts";
import { bridgePins } from "./herdr-core/pin-label.ts";
import { herdrCoreFacts, rediscoverHc } from "./herdr-core/discovery.ts";
import { HC_RELEASE, hcInstallTarget, installHc } from "./herdr-core/install.ts";
import { userHome } from "./user-home.ts";
import { type HerdrCoreFacts, LOCAL_MACHINE } from "../shared/machines.ts";
import { type AlertTiming, defaultStateDir } from "./push.ts";
import { mergeSiblingState, siblingStateDir } from "./state-merge.ts";
import { moveLegacyStateDir } from "./update-state.ts";
import { sweepSshDirs } from "./ssh.ts";
import { OpenCodePromptState } from "./prompt.ts";
import { connectUpdater, type UpdateService } from "./update-api.ts";
import { HerdrUpdater } from "./herdr-update.ts";
import { PortalService } from "./portal.ts";
import { RelayService } from "./relay/service.ts";
import { AccountMailbox, accountServiceUrl, passAccountService } from "./account/mailbox.ts";
import { AccountHolds } from "./account/holds.ts";
import { AccountIntroductions } from "./account/introductions.ts";
import { Telemetry } from "./telemetry.ts";
import { UsageService } from "./usage.ts";
import { createSystemSampler, type SystemSampler } from "./system-stats.ts";
import { CLIProxyService } from "./cliproxy.ts";
import { CLIProxyRoutes } from "./cliproxy-routes.ts";
import { UsageLoginService } from "./usage-login.ts";
import { UsageAccountList } from "./usage-account-list.ts";
import { VoiceService } from "./voice.ts";
import { loopbackRelay, registerBridge, relayTarget } from "./bridge.ts";
import { PiSessionReader } from "./pi-session-metadata.ts";
import { HerdrSidebarConfig, herdrConfigPath, snapshotWithoutHiddenTokens } from "./herdr-sidebar.ts";
import { closeCodexDaemonSources } from "./codex-daemon.ts";
import { holdOpenCodeNative } from "./opencode-native.ts";
import { holdCommandHistory } from "./claude-command-history.ts";
import { holdFilePool } from "./file-pool.ts";
import { handleRequest, type RequestServices, type ServerContext } from "./dispatch.ts";
import { lanHttpsCertificate, lanHttpsConfig, privateLanAddresses, privateLanPeer, type LanHttpsConfig } from "./lan-https.ts";



export const SUBMIT_DELAY_MS = 120;
/**
 * herdr holds a lone ESC typed through the attach pty ~150ms (measured) to tell it from
 * an Alt+key: a composer message waits this long after the pane's last keystroke, so a
 * Stop tapped just before Send still reaches the pane first.
 */
export const TYPED_SETTLE_MS = 300;
export const KEY_SETTLE_MS = 40;
export const SUBMIT_DEADLINE_MS = 45_000;
const DRAFT_CLEAR_WAIT_MS = 1_500;
const DRAFT_CLEAR_POLL_MS = 50;


/**
 * What Bun.serve admits before a route runs (64 MiB). The ~55.9 MB body of a 40 MiB file is under it,
 * so the attachment route answers it with its JSON reason. The browser refuses a file over
 * MAX_ATTACHMENT_BYTES before it uploads (src/lib/api.ts), so only a non-browser client that sends
 * more than this can still see Bun's own empty 413.
 */
const BUN_BODY_CEILING = 64 * 1024 * 1024;

export function herdrCoreInstaller(): HcInstaller {
  return {
    offer: () => hcInstallTarget() !== null && herdrCoreFacts()?.version === null ? { version: HC_RELEASE.version } : null,
    install: async () => {
      const installed = await installHc({ home: userHome() });
      if ((await rediscoverHc()) === null) {
        installed.undo();
        throw new Error("herdr-core was installed, but Ovis does not find it; it was taken out again");
      }
    },
  };
}

export interface ServerInstance {
  readonly context: ServerContext;
  port: number;
  hostname: string;
  lanHttps: { port: number; addresses: readonly string[]; sha256: string } | null;
  statusReady: Promise<void>;
  focusReady: Promise<void>;
  alertsSettled: () => Promise<void>;
  warmAgentCatalog: () => void;
  queueFirstMessage: (paneId: string, text: string, kind: string, requester?: string | null, launchedPid?: number | null) => Promise<PendingMessage>;
  stop: () => void;
}

export function createServer(
  provided: {
    profile?: "machine";
    machineEngine?: string;
    machineRefusal?: () => string | null | Promise<string | null>;
    port?: number;
    hostname?: string;
    ipv6Loopback?: boolean;
    lanHttps?: LanHttpsConfig;
    token?: string;
    stateDir?: string;
    siblingStateDir?: string | null;
    tailscaleOwner?: string | null;
    tailscaleServeOnly?: boolean;
    tailnet?: TailnetIdentitySource;
    codexHome?: string;
    grokHome?: string;
    museData?: string;
    opencodeDb?: string;
    openCodeStateDir?: string;
    devinDbPath?: string;
    hermesHome?: string;
    updates?: UpdateService;
    herdrUpdate?: HerdrUpdater;
    herdrCoreFacts?: () => HerdrCoreFacts | undefined;
    runtimeService?: RuntimeService;
    herdrCoreInstaller?: HcInstaller;
    launchAccepted?: () => boolean;
    portal?: PortalService;
    relay?: RelayService;
    accountService?: { url: string; fetch?: (request: Request) => Promise<Response> };
    telemetry?: Telemetry;
    usage?: UsageService;
    system?: SystemSampler | null;
    cliProxy?: CLIProxyService;
    usageLogin?: UsageLoginService;
    voice?: VoiceService;
    machines?: boolean;
    relayPcSocket?: (url: string) => RelaySocket;
    relayPcDirectSocket?: (url: string) => RelaySocket;
    pcUpdateTimings?: { pollMs?: number; startMs?: number; checkMs?: number; offerMs?: number };
    tailnetPcs?: TailnetPcsOptions;
    sshCandidates?: SshCandidatesOptions;
    /** a bridge this app starts on a PC (server/remote-entry.ts): its token is the credential its connection server holds, and no browser reaches it, so its snapshots go whole (#2160) */
    bridgeOnly?: boolean;
    localFiles?: boolean;
    herdrProfiles?: () => Promise<HerdrMachineProfile[]>;
    herdrConfigPath?: string;
    registerBridge?: boolean;
    bridgeToken?: string;
    pluginActionWaitMs?: number;
    submitDeadlineMs?: number;
    submitDelayMs?: number;
    pendingStartTimeoutMs?: number;
    piReceiptLimit?: number;
    alertTiming?: Partial<AlertTiming>;
    pushLoopbackHttp?: boolean;
    desktopActivity?: boolean;
    backgroundWait?: { grace: number; limit: number };
    statusNow?: () => number;
    herdrIdentity?: () => string | null;
    attachRetryForMs?: number;
    attachHeldRetryMs?: number;
    attachRelookupForMs?: number;
    attachHoldMs?: number;
    piSessionDeadlineMs?: number;
    terminalAttach?: boolean | (() => Promise<boolean>);
    backgroundAgentRead?: BackgroundAgentDeps["read"];
    sidecar?: boolean | (() => boolean);
    shellAgents?: ShellAgentLocator;
    agentDetector?: AgentDetector;
  } = {},
): ServerInstance {
  const stateDir = provided.stateDir ?? defaultStateDir();
  if (provided.profile !== "machine") {
    const refusal = profileFolderRefusal(stateDir);
    if (refusal !== null) throw new ProfileFolderError(refusal);
  }
  const options = provided.profile === "machine" ? { ...provided,
    machineEngine: machineEngine(stateDir, provided.port ?? Number(process.env["PORT"] ?? 0)),
    token: "", hostname: "127.0.0.1", ipv6Loopback: false, lanHttps: undefined, portal: undefined,
    updates: undefined, herdrUpdate: undefined, herdrCoreInstaller: undefined, herdrCoreFacts: undefined, runtimeService: undefined,
    machines: false, bridgeOnly: false, localFiles: true, registerBridge: false, tailscaleServeOnly: false,
  } : provided;
  if (options.profile === "machine") {
    setRuntime("herdr");
    if (options.machineEngine !== "herdr" && options.machineRefusal === undefined) process.env["HERDR_SOCKET"] = join(stateDir, "unavailable", "herdr.sock");
  }
  const bootId = process.env["OVIS_BOOT_ID"] || randomUUID();
  const orderSequence = new OrderSequence(bootId);
  const hostname = options.hostname ?? process.env["HOST"] ?? "127.0.0.1";
  const ipv6Loopback = (options.ipv6Loopback ?? process.env["OVIS_IPV6_LOOPBACK"] === "1") && hostname === "127.0.0.1";
  /** Empty token = gate disabled; every route then behaves exactly as it did before auth existed. */
  const token = options.token ?? process.env["OVIS_TOKEN"] ?? "";
  /** paired devices (server/devices.ts) and the PC's Tailscale login: the two ways in besides the token and this PC itself */
  const ovisRelay = options.relay ?? new RelayService({ stateDir, accountService: passAccountService(options.accountService?.url), ...(options.accountService?.fetch ? { accountFetch: options.accountService.fetch } : {}) });
  const merge = options.siblingStateDir ? mergeSiblingState(stateDir, options.siblingStateDir) : null;
  let accountBlocked: string | null = null;
  if (options.siblingStateDir) {
    try { accountBlocked = mergeAccountTombstones(stateDir, options.siblingStateDir); }
    catch (error) { accountBlocked = `cannot merge the account tombstones of ${options.siblingStateDir}: ${error instanceof Error ? error.message : String(error)}`; }
    if (accountBlocked !== null) console.error(accountBlocked);
  }
  const devices = new DeviceStore(stateDir, merge?.devicesBlocked ?? null, accountBlocked);
  if (options.profile === "machine" && !devices.gated) devices.closeGate();
  const preferences = new PreferenceStore(stateDir);
  readOmpHeldFilesSetting(() => preferences.get().settings.ompHeldFiles === true);
  const stopPinBridge = capabilities().pins ? bridgePins(coreConnection(), preferences, LOCAL_MACHINE, stateDir) : null;
  try {
    rmSync(join(stateDir, "claude-rewinds.json"), { force: true });
  } catch (error) {
    console.error(`cannot remove the unused claude-rewinds.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const herdrSidebar = new HerdrSidebarConfig(options.herdrConfigPath ?? herdrConfigPath());
  const cliProxy = options.cliProxy ?? new CLIProxyService(stateDir);
  const cliProxyRoutes = new CLIProxyRoutes(cliProxy);
  const usageLogin = options.usageLogin ?? new UsageLoginService();
  usageLogin.persistTo(stateDir);
  const usage = options.usage ?? new UsageService(undefined, undefined, (refresh, skipped) => cliProxy.report(refresh, skipped));
  const usageAccounts = new UsageAccountList(stateDir, usage, () => cliProxy.hiddenChanged());
  const hiddenAccounts = (hidden: unknown): Set<string> => new Set(Array.isArray(hidden) ? hidden.filter((key): key is string => typeof key === "string") : []);
  let removedReadable = true;
  const skippedAccounts = () => {
    let removed: string[] = [];
    try { removed = usageAccounts.removed(); removedReadable = true; } catch { removedReadable = false; }
    return new Set([...hiddenAccounts(preferences.get().settings.usageHidden), ...removed]);
  };
  usage.skipAccounts(skippedAccounts);
  cliProxy.skipAccounts(skippedAccounts, () => removedReadable);
  let usageHidden = hiddenAccounts(preferences.get().settings.usageHidden);
  preferences.subscribe((next) => {
    const before = usageHidden;
    usageHidden = hiddenAccounts(next.settings.usageHidden);
    if (before.size !== usageHidden.size || [...before].some((key) => !usageHidden.has(key)) || cliProxy.hiddenUnsaved()) cliProxy.hiddenChanged();
    if (!next.settings.showUsage || ![...before].some((key) => !usageHidden.has(key))) return;
    usage.report().catch((error: unknown) => console.warn("usage: could not be read after the hidden accounts changed", error instanceof Error ? error.message : String(error)));
  });
  const systemSampler = options.system === undefined ? (hcMachine() === null ? createSystemSampler() : null) : options.system;
  usageLogin.onLoginEnded((account, provider) => {
    usage.invalidate(provider);
    if (account !== null) {
      try { usageAccounts.restore(account); }
      catch (error) { console.warn("Could not restore the signed-in account to Ovis", error instanceof Error ? error.message : String(error)); }
    }
  });
  const voice = options.voice ?? new VoiceService({ stateDir, env: process.env, fetch });
  const namedOwner = options.tailscaleOwner !== undefined ? options.tailscaleOwner : process.env["OVIS_TAILSCALE_OWNER"]?.trim() || undefined;
  const tailnet = options.tailnet ?? new TailnetIdentitySource();
  const identityOf = async (grantPath: boolean, host: string | null, loginPath = false) => {
    if (options.profile === "machine") return { owner: null, tagged: false, soleLogin: null, dnsName: null, tailnetIp: null };
    if (namedOwner !== undefined) return { ...(grantPath ? await tailnet.freshIdentity(host) : loginPath ? await tailnet.loginIdentity() : { soleLogin: null, dnsName: null, tailnetIp: null }), owner: namedOwner, tagged: false };
    return grantPath ? tailnet.freshIdentity(host) : loginPath ? tailnet.loginIdentity() : tailnet.identity();
  };
  const serveOnly = options.tailscaleServeOnly ?? process.env["OVIS_TAILSCALE_SERVE_ONLY"] === "1";
  /** what lets Portal open an address: this server's own values, never a request's */
  const portalGuards = () => ({ tokenSet: token !== "", serveOnly });

  const shellAgents = options.shellAgents ?? new ShellAgentLocator({ probe: null });
  const agentDetector = options.agentDetector ?? new AgentDetector({ locate: catalogLocator({ probe: null }) });
  const catalogPlatformHere = catalogPlatform(process.platform);
  const installFolder = (binary: string): { path: string; mark: string } | null => {
    const entry = AGENT_CATALOG.find((candidate) => candidate.detect.binaries.includes(binary));
    const dirs = entry !== undefined && catalogPlatformHere !== null ? entry.detect.install_dirs?.[catalogPlatformHere] ?? [] : [];
    const path = catalogPlatformHere === null ? null : agentDetector.inInstallFolder(binary, dirs, catalogPlatformHere);
    if (path === null) return null;
    try { return { path, mark: String(statSync(path).mtimeMs) }; } catch { return null; }
  };
  const herdrKinds = new InstalledLookup({ onPath: (binary) => agentDetector.onPath(binary), inInstallFolder: installFolder, refresh: (interactive) => agentDetector.refreshPath(interactive) });
  const shellKinds = new InstalledLookup({ onPath: (kind) => shellAgents.executable(kind), inInstallFolder: installFolder, refresh: (interactive) => shellAgents.refresh(interactive) });
  const agentOffered = async (kind: string): Promise<boolean> => {
    const entry = AGENT_CATALOG.find((candidate) => candidate.id === kind);
    for (const needed of entry?.detect.needs ?? []) if (!(await herdrKinds.has(needed))) return false;
    if (kind in SHELL_AGENTS) return shellKinds.has(kind);
    return herdrKinds.has(entry?.detect.binaries[0] ?? kind);
  };
  const agentInstaller = new AgentInstaller(agentDetector);
  const openCodeState = new OpenCodePromptState();
  const draftTimer = setInterval(() => openCodeState.prune(), 60_000);
  draftTimer.unref();
  // a snapshot as a browser is told it, wherever it goes: without the token values herdr's sidebar rows hide (#2160).
  // A bridge this app starts on a PC (`bridgeOnly`, server/remote-entry.ts) serves only its connection server, with
  // the credential it registered as its token: that server applies its own rows, so it gets every snapshot whole.
  const shownSnapshot = <S extends SessionSnapshot>(snapshot: S): S => options.bridgeOnly ? snapshot : snapshotWithoutHiddenTokens(herdrSidebar.get(), snapshot);
  const browserSnapshot = options.profile === "machine" ? <S extends SessionSnapshot>(snapshot: S): S => machineSnapshot(shownSnapshot(snapshot)) : shownSnapshot;
  const core = createCore({ options: { ...options, stateDir, openCodeState, orderSequence, ...(options.profile === "machine" ? { herdrFailure: machineFailure } : {}), serverId: () => ovisRelay.serverId(), seenMoved: (from, to, renumber) => seen.moved(LOCAL_MACHINE, from, to, renumber) }, devices, preferences, usage, usageLogin, browserSnapshot, TYPED_SETTLE_MS, KEY_SETTLE_MS, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS });
  const { machines, collector, queueFirstMessage, push } = core;
  const seen = new SeenStore(stateDir, (pc, epoch) => machines?.finishEnded(pc, epoch) ?? false);
  machines?.subscribe((event) => {
    if (event.type !== "machine-message" || event.machine_id === LOCAL_MACHINE || event.message.type !== "pane-moved") return;
    try { seen.moved(event.machine_id, event.message.from, event.message.to); }
    catch (error) { console.warn(`seen: could not carry the reads of ${event.message.from} to ${event.message.to}:`, error); }
  });
  const seenMarker = capabilities().seen === "label" ? coreSeenMarker() : null;
  const markSeen = (finish: SeenFinish, again: boolean) => {
    if (!seenMarker || finish.pc !== LOCAL_MACHINE || machines?.finishEnded(finish.pc, finish.epoch) !== false) return;
    const pane = machines.list().find((machine) => machine.id === LOCAL_MACHINE)?.snapshot?.panes.find((candidate) => candidate.pane_id === finish.pane);
    if (pane?.agent_status !== "done" || pane.finish_id !== finish.id) return;
    seenMarker.mark(finish.pane, again).catch((error: unknown) => console.warn(`herdr-core: could not mark ${finish.pane} seen:`, error));
  };
  if (seenMarker) {
    seen.subscribe((finish, presented) => { if (presented !== "new") markSeen(finish, false); });
    seen.onPresented((finish) => markSeen(finish, true));
  }
  // started after createCore's Node probe (server/pty/sidecar.ts), which can hold the thread up to 3 s: that wait
  // would count against the read's own 2.5 s limit, and a read cut short leaves the owner unknown for 5 minutes
  identityOf(false, null);
  const bridgeToken = options.bridgeToken ?? randomBytes(32).toString("hex");
  const piReader = new PiSessionReader({ deadlineMs: options.piSessionDeadlineMs });

  type PortalStartup = { ok: true } | { ok: false; error: unknown };
  let settlePortalStartup!: (result: PortalStartup) => void;
  let portalStartupResult: PortalStartup | undefined;
  const portalStartup = new Promise<PortalStartup>((resolve) => {
    settlePortalStartup = (result) => {
      if (portalStartupResult !== undefined) return;
      portalStartupResult = result;
      resolve(result);
    };
  });

  const envPort = process.env["PORT"];
  const clientConnectionLog = new ClientConnectionLog();
  const socketContext = (bunServer: Bun.Server<SocketData>): ServerContext => ({
    requestIP: (request) => bunServer.requestIP(request),
    timeout: (request, seconds) => { bunServer.timeout(request, seconds); },
    upgrade: (request, options) => bunServer.upgrade(request, options),
    get port() { return bunServer.port; },
    peer: { kind: "socket" },
    services,
  });
  const server = Bun.serve<SocketData>({
    port: options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    hostname,
    maxRequestBodySize: BUN_BODY_CEILING,

    fetch: (request, bunServer) => handleRequest(request, socketContext(bunServer)),

    websocket: core.websocket,
  });
  let ipv6: Bun.Server<SocketData> | null = null;
  if (ipv6Loopback) {
    try {
      ipv6 = Bun.serve<SocketData>({
        hostname: "::1", port: server.port, maxRequestBodySize: BUN_BODY_CEILING,
        fetch: (request, bunServer) => handleRequest(request, socketContext(bunServer)),
        websocket: core.websocket,
      });
    } catch (error) {
      server.stop(true);
      core.stop(() => clearInterval(draftTimer));
      piReader.close();
      throw error;
    }
  }
  // Bun gives a unix socket the umask's mode
  let ownerListener: Bun.Server<SocketData> | null = null;
  if (options.profile === "machine") {
    const path = ownerSocketPath(stateDir);
    const umask = process.umask(0o077);
    try {
      ownerListener = Bun.serve<SocketData>({
        unix: path, maxRequestBodySize: BUN_BODY_CEILING,
        fetch: (request, bunServer) => request.headers.has("host")
          ? handleRequest(request, { ...socketContext(bunServer), get port() { return server.port; }, ownerSocket: true })
          : machineUnauthorized(new URL(request.url, "http://localhost").pathname),
        websocket: core.websocket,
      });
      chmodSync(path, 0o600);
    } catch (error) {
      ownerListener?.stop(true);
      server.stop(true);
      core.stop(() => clearInterval(draftTimer));
      piReader.close();
      throw new Error(`The machine profile cannot serve its owner on ${path} (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))})`, { cause: error });
    } finally {
      process.umask(umask);
    }
  }

  const requestLog = new RequestLog(stateDir);
  const accountHolds = new AccountHolds({ enrollingPath: join(stateDir, "account-enrolling.json"), heldPath: join(stateDir, "account-held.json") });
  const accountMailbox = new AccountMailbox({
    pendingPath: join(stateDir, "account-pending.json"), holds: accountHolds,
    devices, identity: () => ovisRelay.currentIdentity(),
    service: (() => { try { return accountServiceUrl(options.accountService?.url); } catch (error) { return error instanceof Error ? error : new Error(String(error)); } })(), ...(options.accountService?.fetch ? { fetch: options.accountService.fetch } : {}),
  });
  const services: RequestServices = {
    runtimeMove: options.runtimeService ? moveService({
      stateDir, port: server.port ?? DEFAULT_PORT, serving: runtime, facts: () => options.runtimeService?.facts(),
      lock: { path: moveLockPath(herdrSocketPath()) },
      stores: { codexHome: options.codexHome, opencodeDb: options.opencodeDb, hermesHome: options.hermesHome, piReader },
      holdsPending: core.holdsPending,
      inputEmpty: core.inputEmpty,
      lane: core.serialize,
      settleAfterTyping: core.settleAfterTyping,
      accepted: () => options.launchAccepted?.() ?? true,
      switching: () => options.runtimeService?.switching?.() ?? false,
      switchRuntime: () => { const answer = options.runtimeService!.request("herdr-core"); return answer.ok ? null : answer.message; },
      ...(options.herdrCoreInstaller ? { installer: options.herdrCoreInstaller } : {}),
    }) : null,
    options, relay: ovisRelay, relayReceiptIds: new RelayReceiptIds(), hostname, token, bridgeToken, bootId, devices, accountMailbox, accountIntroductions: new AccountIntroductions(Date.now, join(stateDir, "account-introductions.json")), accountHolds, preferences, herdrSidebar, identityOf, serveOnly, portalGuards, shellAgents, agentDetector, agentOffered, agentInstaller, openCodeState, cliProxyRoutes, usageLogin, usage, usageAccounts, systemSampler, fontsDir: join(stateDir, "fonts"), voice, browserSnapshot, core, seen, piReader, orderSequence, clientConnectionLog, requestLog, portalStartup,
    get portalStartupResult() { return portalStartupResult; },
  };
  ovisRelay.resume(services, server.port ?? DEFAULT_PORT);
  accountMailbox.start();

  const lanListeners: Bun.Server<SocketData>[] = [];
  let lanHttps: ServerInstance["lanHttps"] = null;
  if (options.lanHttps) {
    const config = options.lanHttps;
    try {
      const addresses = config.host !== undefined ? [config.host] : privateLanAddresses();
      if (addresses.length === 0) throw new Error("this PC has no private IPv4 address to listen on; set OVIS_LAN_HTTPS_HOST");
      const certificate = lanHttpsCertificate(stateDir, config, config.host === "0.0.0.0" ? privateLanAddresses() : addresses);
      let port = config.port;
      for (const address of addresses) {
        const listener = Bun.serve<SocketData>({
          hostname: address, port, maxRequestBodySize: BUN_BODY_CEILING, tls: { cert: certificate.cert, key: certificate.key },
          fetch: (request, bunServer) => privateLanPeer(bunServer.requestIP(request)?.address)
            // the port is the main listener's: Portal and /api/access route plain http to it, never to this TLS one
            ? handleRequest(request, { ...socketContext(bunServer), get port() { return server.port; }, lanHttps: true })
            : new Response("forbidden", { status: 403 }),
          websocket: core.websocket,
        });
        lanListeners.push(listener);
        port = listener.port ?? port;
      }
      lanHttps = { port, addresses, sha256: certificate.sha256 };
    } catch (error) {
      for (const listener of lanListeners.splice(0)) listener.stop(true);
      console.error(`LAN HTTPS is off: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.portal) {
    // a Portal that ends on its own is started again only while this server's own token and serve-only allow it
    options.portal.authorize(portalGuards);
    let resume: Promise<void>;
    try {
      resume = options.portal.resume({ port: server.port ?? DEFAULT_PORT, ...portalGuards() });
    } catch (error) {
      resume = Promise.reject(error);
    }
    void resume.then(
      () => settlePortalStartup({ ok: true }),
      (error: unknown) => settlePortalStartup({ ok: false, error }),
    );
  } else {
    settlePortalStartup({ ok: true });
  }

  const target = options.registerBridge ? relayTarget(hostname) : null;
  const relay = target ? loopbackRelay(target, server.port ?? 0) : null;
  const registration = options.registerBridge ? registerBridge(relay?.port ?? server.port ?? 0, bridgeToken) : null;

  const releaseOpenCodeNative = holdOpenCodeNative();
  const releaseFilePool = holdFilePool();
  const releaseCommandHistory = holdCommandHistory();
  core.start();

  return {
    context: socketContext(server),
    port: server.port ?? 0,
    hostname,
    lanHttps,
    statusReady: Promise.all([collector.ready, collector.structureReady]).then(() => undefined),
    focusReady: collector.focusReady,
    queueFirstMessage,
    alertsSettled: () => push.settled(),
    warmAgentCatalog: () => {
      void agentCatalogFor(catalogPlatform(process.platform), agentDetector).catch((error: unknown) => {
        console.error(`agent catalog warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    stop: () => {
      services.runtimeMove?.stop();
      accountMailbox.stop();
      void ovisRelay.shutdown();
      settlePortalStartup({ ok: false, error: new Error("Server stopped before Portal startup cleanup completed") });
      core.stop(() => {
        clearInterval(draftTimer);
        openCodeState.clear();
        void options.portal?.shutdown();
        registration?.close();
        relay?.stop();
        closeCodexDaemonSources();
        releaseOpenCodeNative();
      });
      piReader.close();
      stopPinBridge?.stop();
      void usageLogin.stopAll();
      void shellAgents.stop();
      agentDetector.close();
      server.stop(true);
      ipv6?.stop(true);
      ownerListener?.stop(true);
      for (const listener of lanListeners) listener.stop(true);
      releaseFilePool();
      releaseCommandHistory();
      requestLog.close();
    },
  };
}

export async function serve(): Promise<void> {
  const profile = process.env["OVIS_PROFILE"] === "machine";
  if (profile && !fleetPreview()) {
    console.error("The machine profile is a preview and was not started; set OVIS_PREVIEW=fleet beside OVIS_PROFILE=machine to start it.");
    process.exit(1);
  }
  if (profile && process.platform === "win32") {
    console.error("The machine profile does not run on Windows, so no server was started.");
    process.exit(1);
  }
  let ownership: ReturnType<typeof claimServerState> | null = null;
  if (profile) {
    try { ownership = claimServerState(process.env["OVIS_STATE_DIR"]); }
    catch (err) {
      console.error(`${err instanceof Error ? err.message : String(err)}.`);
      process.exit(1);
    }
    process.once("exit", ownership.release);
    console.log(machineHerdrBinary());
    if (process.env["OVIS_TOKEN"]) console.log(`OVIS_TOKEN is not used by the machine profile: this account's programs reach it on ${ownership.socket}, and its port tells anyone only that it is alive.`);
  } else {
    const refusal = profileFolderRefusal(defaultStateDir());
    if (refusal !== null) {
      console.error(refusal);
      process.exit(1);
    }
  }
  moveLegacyStateDir();
  if (!profile) void sweepSshDirs();
  const stateDir = ownership?.stateDir ?? defaultStateDir();
  if (!profile && fleetPreview() && process.platform !== "win32") {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      holdForLife(join(stateDir, "serve.own"), "shared");
    } catch (err) {
      if (err instanceof OwnerGuardBusy) {
        console.error(`A machine profile serves the Ovis state folder ${stateDir}, so no server was started; give this one another OVIS_STATE_DIR.`);
        process.exit(1);
      }
      console.error(`The state folder's hold could not be taken, so a machine profile could start on it beside this server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let launchAccepted = process.env["OVIS_MANAGED"] !== "1";
  process.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && (message as { type?: unknown }).type === "bridge-accepted") launchAccepted = true;
  });
  const startEnv = { ...process.env };
  let herdrCore: Awaited<ReturnType<typeof startRuntime>>;
  let choice: RuntimeChoice;
  let fallback: "no_herdr_core" | "no_alt_runtime" | undefined;
  let machineRefusal: () => string | null | Promise<string | null> = () => null;
  try {
    if (profile) {
      const engine = machineEngine(stateDir, Number(startEnv["PORT"] ?? 0));
      const refusal = await machineSocket(stateDir, engine);
      machineRefusal = machineSocketRefusal;
      setRuntime("herdr");
      choice = { runtime: "herdr", source: "env", reason: "machine profile" };
      herdrCore = null;
      console.log(`Machine engine: ${engine}${refusal ? ` (${refusal})` : ""}`);
    } else {
      choice = await chooseRuntime({ stateDir, port: Number(startEnv["PORT"] || DEFAULT_PORT), env: startEnv });
      setRuntime(choice.runtime);
      console.log(`Runtime: ${choice.runtime} (${choice.reason})`);
      try {
        herdrCore = await startRuntime(stateDir);
      } catch (err) {
        const missing = choice.runtime === "herdr-core" && err instanceof NoHerdrCoreError ? "no_herdr_core"
          : choice.runtime === "alt-runtime" && err instanceof NoAltRuntimeError ? "no_alt_runtime" : null;
        if (choice.source !== "saved" || missing === null) throw err;
        console.error(`The ${choice.runtime} chosen in Settings cannot start (${err instanceof Error ? err.message : String(err)}); serving herdr.`);
        choice = { ...choice, runtime: "herdr" };
        fallback = missing;
        setRuntime("herdr");
        herdrCore = null;
      }
    }
  } catch (err) {
    console.error(`Ovis cannot start: ${err instanceof Error ? err.message : String(err)}.`);
    process.exit(1);
  }
  const updates = connectUpdater();
  const telemetry = new Telemetry({ stateDir, version, env: process.env, fetch, previousVersion: () => updates.installed().previous_version, runtime: herdrCore === null ? "herdr" : "herdr-core" });
  const portal = profile ? undefined : new PortalService({ stateDir });
  const tailnet = new TailnetIdentitySource();
  const relay = new RelayService({ stateDir, ...(profile && !MACHINE_DIRECT_CARRIER_ENABLED ? {} : { direct: { tailnetIp: () => tailnet.identity().tailnetIp } }), accountService: passAccountService() });
  const lanConfig = profile ? null : lanHttpsConfig(process.env);
  if (lanConfig !== null && "error" in lanConfig) console.error(`LAN HTTPS is off: ${lanConfig.error}.`);
  let instance: ReturnType<typeof createServer>;
  try {
    instance = createServer({ updates, ...(profile ? { profile: "machine", machineRefusal, port: Number(startEnv["PORT"] ?? 0) } : { herdrUpdate: new HerdrUpdater(), herdrCoreFacts, herdrCoreInstaller: herdrCoreInstaller(),
      launchAccepted: () => launchAccepted,
      runtimeService: runtimeService({ stateDir, port: Number(startEnv["PORT"] || DEFAULT_PORT), serving: choice.runtime, source: choice.source, ...(fallback ? { fallback } : {}), env: startEnv, core: herdrCoreFacts, accepted: () => launchAccepted, restart: (id) => process.send?.({ type: "runtime-restart", id }) }) }),
      portal, relay, tailnet, telemetry, registerBridge: true, herdrProfiles: readHerdrProfiles, shellAgents: new ShellAgentLocator(), agentDetector: new AgentDetector({ locate: catalogLocator({ probe: defaultLoginProbe() }) }), stateDir, siblingStateDir: siblingStateDir(stateDir),
      desktopActivity: process.env["OVIS_DESKTOP_APP"] === "1",
      ...(lanConfig !== null && !("error" in lanConfig) ? { lanHttps: lanConfig } : {}) });
    ownership?.listening(instance.port, instance.hostname);
    if (profile) {
      const unreachable = instance.context.services.devices.list(null).filter((device) => !device.via_relay).map((device) => device.id);
      if (unreachable.length > 0) console.log(`Devices paired at this machine's own address cannot reach it, only devices through the relay can: ${unreachable.join(", ")}`);
    }
    instance.warmAgentCatalog();
  } catch (err) {
    if (err instanceof ProfileFolderError) {
      console.error(err.message);
      process.exit(1);
    }
    const { code, syscall } = err as { code?: string; syscall?: string };
    if (syscall !== "listen" || (code !== "EADDRINUSE" && code !== "EADDRNOTAVAIL" && code !== "EACCES")) {
      if (profile && err instanceof Error && err.message.startsWith("The machine profile cannot serve its owner")) {
        console.error(`${err.message}.`);
        process.exit(1);
      }
      throw err;
    }
    const host = process.env["HOST"] ?? "127.0.0.1";
    const port = process.env["PORT"] || DEFAULT_PORT;
    const reason = code === "EADDRINUSE"
      ? `the port is in use. Another app (or Ovis) may already use it; start with another PORT=, or open http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port} if it is this app`
      : code === "EADDRNOTAVAIL"
        ? "this PC has no such address; try HOST=127.0.0.1"
        : "the port needs permission; try a PORT above 1024";
    console.error(`Ovis cannot listen on ${host}:${port}: ${reason}.`);
    herdrCore?.stop();
    process.exit(1);
  }
  telemetry.start();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    telemetry.stop();
    instance.stop();
    // Attach sidecars need ~1.2s to release herdr's exclusive client slot
    void Promise.all([Bun.sleep(2000), portal?.shutdown(), relay.shutdown()]).then(() => {
      herdrCore?.stop();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (process.env["OVIS_MANAGED"] === "1") process.on("disconnect", shutdown);
  console.log(`Ovis listening on http://${instance.hostname}:${instance.port}`);
  if (instance.lanHttps) {
    const { port, addresses, sha256 } = instance.lanHttps;
    const shown = addresses.includes("0.0.0.0") ? privateLanAddresses() : addresses;
    console.log(`LAN HTTPS on ${shown.map((address) => `https://${address}:${port}`).join(", ")} (token or paired device only; certificate SHA-256 ${sha256})`);
  }
  const socket = herdrSocketPath();
  if (!profile) void ping(socket).catch(() => {
    console.error(herdrCore
      ? `herdr-core is not reachable through ${socket}: start it with \`${hcBin()} server start\`, or set OVIS_HC_BIN to hc's full path.`
      : `herdr is not reachable at ${socket}: start herdr, or set HERDR_SOCKET to its socket (named sessions: ~/.config/herdr/sessions/<name>/herdr.sock).`);
  });
  let probe = stateDir;
  while (true) {
    try {
      accessSync(probe, constants.F_OK);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  try {
    accessSync(probe, constants.W_OK);
  } catch {
    console.error(`cannot write ${stateDir}: settings, devices and updates will not be saved; fix its permissions or set OVIS_STATE_DIR.`);
  }
  if (!isLoopbackBind(instance.hostname)) {
    if (lanExposed({ hostname: instance.hostname, tokenConfigured: (process.env["OVIS_TOKEN"] ?? "") !== "", gated: false })) {
      console.error(
        `WARNING: listening on ${instance.hostname} without OVIS_TOKEN - until a device is paired (Settings → Devices, on this PC) anyone who can reach this address can type into your terminals; pair your devices, set OVIS_TOKEN=<token>, or keep HOST=127.0.0.1 and reach it through Tailscale or an SSH tunnel.`,
      );
    }
    if ((process.env["OVIS_TOKEN"] ?? "") !== "") {
      console.error(
        `WARNING: listening on http://${instance.hostname}:${instance.port} - OVIS_TOKEN is not confidential over cleartext http; on an untrusted network anyone who can read the traffic has the token and everything you type. Reach this PC over Tailscale, put it behind a TLS-terminating proxy, or keep HOST=127.0.0.1.`,
      );
    }
  }
}

if (import.meta.main) await serve();
