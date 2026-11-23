package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

import android.content.SharedPreferences;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;
import org.junit.Test;

public class PCStoreForgetTest {
    /** SharedPreferences in memory, its editor applying at once: what PCStore.forget reads and writes. */
    private static final class Prefs implements SharedPreferences {
        final Map<String, Object> values = new HashMap<>();

        @Override public Map<String, ?> getAll() { return values; }
        @Override public String getString(String key, String fallback) { return values.containsKey(key) ? (String) values.get(key) : fallback; }
        @SuppressWarnings("unchecked") @Override public Set<String> getStringSet(String key, Set<String> fallback) { return values.containsKey(key) ? (Set<String>) values.get(key) : fallback; }
        @Override public int getInt(String key, int fallback) { return values.containsKey(key) ? (Integer) values.get(key) : fallback; }
        @Override public long getLong(String key, long fallback) { return values.containsKey(key) ? (Long) values.get(key) : fallback; }
        @Override public float getFloat(String key, float fallback) { return values.containsKey(key) ? (Float) values.get(key) : fallback; }
        @Override public boolean getBoolean(String key, boolean fallback) { return values.containsKey(key) ? (Boolean) values.get(key) : fallback; }
        @Override public boolean contains(String key) { return values.containsKey(key); }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}

        @Override public Editor edit() {
            Map<String, Object> next = new HashMap<>(values);
            return new Editor() {
                @Override public Editor putString(String key, String value) { next.put(key, value); return this; }
                @Override public Editor putStringSet(String key, Set<String> value) { next.put(key, value); return this; }
                @Override public Editor putInt(String key, int value) { next.put(key, value); return this; }
                @Override public Editor putLong(String key, long value) { next.put(key, value); return this; }
                @Override public Editor putFloat(String key, float value) { next.put(key, value); return this; }
                @Override public Editor putBoolean(String key, boolean value) { next.put(key, value); return this; }
                @Override public Editor remove(String key) { next.remove(key); return this; }
                @Override public Editor clear() { next.clear(); return this; }
                @Override public boolean commit() { apply(); return true; }
                @Override public void apply() { values.clear(); values.putAll(next); }
            };
        }
    }

    @Test
    public void forgettingASavedPcDropsTheRelayIdItsPageSaid() throws Exception {
        String mac = "https://macbookpro.tail1e211e.ts.net:17317", nas = "http://192.168.0.5:7317", id = "0123456789abcdef0123456789abcdef";
        Prefs prefs = new Prefs();
        prefs.edit()
            .putString("saved", "[\"" + mac + "\",\"" + nas + "\"]")
            .putString("names", new JSONObject().put(mac, "hasang-uui-MacBookPro").put(nas, "nas").toString())
            .putString("ids", new JSONObject().put(mac, id).put(nas, id).toString())
            .putString("current", mac)
            .putString("last", mac)
            .apply();
        PCStore.forget(prefs, mac);
        assertEquals("[\"" + nas + "\"]", prefs.getString("saved", null));
        assertFalse(new JSONObject(prefs.getString("ids", "{}")).has(mac));
        assertEquals(id, new JSONObject(prefs.getString("ids", "{}")).getString(nas));
        assertFalse(new JSONObject(prefs.getString("names", "{}")).has(mac));
        assertNull(prefs.getString("current", null));
        assertNull(prefs.getString("last", null));
    }
}
