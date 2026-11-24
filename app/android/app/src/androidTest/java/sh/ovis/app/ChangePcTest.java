package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Change PC where a PC did not open (the cover's, error.html's; PCStore.leave, which MainActivity.changePc carries out): an SSH PC is mended on the app's own page, whose
 * Manage holds Forget host key and Set up again, so that page is what comes next, never the hosted Connect a PC
 * screen, which has no such thing. Any other PC is simply left.
 */
@RunWith(AndroidJUnit4.class)
public class ChangePcTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private String added;

    @After
    public void forget() {
        if (added != null) {
            SshPcs.on(context).remove(added);
            SshTunnels.closeFor(added);
            PCStore.forget(context, added);
        }
        PCStore.setCurrent(context, null);
        PCStore.goHome();
    }

    private static Home.Screen next(Context context) {
        return Home.screen(true, PCStore.current(context) != null, PCStore.demo, PCStore.bundledAsked(), PCStore.homeFailed);
    }

    @Test
    public void changePcWhereAnSshPcDidNotOpenBringsTheAppsOwnPageToManageIt() {
        SshPcs store = SshPcs.on(context);
        SshPcs.Pc pc = new SshPcs.Pc();
        pc.origin = store.freeOrigin();
        pc.host = "192.0.2.1";
        pc.port = 22;
        pc.user = "qa";
        pc.hostKeyAlgorithm = "ssh-ed25519";
        pc.hostKey = "AAAAC3NzaC1lZDI1NTE5AAAAIA";
        pc.auth = "tailscale";
        pc.importedKey = "";
        pc.importedPassphrase = "";
        pc.keyType = "";
        store.put(pc);
        added = pc.origin;
        PCStore.goHome();
        PCStore.open(context, pc.origin, null);
        PCStore.leave(context, true);
        assertNull(PCStore.current(context));
        assertTrue(PCStore.manage);
        assertEquals(Home.Screen.BUNDLED, next(context));
        // Change PC from that PC's own page while it is up (Settings) leaves it as any PC: the hosted screen
        PCStore.goHome();
        PCStore.open(context, pc.origin, null);
        PCStore.leave(context, false);
        assertFalse(PCStore.manage);
        assertEquals(Home.Screen.HOME, next(context));
    }

    @Test
    public void changePcOnAnyOtherPcLeavesItForTheHostedScreen() {
        PCStore.goHome();
        PCStore.open(context, "http://192.0.2.1:7317", null);
        PCStore.leave(context, true);
        assertNull(PCStore.current(context));
        assertFalse(PCStore.manage);
        assertEquals(Home.Screen.HOME, next(context));
    }
}
