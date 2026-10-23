# SAFAR KAABE Travel Marketplace

## Run the app

Install Node.js 22.13 or newer, open a terminal in this folder, and run:

```sh
npm start
```

Open `http://localhost:4173` on the computer. To test on a phone connected to the same Wi-Fi, open the network address printed by the server.

Travelers can browse public, published offers without signing in and submit a booking request with their name, email, and phone. The app opens to the traveler Explore dashboard; agency, inventory, and Super Admin navigation stays hidden until an account with that role signs in. The app menu offers traveler sign-in and traveler account creation, plus separate agency/staff sign-in. Traveler registration is public; agency and Super Admin accounts are created through their protected administration flows. Agency staff sign in with their agency account and see only their agency dashboard and inventory; Super Admins see the Super Admin dashboard. The agency/staff sign-in is available from the app menu on Android. The agency confirms availability and final itinerary details; the app does not issue airline tickets. Travelers can use WaafiPay's provider-hosted checkout when the server is configured; the app does not collect wallet PINs. Guest requests are rate-limited and decrement available inventory atomically. Agency staff can accept requests, edit traveler contact details before acceptance/payment, and cancel open or accepted requests. Canceled requests stay in booking history. Unpaid cancellations return seats to inventory; paid cancellations do not issue an automatic refund, and seats return only after the agency confirms the ticket was not issued. Traveler accounts remain optional for browsing and requests. Sign-in is available in the app for travelers, agencies, and Super Admins; agency and admin data remains role-protected. On the first launch, create the Super Admin account from the setup screen. After setup, sign in to manage agencies. All signed-in roles have a dedicated profile and security page to edit their name and phone, upload/remove a profile photo, or change their password after verifying the current password; changing a password revokes other sessions. Agencies can upload/remove their company logo. Photos and logos accept PNG, JPEG, or WebP and are resized to a maximum of 256 KB. Super Admins can create agencies, review and approve pending applications, suspend or reactivate agencies, and set their markup. New agencies cannot sign in or publish inventory until approved; suspension revokes their active sessions. Agencies can manage their own staff, client CRM, and ticket/service inventory, including optional PNG, JPEG, or WebP offer images up to 256 KB, private drafts, publication, travel dates, baggage, and availability; only published offers from active approved agencies with remaining availability are shown to travelers. Travelers can register, manage their profile, and view their account-linked booking requests. Profile photos and agency logos are shown in conversation lists, messages, and Super Admin account lists. Customers can message an agency or platform support, agencies can contact support and reply to customers, and Super Admins can handle all conversations. Message access is enforced by the server and read receipts are tracked. Roles, inventory, and agency ownership are enforced by the server.

### WaafiPay checkout

Configure `WAAFI_MERCHANT_UID`, `WAAFI_STORE_ID`, and `WAAFI_HPP_KEY` in the server environment to enable WaafiPay. Checkout redirects the traveler to WaafiPay's HTTPS-hosted page; SAFAR KAABE never requests or stores a SIM PIN. The server verifies the transaction reference, amount, currency, and approved status with WaafiPay before marking a booking paid. Only then does it add a provider-confirmed receipt to the booking's agency conversation. `WAAFI_ENV` defaults to `sandbox`; set it to `production` only with production WaafiPay credentials. A shared receipt or SMS alone is not treated as proof of payment.

Super Admins can also start private conversations with an active agency or traveler; guests can browse but cannot open private chats. The responsive chat inbox includes all/unread/favorites filters, local in-chat message search, and a shortcut to Communities; favorites are saved on the current device for each signed-in account. The mobile carousel uses a taller frame to match the reference layout while keeping full images visible.

Local development stores accounts, sessions, agencies, catalog products, bookings, conversations, messages, and audit events in SQLite under `data/safar-kaabe.sqlite`. On Vercel, set `DATABASE_URL` to a Neon PostgreSQL connection string; the app initializes its PostgreSQL schema automatically. Never commit either database or its connection string.

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

