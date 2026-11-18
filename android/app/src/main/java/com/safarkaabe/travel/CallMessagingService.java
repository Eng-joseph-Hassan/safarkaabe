package com.safarkaabe.travel;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Receives SAFAR KAABE push messages from Firebase, even when the app is closed or the phone is locked.
 * Incoming calls ring continuously (like a normal phone call) with Answer and Decline buttons.
 */
public class CallMessagingService extends FirebaseMessagingService {
    static final String SERVER_BASE = "https://travel-agancey-app.vercel.app";
    static final String CALL_CHANNEL = "safar_incoming_calls";
    static final String UPDATES_CHANNEL = "safar_updates";
    private static final long[] CALL_VIBRATION = {0, 1000, 800, 1000, 800, 1000, 800};

    @Override
    public void onNewToken(@NonNull String token) {
        getSharedPreferences("safar_push", MODE_PRIVATE).edit().putString("fcm_token", token).apply();
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String type = data.get("type");
        if ("CALL_INCOMING".equals(type)) {
            showIncomingCall(this, data);
        } else if ("CALL_ENDED".equals(type)) {
            cancelCall(this, data.get("callId"));
            if ("MISSED".equals(data.get("reason"))) showUpdate(this, data, "Missed call", "You missed a SAFAR KAABE call.");
        } else if (data.get("title") != null) {
            showUpdate(this, data, data.get("title"), data.get("body"));
        }
    }

    static int callNotificationId(String callId) {
        return ("call:" + callId).hashCode();
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (manager.getNotificationChannel(CALL_CHANNEL) == null) {
            NotificationChannel calls = new NotificationChannel(CALL_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            calls.setDescription("Rings when someone calls you on SAFAR KAABE");
            AudioAttributes ringtone = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ringtone);
            calls.enableVibration(true);
            calls.setVibrationPattern(CALL_VIBRATION);
            calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(calls);
        }
        if (manager.getNotificationChannel(UPDATES_CHANNEL) == null) {
            NotificationChannel updates = new NotificationChannel(UPDATES_CHANNEL, "Messages and trip updates", NotificationManager.IMPORTANCE_HIGH);
            updates.setDescription("New messages, bookings, payments and trip reminders");
            manager.createNotificationChannel(updates);
        }
    }

    static PendingIntent openAppIntent(Context context, String path, int requestCode) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(MainActivity.EXTRA_OPEN_PATH, path);
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String value(Map<String, String> data, String key, String fallback) {
        String found = data.get(key);
        return found == null || found.isEmpty() ? fallback : found;
    }

    static void showIncomingCall(Context context, Map<String, String> data) {
        String callId = data.get("callId");
        if (callId == null) return;
        ensureChannels(context);
        int id = callNotificationId(callId);
        String caller = value(data, "callerName", "Someone");
        boolean video = "VIDEO".equals(data.get("callType"));
        String conversation = Uri.encode(value(data, "conversationId", ""));
        String base = "/?platform=android&conversation=" + conversation;

        PendingIntent answer = openAppIntent(context, base + "&answerCall=" + Uri.encode(callId), id + 1);
        PendingIntent show = openAppIntent(context, base + "&showCall=" + Uri.encode(callId), id + 2);
        Intent declineIntent = new Intent(context, CallActionReceiver.class)
                .setAction(CallActionReceiver.ACTION_DECLINE)
                .putExtra("callId", callId)
                .putExtra("token", data.get("declineToken"));
        PendingIntent decline = PendingIntent.getBroadcast(context, id + 3, declineIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CALL_CHANNEL)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(video ? "Incoming video call" : "Incoming voice call")
                .setContentText(caller + " is calling you on SAFAR KAABE")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(true)
                .setTimeoutAfter(60_000)
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
                .setVibrate(CALL_VIBRATION)
                .setContentIntent(show)
                .setFullScreenIntent(show, true)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", decline)
                .addAction(android.R.drawable.sym_action_call, "Answer", answer);
        Notification notification = builder.build();
        // Repeat the ringtone until the call is answered, declined or stops ringing.
        notification.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(context).notify(id, notification);
        } catch (SecurityException notificationsBlocked) {
            // The user turned off notifications for the app; nothing can ring.
        }
    }

    static void cancelCall(Context context, String callId) {
        if (callId == null) return;
        NotificationManagerCompat.from(context).cancel(callNotificationId(callId));
    }

    static void showUpdate(Context context, Map<String, String> data, String title, String body) {
        ensureChannels(context);
        String path = value(data, "url", "/");
        if (!path.startsWith("/")) path = "/";
        String tag = value(data, "notificationId", String.valueOf(System.currentTimeMillis()));
        int id = tag.hashCode();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, UPDATES_CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title == null ? "SAFAR KAABE" : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body == null ? "" : body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(openAppIntent(context, path + (path.contains("?") ? "&" : "?") + "platform=android", id));
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build());
        } catch (SecurityException notificationsBlocked) {
            // Notifications are off for the app.
        }
    }
}
