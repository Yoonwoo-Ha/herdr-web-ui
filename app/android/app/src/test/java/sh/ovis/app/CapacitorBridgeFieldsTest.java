package sh.ovis.app;

import static org.junit.Assert.assertNotNull;

import org.junit.Test;

public class CapacitorBridgeFieldsTest {
    @Test
    public void theBridgeFieldsTheFrameCheckReadsExist() throws Exception {
        assertNotNull(com.getcapacitor.Bridge.class.getDeclaredField("msgHandler"));
        assertNotNull(com.getcapacitor.MessageHandler.class.getDeclaredField("javaScriptReplyProxy"));
    }
}