Use a Gmail app password (with 2-Step Verification enabled), or credentials from another authorized SMTP provider. For Vercel, add `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, and `SMTP_FROM` to the Production environment, then save `SMTP_PASS` as a Secret. Reset codes are delivered to the email address of the account requesting the reset. Keep the password in the server environment; do not commit it or share it in chat. Without valid SMTP settings, the app reports that password reset email is unavailable.

### Booking confirmation documents

When an agency approves a booking, SAFAR KAABE generates a landscape, detachable-stub confirmation inspired by a boarding pass, with PDFKit drawing operations, then rasterizes that saved PDF into a matching print-resolution JPG using PDF.js and `@napi-rs/canvas`. The document is populated from confirmed booking details, including the traveler name, route, travel date, traveler count, provider, trip details, agency, and booking references. Unconfirmed flight times, flight numbers, seats, gates, and airline boarding data are not invented; traveler contact details are not printed on the voucher. Both files are stored in the configured SQLite or Neon database and shown in the traveler's **My Trips & Vouchers** page, with preview, print, PDF download, and JPG download actions. Vercel functions explicitly include PDFKit's dynamically loaded standard-font assets and PDF.js font resources. Older voucher layouts are marked for refresh in My Trips; regenerating creates a new document version while preserving the prior verification history. If generation fails, the booking remains approved; the traveler can retry generation after required itinerary details are confirmed. Email delivery is tracked separately and can be retried without regenerating the document. Database schema additions are applied automatically at server startup.

Ticket email requires the SMTP variables above and is sent only after both files have been saved. Email links require the recipient to sign in; the PDF is attached when its size permits. The QR code verifies the SAFAR KAABE document and its issuing agency. These confirmations are not airline-issued e-tickets or boarding passes unless airline issuance is separately verified.

To run the automated integration tests, use:

```sh
npm test
```

## Install on a device

The app is a responsive Progressive Web App (PWA). In Chrome or Edge, use the browser's **Install app** option (or the in-app button when available) to add it to a phone or desktop. On iPhone or iPad, open the site in Safari and choose **Share > Add to Home Screen**.

Installed web apps check for updates when opened or brought back to the foreground, and every five minutes while visible. When a new release takes control, the app reloads to show the updated version. An internet connection is required to fetch the release; no remote process can reinstall an app on a device that remains offline.

The SAFAR KAABE brand logo (`safar-kaabe-brand.png`) is used across the sign-in screen, app header, loading indicator, browser icons, PWA icons, Android launcher, and Android launch screens. Optimized PNG marks are provided at 16, 32, 48, 64, 128, 256, and 512 pixels. The dark interface uses the logo's cobalt blue and magenta accents. The sticky dark-blue header keeps the logo and menu on the left, travel search centered, and chat shortcut on the right on phones. Search is available from every portal and covers the signed-in account's available inventory across flights, hotels, cars, tours, transfers, and packages, with filters for origin, destination, travel date, and agency. It also searches accessible booking references/PNRs, agency names, conversations, and account records. The Explore page includes a nine-image carousel with touch-friendly controls, including Umrah destination imagery.

## Android app

An Android WebView app project is included in `android/`. The checked-in configuration opens the live SAFAR KAABE deployment over HTTPS, so web releases update for installed users when they open or resume the app online; visible apps also check every five minutes. No APK reinstall is needed for web-only changes. Changes to native Android code, permissions, or bundled assets require a newly built APK, which users who sideloaded the app must download and install themselves. To develop against a local server, change `server.url` and `server.allowNavigation` in `capacitor.config.json` to the local server address; for a USB-connected phone use `http://localhost:4173` with `adb reverse tcp:4173 tcp:4173`, or use the computer's Wi-Fi IPv4 address with both devices on the same network. The Android layout reserves room for the status bar so it does not cover the logo and app name.

## Chat audio and video calls

Signed-in users can start one-to-one WebRTC audio or video calls from a conversation or the Calls tab. Browsers and the Android WebView ask for microphone and (for video) camera permission when a call starts. Calls use the app's authenticated signaling API and public STUN servers by default. STUN-only calls can fail on restrictive mobile, corporate, or symmetric-NAT networks.

For reliable connections, configure a Coturn-compatible TURN relay in Vercel Production and Preview:

- `TURN_URLS`: comma-separated `turn:` or `turns:` URLs, for example `turns:turn.example.com:5349?transport=tcp,turn:turn.example.com:3478?transport=udp`
- `TURN_SHARED_SECRET`: the relay's REST/shared secret, not a static client username/password

The app creates short-lived TURN credentials on the server and returns them only to authenticated users. Never put the TURN shared secret in browser code or commit it. After changing the Android camera permission, build and distribute a new APK; hosted web updates alone cannot change permissions baked into an installed APK.

