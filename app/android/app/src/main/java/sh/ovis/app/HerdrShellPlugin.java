package sh.ovis.app;

import android.Manifest;
import com.getcapacitor.JSArray;
import com.getcapacitor.PermissionState;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "HerdrShell", permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) })
public class HerdrShellPlugin extends Plugin {
    private final PCStore.Openings openings = new PCStore.Openings();
    @PluginMethod
    public void getState(PluginCall call) {
        JSObject state = new JSObject();
        state.put("saved", new JSArray(PCStore.saved(getContext())));
        state.put("names", PCStore.names(getContext()));
        String current = PCStore.current(getContext());
        String last = PCStore.last(getContext());
        state.put("name", last == null ? "" : PCStore.names(getContext()).optString(last, ""));
        state.put("current", current == null ? "" : current);
        state.put("last", last == null ? "" : last);
        state.put("choosing", PCStore.choosing && current != null);
        state.put("failure", PCStore.failure == null ? "" : PCStore.failure);
        state.put("kind", PCStore.failureKind == null ? "" : PCStore.failureKind);
        state.put("command", PCStore.failureCommand == null ? "" : PCStore.failureCommand);
        call.resolve(state);
    }

    /** url: an http or https address, the first page (a pairing link's code or a relay pairing offer's fragment included). */
    @PluginMethod
    public void open(PluginCall call) {
        String text = call.getString("url");
        String key = text == null ? null : PCStore.origin(text);
        if (key == null) {
            call.reject("That is not an http or https address.");
            return;
        }
        if (SshPcs.otherLoopbackPort(text)) {
            call.reject("That address on this phone is kept for PCs added over SSH. Open the PC from Your PCs.");
            return;
        }
        String scope = call.getString("scope");
        if (scope != null) {
            key = PCStore.scopeKey(scope, text);
            if (key == null) {
                call.reject("That relay link is not within its PC's scope.");
                return;
            }
        }
        String name = call.getString("name");
        int mine = openings.start();
        if (!Boolean.TRUE.equals(call.getBoolean("check", false))) {
            openChecked(call, key, text, name, mine, 0);
            return;
        }
        String pc = key;
        String cookies = android.webkit.CookieManager.getInstance().getCookie(PCStore.origin(text));
        long answerBy = android.os.SystemClock.elapsedRealtime() + PCStore.ANSWER_SECONDS * 1000L;
        new Thread(() -> {
            PCStore.Check found = PCStore.check(text, cookies, PCStore.ANSWER_SECONDS * 1000L);
            if (found.opens()) openChecked(call, pc, text, name, mine, answerBy);
            else call.reject(found.detail == null ? found.kind : found.detail, found.kind);
        }, "ovis-check").start();
    }

