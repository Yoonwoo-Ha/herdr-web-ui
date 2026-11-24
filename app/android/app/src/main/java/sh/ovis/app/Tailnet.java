package sh.ovis.app;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Collections;

/**
 * Whether Tailscale is on on this phone, for the connect screen's Tailscale tab: Tailscale's VPN puts an interface up
 * with its own addresses. No permission is needed to read interfaces, and no other app's state is asked.
 */
final class Tailnet {
    static final String PACKAGE = "com.tailscale.ipn";

    private Tailnet() {}

    /** Any interface that is up holds a Tailscale address. */
    static boolean on() {
        try {
            for (NetworkInterface each : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!each.isUp()) continue;
                for (InetAddress address : Collections.list(each.getInetAddresses())) {
                    if (tailscaleAddress(each.getName(), address)) return true;
                }
            }
        } catch (SocketException | NullPointerException e) {
            return false;
        }
        return false;
    }

    /**
     * Tailscale's own IPv6 range, fd7a:115c:a1e0::/48, on any interface, or its IPv4 range, 100.64.0.0/10, on a tunnel
     * (tun*): a carrier's network uses 100.64/10 too (shared address space, RFC 6598), on the mobile interface.
     */
    static boolean tailscaleAddress(String interfaceName, InetAddress address) {
        byte[] bytes = address.getAddress();
        if (address instanceof Inet6Address) {
            return (bytes[0] & 0xff) == 0xfd && (bytes[1] & 0xff) == 0x7a && (bytes[2] & 0xff) == 0x11
                && (bytes[3] & 0xff) == 0x5c && (bytes[4] & 0xff) == 0xa1 && (bytes[5] & 0xff) == 0xe0;
        }
        return address instanceof Inet4Address && interfaceName != null && interfaceName.startsWith("tun")
            && (bytes[0] & 0xff) == 100 && (bytes[1] & 0xc0) == 64;
    }
}