Build a debug APK from Windows:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
npm install
npm exec cap -- sync android
cd android
.\gradlew.bat assembleDebug
```

The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. Install it on a USB-connected, authorized Android phone with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, or copy the APK to the phone and open it. Allow installation from that source if Android asks. This local-network build uses HTTP; do not expose it to public networks.

## iOS app

The iOS project requires macOS with Xcode and CocoaPods to build or run on an Apple device. Windows can sync the Capacitor project but cannot compile an iOS app.

1. Install Xcode and CocoaPods on a Mac, then clone this repository and run `npm ci`.
2. Run `npm run ios:sync` to install native dependencies and copy the app configuration.
3. Open `ios/App/App.xcworkspace` in Xcode, select the `App` scheme and an iPhone/iPad simulator or device, then build and run.
4. For App Store distribution, set the Apple Developer Team and signing profile in Xcode, use a unique registered bundle identifier if `com.safarkaabe.travel` is not available, and archive the `App` scheme for App Store Connect.

The iOS app loads the production site over HTTPS. Capacitor's native platform detection distinguishes iOS from Android even though the shared remote URL retains the Android query parameter. Camera and microphone permission descriptions are included for WebRTC calls. The GitHub Actions iOS workflow builds an unsigned iOS Simulator app for CI.

To create an App Store Connect IPA, register `com.safarkaabe.travel` in an active Apple Developer account and create an Apple Distribution certificate (`.p12`) and matching App Store provisioning profile. In GitHub repository Settings > Environments, create the `app-store` environment and add these secrets there: `IOS_CERTIFICATE_BASE64` (base64-encoded `.p12`), `IOS_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64` (base64-encoded `.mobileprovision`), and `IOS_TEAM_ID`. Then run the **iOS App Store Package** workflow from the default branch. The signed IPA is uploaded as the `safar-kaabe-app-store-ipa` artifact; it can be submitted to App Store Connect or TestFlight, but this workflow does not upload or publish it. Never put signing files or passwords in the repository or chat.

Regenerate the web icons, Android launcher icons, and native launch-screen images from `safar-kaabe-brand.png` with:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
& "$env:JAVA_HOME\bin\java.exe" scripts\GenerateAndroidIcons.java safar-kaabe-brand.png android\app\src\main\res .
npm exec cap -- sync android
```

## Vercel deployment

The Vercel API uses serverless Node.js functions and Neon PostgreSQL. To deploy:

1. In the SAFAR KAABE Vercel project, connect the GitHub repository `Eng-joseph-Hassan/safarkaabe` and use the repository root as the project root. Deploy only after the Vercel-connected `main` branch includes the Vercel function, database adapter, and `vercel.json` changes.
2. Create a Neon PostgreSQL database. In Vercel **Settings > Environment Variables**, add its pooled connection string as `DATABASE_URL` for Production (and Preview if needed). Keep it private.
3. Set a strong, one-time `INITIAL_ADMIN_SETUP_TOKEN` in Vercel before the first deployment. Use that value in the first-admin setup screen, then remove the environment variable after the first Super Admin is created.
4. To keep existing local accounts and business data, migrate the local SQLite database before serving production traffic. Put the Neon connection string in a local `.env.local` file (never commit it), then run `node --env-file=.env.local scripts/migrate-sqlite-to-neon.js`. The migration refuses to import into non-empty tables and deliberately does not copy active sessions or password-reset codes; users will sign in again. Back up `data/safar-kaabe.sqlite` before migrating.
5. Add SMTP environment variables in Vercel if password-reset email is needed. Then deploy from the Vercel project. Booking requests are not airline reservations or ticket issuance, and payments are handled only after agency confirmation; live supplier and payment integrations are not enabled.

The initial-admin endpoint is protected by `INITIAL_ADMIN_SETUP_TOKEN` on Vercel so a random first visitor cannot claim the Super Admin account. For local development, SQLite remains the default and setup behavior is unchanged.

The traveler experience opens directly to bookable offers published by approved agencies; travelers can browse as guests, select a travel company, and then submit a booking request. Published offers, agency details, and seat changes appear immediately in open traveler screens when the app runs on its standalone Node.js server. Vercel deployments use automatic refresh every 15 seconds and refresh when a traveler returns to the page. Draft offers stay private, and booking requests reserve seats atomically so customers cannot book more seats than remain available. The traveler search has a clear-filters action, plain-language city and date labels, and city names alongside airport codes. Existing Explore travel inspiration and route modules remain available alongside budget and sort filters. Brand accents use `#C909E6`. These are agency-published offers, not live airline schedules: no airline integration verifies a route, seat, baggage allowance, connection, or ticket price. The app includes account-linked booking requests, provider-hosted WaafiPay checkout when configured, provider-verified payment status and booking receipts, private in-app messaging, image/audio chat attachments, presence, read receipts, and 24-hour photo/text statuses. Status audience controls and status-view counts are not available. WebRTC voice/video calls include foreground ringing, call duration, and camera controls; browser audio routing is controlled by the device/browser and has no separate speakerphone selector. Background/lock-screen push and call notifications, notification preferences/center, and delivery of booking or payment alerts are not implemented; they require a configured push provider and platform credentials. The Android project is a WebView client, not a native calling application, and no iOS project is included. Live airline, hotel, car, tour, and insurance integrations; supplier-connected ticket issuance or change/refund requests; and separately packaged Windows/macOS desktop applications remain future work. Listings require an agency to add its own inventory; no sample offers are presented as live availability or confirmed supplier offers.

Use HTTPS and secure operational controls before public deployment. Configure database access, backups, monitoring, email verification, password recovery, privacy/retention policies, and the first-admin setup process for your production environment. Do not present sample product/pricing data as live inventory; only describe WaafiPay checkout as available when production provider credentials and the merchant account are configured.
