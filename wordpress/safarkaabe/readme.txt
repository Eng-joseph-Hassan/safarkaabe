=== SAFAR KAABE ===
Contributors: anfacmedia
Requires at least: 6.2
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.4.0
License: GPLv2 or later

The SAFAR KAABE travel marketplace running fully inside WordPress at /safarkaabe/ – like ANFAC System runs at /system/.

== Description ==

Opens at **https://YOUR-SITE/safarkaabe/**. Everything runs on your own hosting and your own WordPress database (tables wp_sk_*). It never sends visitors to another website.

Included:

* Super Admin, travel agencies and travelers, with sign in, registration, profile, password change and password reset by email.
* Agencies:
  * Approve, suspend or reactivate agencies.
  * Agencies publish trips with photos, dates, seats and prices.
  * Agency staff and client lists.
* Travelers:
  * Browse and search trips.
  * Book seats, without overbooking.
  * Saved trips and a waitlist for full trips.
  * Trip reminders and reviews of agencies.
* Bookings: confirm, decline, edit, cancel (seats return), and refunds recorded by the agency.
* Pay by phone with EVC Plus, Zaad and Sahal (WaafiPay) or eDahab, once you add the API keys in WordPress → SAFAR KAABE:
  * The traveler approves the payment with their PIN on their phone.
  * A booking is never charged twice.
  * An unclear answer from the payment provider is shown to the agency as "check your merchant portal", never as failed.
* Chat in a WhatsApp-style layout between travelers, agencies and support, with photos, voice messages, read ticks, typing, blocking, and voice and video calls.
* Call and message alerts on phones and computers, even when the app is closed: an incoming call rings with Answer and Decline buttons. Each person turns them on once ("Turn on call alerts").
* Notifications in the app, notification settings, sales reports with Excel (CSV) download, and an activity history.
* Booking confirmation: a branded PDF voucher and a phone-friendly image. It is emailed to the traveler automatically when the agency confirms.
* Status updates (24 hours, for Everyone or Contacts only) with views, replies and reactions, and communities (group chats).
* Sign-in codes by email: two-step sign-in that users can turn on in their profile.
* Trips on any page of your website: `[safarkaabe_trips limit="6"]`, `[safarkaabe_trips category="FLIGHT" title="Flights from Baidoa"]` and `[safarkaabe_button]`.
* Optional "SAFAR KAABE" link in your site menu.
* Light and dark mode, English and Somali, and installable on phones.

Not on the website version yet:

* Automatic refunds (the agency sends the money and records the refund).

== Installation ==

1. In WordPress go to Plugins → Add New → Upload Plugin, choose `safarkaabe.zip`, then Install Now and Activate.
2. Go to **WordPress → SAFAR KAABE**. Copy the one-time **setup token**.
3. Open **https://YOUR-SITE/safarkaabe/** and choose "Create Super Admin". Enter your name, email, a password of at least 12 characters, and the setup token.
4. Optional: add your WaafiPay and/or eDahab API keys in WordPress → SAFAR KAABE to turn on pay by phone.
5. Add the app to your site menu: tick "Add SAFAR KAABE to my website menu" in WordPress → SAFAR KAABE (or Appearance → Menus → Custom Link → `/safarkaabe/`).
6. Show trips on your home page: add the shortcode `[safarkaabe_trips limit="6" title="Book your next trip"]`.

If /safarkaabe/ shows another page:
* Go to Settings → Permalinks → Save Changes.
* Clear your site cache (LiteSpeed, Hostinger, Cloudflare or a cache plugin).
* Exclude /safarkaabe/ from caching.

== Frequently Asked Questions ==

= Where is the data? =
In your WordPress database, in the tables that start with wp_sk_. Deleting the plugin removes only its settings, never your data.

= Do calls ring when the app is closed? =
Yes, after the person taps "Turn on call alerts" (once per phone or computer). Android phones and computers: works in Chrome, Edge and Firefox. iPhone: first add SAFAR KAABE to the Home Screen (Share → Add to Home Screen), then turn on alerts. The alert rings like a notification with Answer and Decline buttons.

= Does it use the SAFAR KAABE Vercel app? =
No. This plugin is a separate, complete copy that runs only on your website.

== Changelog ==

= 1.4.0 =
* Calls ring on the phone even when SAFAR KAABE is closed (Answer / Decline on the alert), and new messages arrive as alerts. Uses standard browser push; no extra account is needed.
* WhatsApp-style chat: message bubbles, time and read ticks inside each bubble, Today / Yesterday dividers, a small menu for Copy, Edit and Delete, and one round button that is a microphone until you type.
* Computers: Enter sends a message, Shift+Enter starts a new line.

= 1.3.0 =
* Easier to use: the app opens in Somali (English is one tap away, also in the phone menu).
* Simpler names in the menu: Find trips, My bookings, Agency dashboard, Trips & seats, My profile.
* Search starts with where you are going and the date; the travel company is an optional last choice.
* Phones: a shorter top section, so search and trips show right away.
* Share a trip or a confirmed booking on WhatsApp with one tap.

= 1.2.0 =
* Much faster opening: the first information the app needs comes inside the page, so it shows right away without extra waiting.
* Images, logo, styles and the video load straight from your hosting without starting WordPress.
* Reading requests are answered before your theme and other plugins start.
* The app checks the server less often in the background (calls every 5 seconds, 15 when the app is in the background; notifications every 20 seconds; new trips every minute). This keeps your whole website fast.

= 1.1.1 =
* Faster: pages open quicker. Styles are prepared in advance instead of in the browser, and fonts and icons no longer hold up the page.

= 1.1.0 =
* New: booking confirmation PDF and image, emailed on confirmation.
* New: status updates and communities.
* New: sign-in codes by email.
* New: trips showcase shortcodes and an optional site menu link.
* Admin page shows the latest bookings.

= 1.0.1 =
* The setup token hint now points to WordPress admin.

= 1.0.0 =
* First release.
