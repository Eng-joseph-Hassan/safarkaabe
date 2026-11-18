package com.safarkaabe.travel;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    static final String EXTRA_OPEN_PATH = "safarOpenPath";
    private boolean shownOverLockScreen = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CallPushPlugin.class);
        super.onCreate(savedInstanceState);
        handleOpenIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOpenIntent(intent);
    }

    /** Opens the page a notification points to, for example a call to answer. */
    private void handleOpenIntent(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra(EXTRA_OPEN_PATH);
        if (path == null || !path.startsWith("/")) return;
        intent.removeExtra(EXTRA_OPEN_PATH);
        Uri link = Uri.parse(CallMessagingService.SERVER_BASE + path);
        String callId = link.getQueryParameter("answerCall") != null ? link.getQueryParameter("answerCall") : link.getQueryParameter("showCall");
        if (callId != null) {
            // An incoming call: show the app over the lock screen and stop the notification ringtone.
            showOverLockScreen(true);
            CallMessagingService.cancelCall(this, callId);
        }
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(link.toString()));
        }
    }

    private void showOverLockScreen(boolean show) {
        shownOverLockScreen = show;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(show);
            setTurnScreenOn(show);
        } else if (show) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        // Only a ringing call may appear over the lock screen; afterwards the app needs the phone unlocked again.
        if (shownOverLockScreen) showOverLockScreen(false);
    }
}
