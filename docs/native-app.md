# Native app plan

Status: Phase 1 step 2 built and checked in a simulator (2026-10-19). Branch `feat/native-app`.
To run it, see [The app (app/)](#the-app-app).

herdr-web-ui ships as a store app for iOS first, Android later. The goal is reach: the app is
found in the App Store and installs in one tap, where the web app needs "Add to Home Screen". It
also opens the door to features a home-screen web app cannot have.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Stack | Capacitor | The UI stays the one React client. iOS terminal apps built in Swift or React Native (Blink, Hermit, PocketTunnel, Fressh) still draw the terminal in a WebView, so a rewrite would not change the core. React Native would rewrite every screen. |
| Where the code lives | `app/` in this repo | The app and the web client change together. App builds are not a required check. |
| Who serves the UI | The PC, as today | The UI and the server ship together, so they never disagree on the wire contract. The app holds only the native shell, the connect screen and the demo. |
| Notifications | In the first release, through an APNs relay | A WKWebView app gets no Web Push, so the app needs Apple's push service, and only a key held by the project can sign for it. |
| Notification privacy | End-to-end encrypted | The relay only forwards what it cannot read, as the telemetry Worker never reads what it does not need. |
| Builds | Xcode on the macbook | See the iOS QA notes; Capacitor needs a Mac for iOS. |

## How it fits

```
PC: herdr-web-ui server ──UI, API, WebSocket──▶ app WebView (the same client as the browser)
PC: server/push.ts ──encrypted push──▶ relay (Cloudflare Worker) ──▶ APNs ──▶ app
```

### The app

- A native connect screen: scan the pairing QR or type the address, then load the PC's UI in the
  WebView. Pairing works as in a browser: the device keeps its HttpOnly cookie in the WebView's
  persistent store.
- A demo mode built from `site/demo`, for someone with no PC set up yet and for App Review,
  whose reviewers have no herdr PC.
- Native pieces the web client reaches through the Capacitor bridge: push registration first,
  then haptics, share, Face ID as needed.

### Notifications

The relay looks to `server/push.ts` like one more browser push service, so the PC keeps its
whole alert policy (the wait before an alert, no alert while a window is in use, per-device
choices) and changes little:

1. The app registers with APNs and gets a device token.
2. The app sends the token to the relay, which returns an endpoint URL holding an opaque ID for
   that token (`https://<relay>/v1/push/<id>`). The token itself never leaves the relay.
3. The app makes a P-256 key pair and an auth secret, keeps the private half in the keychain
   shared with its Notification Service Extension, and hands `{ endpoint, keys }` to the web
   client, which subscribes with it in place of `pushManager.subscribe`.
4. The PC encrypts each alert for those keys (RFC 8291, as today) and signs it with its VAPID key
   (RFC 8292). The relay pins the first VAPID key that pushes to an endpoint and refuses others,
   so knowing an endpoint is not enough to send to a phone. It also rate-limits per endpoint.
5. The relay wraps the ciphertext in a `mutable-content` APNs push. The Notification Service
   Extension (a small Swift target) decrypts it and shows the title and body. A push it cannot
   decrypt shows a generic "herdr needs you" line.
6. APNs telling the relay a token is gone becomes a 410 to the PC, which already deletes a gone
   subscription.

The relay's code lives in this repo next to `telemetry/`, open so anyone can run their own, and
keeps no logs, like the telemetry Worker. Its APNs key is a secret of the project's Cloudflare
account. Android (FCM) gets a second route in the same Worker later.

## Phase 1: first store release

1. Spike on the macbook: does a page loaded from the PC's address get the Capacitor bridge?
   Done 2026-10-19, see [Spike results](#spike-results-2026-10-19): it does, and the PC's
   page must be the WebView's first page, not one a bundled page navigates to.
2. `app/`: Capacitor project, connect screen, QR scan, demo mode. Built 2026-10-19, see
   [The app (app/)](#the-app-app). QR scanning still needs a physical iPhone (the simulator
   has no camera).
3. Relay Worker with tests (VAPID pinning, rate limit, gone tokens).
4. `src/lib/push.ts`: subscribe through the native bridge inside the app.
5. Notification Service Extension that decrypts.
6. App Store listing, privacy answers, review notes pointing at the demo mode.

## Phase 2 and later

- Live Activity for a running agent, home-screen widgets (both need Swift, and pushes through
  the same relay).
- Android build and the FCM route.
- Speed: measure what is slow before changing anything; bundling the UI in the app is off the
  table while the PC serves it.

## Spike results (2026-10-19)

Run on the EA MacBook (macOS 27.0.1, Xcode 27.0) in an iPhone 18 Pro Simulator on iOS 27.0, with
Capacitor 8.5.3 and `@capacitor/device` 8.0.3, in a throwaway app outside the repo. The page
under test was the demo build of the client (`bun scripts/demo-build.ts`), served from this PC's
Tailscale address over `http`, and over `https` through `tailscale serve`. Each page posted its
own measurements back to that server. Times are simulator runs, not a phone.

- **The bridge reaches the PC's page.** It works for a page the bundled page reached with
  `location.replace` (its host listed in `server.allowNavigation`) and for a page set as
  `server.url`, over `http` and `https`. In both cases `Capacitor.isNativePlatform()` was true
  and `Device.getInfo()` answered. The spike allowed plain `http://` with `NSAllowsArbitraryLoads`.
  The app allows it with the narrower `NSAllowsArbitraryLoadsInWebContent` and
  `NSAllowsLocalNetworking`.
- **The app has no service worker.** In the app's WKWebView, `navigator.serviceWorker` is missing
  even on `https`, where `isSecureContext` is true. Safari on the same simulator registers one at
  the same URL. The worker does register once `ios.limitsNavigationsToAppBoundDomains` is set and
  the host is listed in `WKAppBoundDomains`. But then a host missing from that Info.plist list
  (10 at most) does not load at all: the Tailscale IP gave a blank view. Users' PC addresses are
  not known at build time, so the app runs without the worker.
- **Navigating from the bundled page costs about 1.5 s.** The PC's page loaded quickly, but its
  first script ran 1487-1514 ms after navigation start, against 42 ms in Safari. This happened
  in Debug and Release builds alike, and JavaScript speed was the same in both. Loaded as the
  WebView's first page (`server.url`), the same page ran its first script at 51-62 ms.

| Real client, from launch | First paint in the page | Launch to painted client |
|---|---|---|
| App, PC page as the first page (`server.url`) | 262-304 ms | 4.7-4.8 s |
| Safari | 284-336 ms | 4.9-5.3 s |
| App, bundled page navigating to the PC | 1629-2044 ms | 6.6-7.5 s |

The simulator starting the app or Safari takes most of the launch time. No run, Safari's
included, had the client's service worker in control, so the table compares page loads with
the browser's HTTP cache only.

What this changes:

- The connect screen must not reach the PC by navigating from JavaScript. It saves the address
  natively, and the app opens it as the WebView's first page. Capacitor 8.5.3 leaves room for
  that: `CAPBridgeViewController.instanceDescriptor()` is `open`, and the descriptor's `serverURL`
  is what `server.url` sets. A subclass can fill it from the saved address. This is the same
  path `server.url` takes, so the "live reload only" warning is about a URL fixed at build time.
  `app/` builds that subclass (see [The app (app/)](#the-app-app)).
- Inside the app the client has no service worker: no offline shell, and push only through the
  native route. `src/pwa.ts` and `src/lib/push.ts` already check for `navigator.serviceWorker`
  (`pushSupported()`), so the client runs without it. Step 4 adds the native route beside them.
- Not tested in the spike: keyboard and IME in the app, and a physical iPhone. The pairing
  cookie surviving a restart was checked later, with `app/`.

To repeat it:

1. Build the demo client into a directory.
2. Serve it from a small Bun server on the Tailscale IP, plus a loopback port behind
   `tailscale serve --bg --https=<port>`.
3. Make the app with `npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/device`,
   `npx cap add ios`, then build and install it with `xcodebuild -sdk iphonesimulator` and
   `xcrun simctl install`.
4. Launch with `xcrun simctl launch` (Safari: `xcrun simctl openurl`) after recording the Mac's
   clock. The page reports `Date.now()` and its navigation timing once `#root` has painted.

## The app (app/)

What is there:

- `app/web`: the app's own pages. `index.html` is the connect screen: an address field, Scan QR
  code, the PCs opened before, and Try the demo. `error.html` is shown when a PC cannot be
  reached, with Try again and Change PC. They are in English only for now.
- `app/scripts/build-web.ts` (`bun run build:web` in `app/`) puts those pages and the demo,
  built from this checkout's client, into `app/www` for Capacitor to copy.
- `app/ios/App/App/HerdrBridgeViewController.swift`: a Capacitor view controller that opens the
  chosen PC as the WebView's first page (`instanceDescriptor().serverURL`). It also lets the
  PC's whole host stay in the app and shows `error.html` when the first load fails. The
  `HerdrShell` plugin (`HerdrShellPlugin.swift`) opens, forgets and leaves PCs. Opening or
  leaving one builds a fresh view controller, so the next page is again a first load.
- In the client, `src/lib/nativeApp.ts` notices the app through `window.Capacitor`, as the app
  injects it; the browser build carries no Capacitor code. Inside the app:
  - Settings → Phone & devices has a Change PC row, and so does the pairing screen (a PC that
    asks for pairing would otherwise leave the app no way out).
  - The app counts as installed, so Install app is not offered.
- The bundle ID is `dev.herdr.app` and the name is herdr, both placeholders until the store
  listing.

Build and run it on a Mac with Xcode:

```bash
bun install                 # in the repo: the demo build needs the client's packages
cd app && bun install
bun run sync                # build:web, then cap sync ios
bun run open                # opens ios/App/App.xcodeproj in Xcode
```

In Xcode, pick a simulator and press Run. For a physical iPhone:

1. Under the App target → Signing & Capabilities, choose your team. Change the bundle ID if
   Xcode says it is taken.
2. Connect the iPhone, or pair it over Wi-Fi under Window → Devices and Simulators. Turn on
   Developer Mode on the phone when it asks, then pick it as the run destination and press Run.

What was checked on 2026-10-19 (iPhone 18 Pro Simulator, iOS 27.0, a Debug build), against a
server on an isolated herdr session:

- The first launch shows the connect screen. Opening the server's address loads the client as
  a first load (Capacitor logs "Loading app at http://…").
- With the server's gate closed, a pairing link (`…/?pair=CODE`, what the PC's QR code holds)
  typed into the connect screen paired the app; the PC listed it as a device. After the app was
  quit and started again, it opened the client without asking again.
- Settings → Phone & devices shows Change PC only in the app; a desktop browser at the same
  address does not have it. Change PC, from Settings, the pairing screen or the demo, goes back
  to the connect screen with the PCs kept.
- Try the demo opens the bundled demo with no server.
- A closed port shows `error.html` with the system's reason ("서버에 연결할 수 없습니다.").

The simulator had no touch input from a script: the Mac's Accessibility access is not granted
to ssh, and Homebrew refuses idb's tap. The checks drove the pages through Web Inspector
instead: `ios_webkit_debug_proxy` on the simulator's `webinspectord_sim.socket`, then
`Runtime.evaluate` through WebKit's `Target.sendMessageToTarget`. Buttons were clicked and forms
submitted from JavaScript. A QA server must be pointed at a test herdr session on purpose.
`bun run check run … bun run server` is not enough: check.ts drops `HERDR_SOCKET` for its
tests, and the server then falls back to the default session, the user's. Preloading
`scripts/test-herdr.ts` (`bun --preload <file that imports it> server/index.ts`, with
`HERDR_TEST_SESSION` and `HERDR_WEB_STATE_DIR` set) gives the server the test session.

Still open:

- **A plain `http://` PC loads about 1.5-2 s slower in the app than an `https` one.** In the
  app, the client's first script ran 1429-2075 ms after navigation start over
  `http://<tailscale ip>`. Over `https` through `tailscale serve` it ran at 39-51 ms, and Safari
  on the same `http` address took 100 ms. The cause is not App Transport Security
  (`NSAllowsArbitraryLoads` changed nothing) and not WebKit's https-first upgrade (turning it
  off changed nothing either). It happens whether the PC opens at launch or from the connect
  screen. The connect screen suggests https meanwhile.
- Each Change PC leaves one blank web view behind: the old page is unloaded, so nothing stays
  connected to the PC, but Capacitor's bridge keeps the view itself.
- An address that failed still joins the list of PCs.
- Not tried: QR scanning (needs a camera), keyboard and IME in the app, a physical iPhone,
  Release signing.

## Risks and open questions

- App Review guideline 4.2 (a web wrapper): the native connect flow, push and the demo mode are
  the answer. Expect at least one round trip.
- Capacitor documents `server.url` as meant for live reload, not production. The spike found
  that a loader page costs about 1.5 s per launch, so the app sets the same `serverURL` at
  runtime through a `CAPBridgeViewController` subclass instead (`app/`).
- WKWebView keyboard and IME behaviour can differ from Safari's; the iOS keyboard regressions
  need a run inside the app.
- A plain `http://` PC address (LAN or a Tailscale IP without `tailscale serve`) needs an App
  Transport Security exception that review must accept. `https` through `tailscale serve` needs
  none.
- Several PCs: the app should list them, as the remote PCs feature does in the browser.
- Not decided: the relay's domain, the bundle ID and the app's store name.
- The macbook is shared with other sessions (a ChatGPT CUA was running on 2026-10-18): check it
  is free before booting a simulator there.