    private void openChecked(PluginCall call, String key, String text, String name, int mine, long answerBy) {
        synchronized (openings) {
            android.app.Activity activity = getActivity();
            if (!openings.current(mine) || activity == null || activity.isFinishing() || activity.isDestroyed()) {
                call.reject("Cancelled", "cancelled");
                return;
            }
            if (name != null && !name.isEmpty()) PCStore.setName(getContext(), key, name.length() > 64 ? name.substring(0, 64) : name);
            PCStore.open(getContext(), key, text);
            PCStore.fail(null, null);
            PCStore.redirects = 0;
            PCStore.answerBy = answerBy;
        }
        call.resolve();
        android.app.Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            synchronized (openings) {
                if (!openings.current(mine)) {
                    PCStore.setCurrent(getContext(), null);
                    PCStore.answerBy = 0;
                    return;
                }
            }
            ((MainActivity) activity).reopen();
        });
    }

    @PluginMethod
    public void cancelOpen(PluginCall call) {
        openings.cancel();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        openings.cancel();
        super.handleOnDestroy();
    }

    private boolean showingConnectScreen() {
        return getBridge().getServerUrl() == null;
    }

    /**
     * A PC's page has the bridge too: an activity showing a PC (its
     * server URL is the PC's) never hands the link out, as it may hold another PC's pairing code.
     */
    @PluginMethod
    public void takeLink(PluginCall call) {
        String link = null;
        if (showingConnectScreen()) {
            link = PCStore.link;
            PCStore.link = null;
        }
        JSObject result = new JSObject();
        result.put("url", link == null ? "" : link);
        call.resolve(result);
    }

    /** For the connect screen's Tailscale tab: `on`, Tailscale's VPN is up on this phone (Tailnet.on). */
    @PluginMethod
    public void tailscale(PluginCall call) {
        JSObject result = new JSObject();
        result.put("on", Tailnet.on());
        call.resolve(result);
    }

    /** Opens the Tailscale app to turn it on, or its store page when it is not installed (the manifest's queries). */
    @PluginMethod
    public void openTailscale(PluginCall call) {
        android.content.Intent open = getContext().getPackageManager().getLaunchIntentForPackage(Tailnet.PACKAGE);
        if (open == null) {
            open = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://play.google.com/store/apps/details?id=" + Tailnet.PACKAGE));
        }
        try {
            getActivity().startActivity(open);
            call.resolve();
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("Tailscale could not be opened on this phone.");
        }
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String key = call.getString("url");
        // an SSH PC forgotten takes its sealed key and host key with it (OvisSshPlugin.forgetRemoved): only the app's
        // own pages do that, never a PC's page, which has this bridge too
        if (key != null && getBridge().getServerUrl() != null && SshPcs.on(getContext()).get(key) != null) {
            call.reject("Only the app's own pages manage SSH PCs.");
            return;
        }
        if (key != null) PCStore.forget(getContext(), key);
        call.resolve();
    }

    /**
     * From any page of the app, a PC's (the hosted app's) included: the app's own connect screen, on Direct with
     * `target` (an SSH login, user@host[:port], or empty) in its field. Nothing is added here, and no PC page is given
     * OvisSsh: the connect screen, an app page, takes the login to the SSH setup screen, where the person adds the PC.
     */
    @PluginMethod
    public void openSshSetup(PluginCall call) {
        // only the connect screen and the hosted app (Add a PC's SSH): a PC's own page may not drop the person off it
        // to stage a login of its choosing
        // the page loaded now, not the one the app last chose: the WebView may have gone elsewhere since
        java.util.concurrent.CompletableFuture<String> loaded = new java.util.concurrent.CompletableFuture<>();
        getActivity().runOnUiThread(() -> loaded.complete(getBridge().getWebView().getUrl()));
        String url;
        try {
            url = loaded.get(5, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception unanswered) {
            url = null;
        }
        if (!SshPcs.setupOpener(url, showingConnectScreen(), BuildConfig.APP_ORIGIN)) {
            call.reject("Only the app's own pages open the SSH setup.");
            return;
        }
        String target = call.getString("target", "");
        if (target == null || target.length() > 300) {
            call.reject("That is not an SSH login.");
            return;
        }
        PCStore.sshSetup = target;
        PCStore.setCurrent(getContext(), null);
        call.resolve();
        reopen();
    }

    /** The connect screen's alone: the SSH login a page asked it to open with (openSshSetup), taken once. */
    @PluginMethod
    public void takeSshSetup(PluginCall call) {
        String target = null;
        if (showingConnectScreen()) {
            target = PCStore.sshSetup;
            PCStore.sshSetup = null;
        }
        JSObject result = new JSObject();
        result.put("asked", target != null);
        result.put("target", target == null ? "" : target);
        call.resolve(result);
    }

    /**
     * Whether the app may use the camera, asked for when it may not: the QR scanner (ionbarcode) asks too, but answers a
     * refusal in English alone, so the pages ask here first and say it themselves (connect.js, RelayAddPc scanQr).
     */
    @PluginMethod
    public void camera(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            cameraAnswered(call);
            return;
        }
        requestPermissionForAlias("camera", call, "cameraAnswered");
    }

    @PermissionCallback
    private void cameraAnswered(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("camera") == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        PCStore.setCurrent(getContext(), null);
        call.resolve();
        reopen();
    }

    /** A PC page's Connect a PC: the connect screen, the current PC kept until another opens (PCStore.choosing). */
    @PluginMethod
    public void chooseAnother(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).chooseAnother());
    }

    /** The connect screen's way back to the PC it was opened from to choose another way. */
    @PluginMethod
    public void backToCurrent(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).backToCurrent());
    }

    @PluginMethod
    public void retry(PluginCall call) {
        // a Tailscale check the person has just approved: the PC's tunnel signs in again
        SshTunnels.resume(PCStore.current(getContext()));
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    private void reopen() {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }
}
