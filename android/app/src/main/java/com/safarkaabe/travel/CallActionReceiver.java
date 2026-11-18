package com.safarkaabe.travel;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Handles the "Decline" button on an incoming-call notification without opening the app. */
public class CallActionReceiver extends BroadcastReceiver {
    static final String ACTION_DECLINE = "com.safarkaabe.travel.DECLINE_CALL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DECLINE.equals(intent.getAction())) return;
        String callId = intent.getStringExtra("callId");
        String token = intent.getStringExtra("token");
        CallMessagingService.cancelCall(context, callId);
        if (callId == null || token == null) return;
        PendingResult pending = goAsync();
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(CallMessagingService.SERVER_BASE + "/api/calls/" + callId + "/push-decline");
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] body = ("{\"token\":\"" + token.replace("\"", "") + "\"}").getBytes(StandardCharsets.UTF_8);
                try (OutputStream stream = connection.getOutputStream()) {
                    stream.write(body);
                }
                connection.getResponseCode();
            } catch (Exception ignored) {
                // The call will stop ringing on its own after 60 seconds.
            } finally {
                if (connection != null) connection.disconnect();
                pending.finish();
            }
        }).start();
    }
}
