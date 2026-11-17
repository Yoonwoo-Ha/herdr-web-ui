package sh.ovis.push;

import android.content.Context;
import android.content.Intent;

public final class AlertProof {
    public static final String EXTRA = "sh.ovis.push.proof";

    private AlertProof() {}

    public static boolean own(Context context, Intent intent) {
        return PushStore.provesAlert(context, intent.getStringExtra(EXTRA));
    }
}
