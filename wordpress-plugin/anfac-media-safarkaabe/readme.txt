=== ANFAC MEDIA Shop & SAFAR KAABE ===
Contributors: anfacmedia
Tags: shop, somalia, evc plus, waafipay, edahab
Requires at least: 6.2
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Sell ANFAC MEDIA products with pay-by-phone (EVC Plus, Zaad, Sahal, eDahab) and show live SAFAR KAABE trips on your WordPress site.

== Description ==

**ANFAC MEDIA Shop**

* Add products in WP Admin → ANFAC MEDIA → Products: name, description, photo, price in US dollars, how many are available (empty = no limit) and categories.
* Buyers add products to a cart and order without creating an account.
* Payment choices:
  * **Pay now by phone** through WaafiPay (EVC Plus, Zaad, Sahal) or eDahab. The buyer gets a message on their phone and enters their PIN.
  * **Pay ANFAC MEDIA directly** (cash or mobile money), with your own instructions.
* Manage orders in WP Admin → ANFAC MEDIA → Orders: confirm, prepare, mark as ready or delivered, or cancel. Cancelling returns the items to stock.
* Emails go to you for new orders and to the buyer (when they gave an email) for every update.
* Safe phone payments:
  * An order can never be charged twice.
  * If WaafiPay or eDahab does not give a clear answer, the order is marked "Payment being checked" and keeps its items. Check your merchant portal, then click "Payment received" or "Payment not received".

**SAFAR KAABE**

* `[safarkaabe_trips]` shows live trips (flights, hotels, tours…) from the SAFAR KAABE app, with a "Book on SAFAR KAABE" button.
* `[safarkaabe_app_products]` shows ANFAC MEDIA products that are sold inside the SAFAR KAABE app.

== Installation ==

1. In WP Admin go to Plugins → Add New → Upload Plugin, choose `anfac-media-safarkaabe.zip`, then Install and Activate.
2. Go to ANFAC MEDIA → Settings. Enter the email for new orders, your "pay directly" instructions and, if you have them, your WaafiPay and eDahab API keys.
3. Add products in ANFAC MEDIA → Products.
4. Create pages:
   * "Shop" with `[amsk_shop cart_url="/cart/"]`
   * "Cart" (address /cart/) with `[amsk_cart]`
   * "My orders" with `[amsk_my_orders]`
   * "Trips" with `[safarkaabe_trips]`

== Shortcodes ==

* `[amsk_shop columns="3" category="design" limit="24" cart_url="/cart/"]` – product grid. `category` is a product category slug. With `cart_url`, "Add to cart" takes the buyer to the cart page.
* `[amsk_product id="123" cart_url="/cart/"]` – one product.
* `[amsk_cart]` – cart and checkout. After checkout it shows the order and its payment result.
* `[amsk_my_orders]` – orders of the signed-in user, or the order opened from the link shown after checkout or sent by email.
* `[safarkaabe_trips limit="12" category="FLIGHT" agency="" columns="3"]` – live SAFAR KAABE trips. `category` is one of FLIGHT, HOTEL, CAR, TOUR, TRANSFER or PACKAGE. `agency` matches part of an agency name.
* `[safarkaabe_app_products limit="12"]` – products from the SAFAR KAABE app shop. Hidden if the app shop is not available.

== Frequently Asked Questions ==

= Which WaafiPay keys do I need? =
The API keys (Merchant UID, API user ID and API key) for direct API payments. These are different from the hosted payment page keys. For testing, set the API address to https://sandbox.waafipay.net/asm.

= What happens if the buyer does not approve the payment? =
If WaafiPay or eDahab clearly says no (not enough money, number not registered, payment refused), the order is cancelled and the items go back to stock. If the answer is not clear, the order waits for you to check it.

= Is the buyer's money safe if I cancel a paid order? =
The order shows "refund needed". Send the money back, then click "Refund sent". The buyer is emailed.

= Where do the trips come from? =
From the SAFAR KAABE app's public trip list (set the app address in Settings). The list is refreshed every minute.

== Changelog ==

= 1.0.0 =
* First release: ANFAC MEDIA shop with pay-by-phone, order management and emails; SAFAR KAABE trips and app products.
