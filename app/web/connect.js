// The connect screen: the app's first page until a PC is chosen. Opening a PC goes through the
// native HerdrShell plugin, which makes the PC's address the WebView's first page: navigating
// there from this page would cost every launch about 1.5 s (docs/native-app.md, Spike results).
import { parseAddress, shell } from "./shell.js";

const form = document.getElementById("connect");
const input = document.getElementById("address");
const error = document.getElementById("error");

async function open(text) {
  const url = parseAddress(text);
  if (url === null) { error.textContent = "That is not an http or https address."; input.focus(); return; }
  error.textContent = "";
  try { await shell("open", { url: url.href }); }
  catch (err) { error.textContent = String(err?.message ?? err); }
}

form.addEventListener("submit", (event) => { event.preventDefault(); void open(input.value); });

document.getElementById("scan").addEventListener("click", async () => {
  error.textContent = "";
  try {
    // the plugin's own JS fills these defaults; this page calls the bridge without it
    const result = await window.Capacitor.nativePromise("CapacitorBarcodeScanner", "scanBarcode", { hint: 0, scanInstructions: "Point at the QR code under Settings → Phone & devices on your PC", scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 });
    if (result?.ScanResult) await open(result.ScanResult);
  } catch (err) {
    error.textContent = String(err?.message ?? err);
  }
});

function renderSaved(saved, current) {
  const list = document.getElementById("saved");
  list.replaceChildren();
  for (const origin of saved) {
    const item = document.createElement("li");
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "open";
    openButton.textContent = origin === current ? `${origin} (last opened)` : origin;
    openButton.addEventListener("click", () => void open(origin));
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "forget";
    forget.textContent = "Forget";
    forget.setAttribute("aria-label", `Forget ${origin}`);
    forget.addEventListener("click", async () => { await shell("forget", { url: origin }); await load(); });
    item.append(openButton, forget);
    list.append(item);
  }
  document.getElementById("saved-section").hidden = saved.length === 0;
}

async function load() {
  const state = await shell("getState");
  renderSaved(state.saved ?? [], state.last ?? "");
}

void load();
