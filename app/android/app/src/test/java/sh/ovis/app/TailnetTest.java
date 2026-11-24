package sh.ovis.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.net.InetAddress;
import java.net.UnknownHostException;
import org.junit.Test;

public class TailnetTest {
    private static InetAddress ip(String text) throws UnknownHostException {
        return InetAddress.getByName(text);
    }

    @Test
    public void takesTailscalesOwnIpv6RangeOnAnyInterface() throws UnknownHostException {
        assertTrue(Tailnet.tailscaleAddress("tun0", ip("fd7a:115c:a1e0::1234")));
        assertTrue(Tailnet.tailscaleAddress("wlan0", ip("fd7a:115c:a1e0:ab12::1")));
        assertFalse(Tailnet.tailscaleAddress("tun0", ip("fd7a:115c:a1e1::1")));
        assertFalse(Tailnet.tailscaleAddress("tun0", ip("fd00::1")));
    }

    @Test
    public void takesTheSharedIpv4RangeOnlyOnATunnel() throws UnknownHostException {
        assertTrue(Tailnet.tailscaleAddress("tun0", ip("100.101.12.7")));
        assertTrue(Tailnet.tailscaleAddress("tun1", ip("100.127.255.254")));
        // a carrier's network hands out 100.64/10 on the mobile interface
        assertFalse(Tailnet.tailscaleAddress("rmnet_data0", ip("100.70.1.2")));
        assertFalse(Tailnet.tailscaleAddress("tun0", ip("100.128.0.1")));
        assertFalse(Tailnet.tailscaleAddress("tun0", ip("100.63.255.255")));
        assertFalse(Tailnet.tailscaleAddress("tun0", ip("192.168.0.10")));
    }
}
