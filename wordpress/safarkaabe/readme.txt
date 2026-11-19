=== SAFAR KAABE ===
Contributors: anfacmedia
Requires at least: 6.2
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
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
* Chat between travelers, agencies and support, with photos, voice messages, read ticks, typing, blocking, and voice and video calls.
* Notifications in the app, notification settings, sales reports with Excel (CSV) download, and an activity history.
* Light and dark mode, English and Somali, and installable on phones.

Not on the website version yet:

* Status updates and communities.
* Phone push alerts while the app is closed.
* PDF tickets (booking details are shown in My Trips).
* Automatic refunds (the agency sends the money and records the refund).
* Sign-in codes by email.

== Installation ==

1. In WordPress go to Plugins → Add New → Upload Plugin, choose `safarkaabe.zip`, then Install Now and Activate.
2. Go to **WordPress → SAFAR KAABE**. Copy the one-time **setup token**.
3. Open **https://YOUR-SITE/safarkaabe/** and choose "Create Super Admin". Enter your name, email, a password of at least 12 characters, and the setup token.
4. Optional: add your WaafiPay and/or eDahab API keys in WordPress → SAFAR KAABE to turn on pay by phone.
5. Add the app to your site menu: Appearance → Menus → Custom Link → `/safarkaabe/`.

If /safarkaabe/ shows another page:
* Go to Settings → Permalinks → Save Changes.
* Clear your site cache (LiteSpeed, Hostinger, Cloudflare or a cache plugin).
* Exclude /safarkaabe/ from caching.

== Frequently Asked Questions ==

= Where is the data? =
In your WordPress database, in the tables that start with wp_sk_. Deleting the plugin removes only its settings, never your data.

= Does it use the SAFAR KAABE Vercel app? =
No. This plugin is a separate, complete copy that runs only on your website.

== Changelog ==

= 1.0.0 =
* First release.
