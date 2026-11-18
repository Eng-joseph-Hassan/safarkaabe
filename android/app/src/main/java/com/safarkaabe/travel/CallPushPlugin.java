package com.safarkaabe.travel;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/** Lets the web app register this phone for call and message alerts (Firebase Cloud Messaging). */
@CapacitorPlugin(
        name = "CallPush",
        permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class CallPushPlugin extends Plugin {

    @PluginMethod
    public void register(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        fetchToken(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("Notifications are turned off for SAFAR KAABE, so calls cannot ring when the app is closed.");
            return;
        }
        fetchToken(call);
    }

    private void fetchToken(PluginCall call) {
        CallMessagingService.ensureChannels(getContext());
        try {
            if (FirebaseApp.getApps(getContext()).isEmpty() && FirebaseApp.initializeApp(getContext()) == null) {
                call.reject("Call alerts are not set up in this app build yet.", "NOT_CONFIGURED");
                return;
            }
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null) {
                    call.reject("This phone could not be registered for call alerts. Check the internet connection.");
                    return;
                }
                JSObject result = new JSObject();
                result.put("token", task.getResult());
                result.put("fullScreenAllowed", canUseFullScreen());
                call.resolve(result);
            });
        } catch (Exception error) {
            call.reject("Call alerts are not set up in this app build yet.", "NOT_CONFIGURED");
        }
    }

    private boolean canUseFullScreen() {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        return manager != null && manager.canUseFullScreenIntent();
    }

    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 34) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }
}
