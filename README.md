# SAFAR KAABE Travel Marketplace

## Run the app

Install Node.js 22.13 or newer, open a terminal in this folder, and run:

```sh
npm start
```

Open `http://localhost:4173` on the computer. To test on a phone connected to the same Wi-Fi, open the network address printed by the server.

On the first launch, create the Super Admin account from the setup screen. After setup, sign in to manage agencies. All signed-in roles have a dedicated profile and security page to edit their name and phone, upload/remove a profile photo, or change their password after verifying the current password; changing a password revokes other sessions. Agencies can upload/remove their company logo. Photos and logos accept PNG, JPEG, or WebP and are resized to a maximum of 256 KB. Super Admins can create agencies, review and approve pending applications, suspend or reactivate agencies, and set their markup. New agencies cannot sign in or publish inventory until approved; suspension revokes their active sessions. Agencies can manage their own staff, client CRM, and ticket/service inventory, including publication, travel dates, baggage, and availability; customers can register, manage their profile, and view their bookings. Profile photos and agency logos are shown in conversation lists, messages, and Super Admin account lists. Customers can message an agency or platform support, agencies can contact support and reply to customers, and Super Admins can handle all conversations. Message access is enforced by the server and read receipts are tracked. Roles, inventory, and agency ownership are enforced by the server. Each confirmed sandbox booking decrements shared inventory atomically.

The server stores accounts, sessions, agencies, catalog products, bookings, conversations, messages, and audit events in SQLite under `data/safar-kaabe.sqlite`. Keep this directory private and backed up. Every device connecting to the same server uses the same account and shared data; sign in on each device with the same email and password. Login sessions are separate per device. To place the database elsewhere, set `SAFAR_KAABE_DATA_DIR` before starting the server.

### Password reset email

Forgot-password codes are sent by SMTP. The sender address defaults to `engjoseph250@gmail.com`, but an address alone cannot send email. Configure these variables in the server's environment before starting it:

```powershell
$env:SMTP_HOST = 'smtp.gmail.com'
$env:SMTP_PORT = '465'
$env:SMTP_SECURE = 'true'
$env:SMTP_USER = 'engjoseph250@gmail.com'
$env:SMTP_PASS = '<Gmail app password>'
$env:SMTP_FROM = 'engjoseph250@gmail.com'
npm start
```

Use a Gmail app password (with 2-Step Verification enabled), or credentials from another authorized SMTP provider. Keep the password in the server environment; do not commit it or share it in chat. Without valid SMTP settings, the app reports that password reset email is unavailable.

To run the automated integration tests, use:

```sh
npm test
```

## Install on a device

The app is a responsive Progressive Web App (PWA). In Chrome or Edge, use the browser's **Install app** option (or the in-app button when available) to add it to a phone or desktop. On iPhone or iPad, open the site in Safari and choose **Share > Add to Home Screen**.

The attached SAFAR KAABE logo is used across the sign-in screen, app header, loading indicator, browser icons, PWA icons, Android launcher, and Android launch screens. Optimized PNG marks are provided at 16, 32, 48, 64, 128, 256, and 512 pixels. The sticky dark-blue header keeps the logo and menu on the left, travel search centered, and chat shortcut on the right on phones. Search is available from every portal and covers the signed-in account's available inventory across flights, hotels, cars, tours, transfers, and packages, with filters for origin, destination, travel date, and agency. It also searches accessible booking references/PNRs, agency names, conversations, and account records. The Explore page includes a nine-image carousel with touch-friendly controls, including Umrah destination imagery.

## Android app

An Android WebView app project is included in `android/`. It opens the server-hosted app, so the computer running SAFAR KAABE must stay on. The checked-in Android configuration uses `localhost`; for a USB-connected phone, enable ADB port forwarding with `adb reverse tcp:4173 tcp:4173` while the phone is connected. For Wi-Fi use, set `server.url` and `server.allowNavigation` in `capacitor.config.json` to the computer's current Wi-Fi IPv4 address, and connect both devices to that same Wi-Fi. The Android layout reserves room for the status bar so it does not cover the logo and app name.

Build a debug APK from Windows:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
npm install
npm exec cap -- sync android
cd android
.\gradlew.bat assembleDebug
```

The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. Install it on a USB-connected, authorized Android phone with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, or copy the APK to the phone and open it. Allow installation from that source if Android asks. This local-network build uses HTTP; do not expose it to public networks.

Regenerate the web icons, Android launcher icons, and native launch-screen images from `logo-mark.png` with:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
& "$env:JAVA_HOME\bin\java.exe" scripts\GenerateAndroidIcons.java logo-mark.png android\app\src\main\res .
npm exec cap -- sync android
```

## Current scope and deployment

This project currently runs as a long-lived Node.js server and writes to a local SQLite database. Do not deploy it to Vercel as-is: serverless instances are ephemeral and cannot provide the shared, persistent SQLite storage this app requires. A Vercel deployment needs a managed database (for example PostgreSQL) and an application/API migration to Vercel-compatible functions. Use a persistent Node.js host with durable storage until that migration is complete.

The implemented foundation includes server-backed authentication, Super Admin/agency/customer roles, agency approval and suspension controls, agency-scoped staff, clients and editable travel inventory, private in-app messaging with read receipts, a nine-image carousel, and server-priced sandbox bookings. Messaging attachments and email/SMS/push notifications are not implemented. The broader marketplace requirements are not all implemented: there are no live airline, hotel, car, tour, payment, mobile-money, or insurance integrations; booking changes/refunds and ticket issuance are not connected to suppliers; and reporting, recommendations, native iOS/Android apps, and separately packaged Windows/macOS desktop apps remain future work. Listings require an agency to add its own inventory; no sample offers are presented as live availability or confirmed supplier offers.

Use HTTPS and secure operational controls before public deployment. Configure database access, backups, monitoring, email verification, password recovery, privacy/retention policies, and the first-admin setup process for your production environment. Do not use the sample product/pricing data or collect real payment details as if live integrations were active.
