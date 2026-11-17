package sh.ovis.push;

import android.Manifest;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "OvisPush",
    permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class OvisPushPlugin extends Plugin {
    private static final int RELAY_TIMEOUT_MS = 15_000;

    @PluginMethod
    public void getSubscription(PluginCall call) {
        String origin = getBridge().getServerUrl();
        PushStore.Endpoint saved = origin == null ? null : PushStore.endpoint(getContext(), origin);
        try {
            JSObject result = new JSObject();
            if (saved == null) result.put("subscription", JSONObject.NULL);
            else if (call.getBoolean("endpointOnly", false)) {
                result.put("subscription", new JSObject().put("endpoint", saved.endpoint));
            } else {
                PushKeys keys = PushStore.stored(getContext());
                result.put("subscription", keys == null ? JSONObject.NULL : subscription(saved.endpoint, keys));
            }
            call.resolve(result);
        } catch (PushKeys.Damaged damaged) {
            JSObject result = new JSObject();
            result.put("subscription", JSONObject.NULL);
            call.resolve(result);
        } catch (GeneralSecurityException e) {
            call.reject("The push keys could not be read", "failed", e);
        }
    }

    @PluginMethod
    public void subscribe(PluginCall call) {
        if (getBridge().getServerUrl() == null) {
            call.reject("Push needs an open PC", "no_pc");
            return;
        }
        if (!isPublicKey(call.getString("applicationServerKey"))) {
            call.reject("applicationServerKey must be the PC's VAPID public key", "invalid_key");
            return;
        }
        if (FirebaseApp.getApps(getContext()).isEmpty()) {
            call.reject("This build of the app has no push set up (google-services.json)", "unavailable");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
            return;
        }
        getBridge().execute(() -> register(call));
    }

    /**
     * { notifications: "granted" | "denied" | "prompt" | "prompt-with-rationale" }, which the client
     * reads in place of a browser's Notification.permission. Before Android 13 there is no
     * permission to ask (Capacitor's own answer would be "prompt", and asking would fail), only
     * whether the user left the app's notifications on.
     */
    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33) super.checkPermissions(call);
        else call.resolve(notificationsEnabled());
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33) super.requestPermissions(call);
        else call.resolve(notificationsEnabled());
    }

    private JSObject notificationsEnabled() {
        JSObject result = new JSObject();
        result.put("notifications", NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied");
        return result;
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) getBridge().execute(() -> register(call));
        else call.reject("Notifications are off for Ovis", "permission");
    }

    @PluginMethod
    public void unsubscribe(PluginCall call) {
        String origin = getBridge().getServerUrl();
        if (origin != null) PushStore.forget(getContext(), origin);
        call.resolve();
    }

    private void register(PluginCall call) {
        String origin = getBridge().getServerUrl();
        String vapidKey = call.getString("applicationServerKey");
        try {
            FirebaseMessaging messaging = FirebaseMessaging.getInstance();
            messaging.setAutoInitEnabled(true);
            String token = Tasks.await(messaging.getToken(), 30, TimeUnit.SECONDS);
            PushStore.Endpoint saved = PushStore.endpoint(getContext(), origin);
            boolean live = saved != null && token.equals(saved.token) && vapidKey.equals(saved.vapidKey);
            String endpoint = live ? saved.endpoint : registerWithRelay(token, vapidKey);
            PushStore.saveEndpoint(getContext(), origin, endpoint, token, vapidKey);
            JSObject result = new JSObject();
            result.put("subscription", subscription(endpoint, PushStore.keys(getContext())));
            call.resolve(result);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            call.reject("Push setup was interrupted", "failed", e);
        } catch (ExecutionException | TimeoutException | IOException | GeneralSecurityException | JSONException e) {
            call.reject("Could not set up push: " + e.getMessage(), "failed", e);
        }
    }

    private String registerWithRelay(String token, String vapidKey) throws IOException, JSONException {
        String relay = getContext().getString(R.string.ovis_push_relay);
        HttpURLConnection connection = (HttpURLConnection) new URL(relay + "/v1/register").openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(RELAY_TIMEOUT_MS);
            connection.setReadTimeout(RELAY_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            byte[] body = new JSONObject().put("service", "fcm").put("token", token).put("vapid_key", vapidKey).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            int status = connection.getResponseCode();
            if (status != 201) throw new IOException("the push relay answered " + status);
            String answer;
            try (InputStream in = connection.getInputStream()) {
                answer = readAll(in);
            }
            String endpoint = new JSONObject(answer).getString("endpoint");
            if (!endpoint.startsWith(relay + "/v1/push/")) throw new IOException("the push relay gave an endpoint elsewhere");
            return endpoint;
        } finally {
            connection.disconnect();
        }
    }

    /** The whole stream as UTF-8 (InputStream.readAllBytes needs Android 13). */
    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
        return out.toString("UTF-8");
    }

    private static boolean isPublicKey(String value) {
        if (value == null) return false;
        try {
            byte[] point = Base64.getUrlDecoder().decode(value.replace("=", ""));
            return point.length == 65 && point[0] == 4;
        } catch (IllegalArgumentException notBase64Url) {
            return false;
        }
    }

    private JSObject subscription(String endpoint, PushKeys keys) {
        Base64.Encoder url = Base64.getUrlEncoder().withoutPadding();
        JSObject keyFields = new JSObject();
        keyFields.put("p256dh", url.encodeToString(keys.publicPoint));
        keyFields.put("auth", url.encodeToString(keys.auth));
        JSObject subscription = new JSObject();
        subscription.put("endpoint", endpoint);
        subscription.put("expirationTime", JSONObject.NULL);
        subscription.put("keys", keyFields);
        return subscription;
    }
}
