<?php
/**
 * Shortcodes: [amsk_shop], [amsk_product], [amsk_cart], [amsk_my_orders].
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AMSK_Shortcodes {

	public static function register() {
		add_shortcode( 'amsk_shop', array( __CLASS__, 'shop' ) );
		add_shortcode( 'amsk_product', array( __CLASS__, 'product' ) );
		add_shortcode( 'amsk_cart', array( __CLASS__, 'cart' ) );
		add_shortcode( 'amsk_my_orders', array( __CLASS__, 'my_orders' ) );
	}

	public static function register_assets() {
		wp_register_style( 'amsk', AMSK_URL . 'assets/css/amsk.css', array(), AMSK_VERSION );
		wp_register_script( 'amsk', AMSK_URL . 'assets/js/amsk.js', array(), AMSK_VERSION, true );
	}

	/** Loads the CSS/JS only on pages that use one of the shortcodes. */
	public static function enqueue() {
		wp_enqueue_style( 'amsk' );
		wp_enqueue_script( 'amsk' );
		wp_localize_script( 'amsk', 'amskText', array(
			'waiting' => __( 'Check your phone and enter your PIN to approve the payment. Please keep this page open.', 'anfac-media-safarkaabe' ),
		) );
	}

	private static function current_url() {
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/';
		return remove_query_arg( array( 'amsk_msg', 'amsk_err', 'amsk_ek' ), home_url( $uri ) );
	}

	private static function notice() {
		$messages = array(
			'added'     => __( 'Added to your cart.', 'anfac-media-safarkaabe' ),
			'updated'   => __( 'Cart updated.', 'anfac-media-safarkaabe' ),
			'cancelled' => __( 'Your order was cancelled.', 'anfac-media-safarkaabe' ),
			'nocancel'  => __( 'This order can no longer be cancelled here. Please contact ANFAC MEDIA.', 'anfac-media-safarkaabe' ),
		);
		$errors = array(
			'unavailable' => __( 'This product is no longer available.', 'anfac-media-safarkaabe' ),
			'details'     => __( 'Please enter your name and phone number.', 'anfac-media-safarkaabe' ),
			'method'      => __( 'Please choose how you want to pay.', 'anfac-media-safarkaabe' ),
			'phone'       => __( 'Enter a Somali mobile number, for example 61 234 5678 or +252 61 234 5678.', 'anfac-media-safarkaabe' ),
			'limit'       => __( 'Too many payment attempts. Please wait an hour and try again.', 'anfac-media-safarkaabe' ),
			'notfound'    => __( 'Order not found.', 'anfac-media-safarkaabe' ),
			'order'       => __( 'Your order could not be placed.', 'anfac-media-safarkaabe' ),
		);
		$out = '';
		$msg = isset( $_GET['amsk_msg'] ) ? sanitize_key( wp_unslash( $_GET['amsk_msg'] ) ) : '';
		$err = isset( $_GET['amsk_err'] ) ? sanitize_key( wp_unslash( $_GET['amsk_err'] ) ) : '';
		if ( $msg && isset( $messages[ $msg ] ) ) {
			$out .= '<div class="amsk-notice amsk-notice--ok" role="status">' . esc_html( $messages[ $msg ] ) . '</div>';
		}
		if ( $err && isset( $errors[ $err ] ) ) {
			$text = $errors[ $err ];
			if ( 'order' === $err && isset( $_GET['amsk_ek'] ) ) {
				$detail = get_transient( 'amsk_err_' . sanitize_key( wp_unslash( $_GET['amsk_ek'] ) ) );
				if ( $detail ) {
					$text = $detail;
				}
			}
			$out .= '<div class="amsk-notice amsk-notice--error" role="alert">' . esc_html( $text ) . '</div>';
		}
		return $out;
	}

	private static function product_card( $post_id, $cart_url ) {
		$product = AMSK_Products::get_sellable( $post_id );
		if ( ! $product ) {
			return '';
		}
		$sold_out = null !== $product['stock'] && $product['stock'] < 1;
		$image    = get_the_post_thumbnail( $post_id, 'medium_large', array( 'class' => 'amsk-card__image', 'loading' => 'lazy' ) );
		$terms    = get_the_terms( $post_id, 'amsk_product_cat' );
		ob_start();
		?>
		<article class="amsk-card">
			<?php echo $image ? $image : '<div class="amsk-card__image amsk-card__image--empty" aria-hidden="true"></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- core-generated, escaped markup. ?>
			<div class="amsk-card__body">
				<?php if ( $terms && ! is_wp_error( $terms ) ) : ?>
					<span class="amsk-card__tag"><?php echo esc_html( $terms[0]->name ); ?></span>
				<?php endif; ?>
				<h3 class="amsk-card__title"><a href="<?php echo esc_url( get_permalink( $post_id ) ); ?>"><?php echo esc_html( $product['title'] ); ?></a></h3>
				<div class="amsk-card__text"><?php echo wp_kses_post( wpautop( get_the_excerpt( $post_id ) ) ); ?></div>
				<div class="amsk-card__footer">
					<strong class="amsk-card__price"><?php echo esc_html( amsk_money( $product['price_cents'] ) ); ?></strong>
					<?php if ( null !== $product['stock'] && ! $sold_out ) : ?>
						<?php /* translators: %d: items left */ ?>
						<span class="amsk-card__stock"><?php echo esc_html( sprintf( _n( '%d left', '%d left', $product['stock'], 'anfac-media-safarkaabe' ), $product['stock'] ) ); ?></span>
					<?php endif; ?>
				</div>
				<?php if ( $sold_out ) : ?>
					<p class="amsk-card__soldout"><?php esc_html_e( 'Sold out', 'anfac-media-safarkaabe' ); ?></p>
				<?php else : ?>
					<form class="amsk-card__form" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
						<input type="hidden" name="action" value="amsk_add_to_cart" />
						<input type="hidden" name="product_id" value="<?php echo (int) $post_id; ?>" />
						<input type="hidden" name="amsk_return" value="<?php echo esc_url( self::current_url() ); ?>" />
						<input type="hidden" name="amsk_cart_url" value="<?php echo esc_url( $cart_url ); ?>" />
						<?php wp_nonce_field( 'amsk_cart', 'amsk_nonce' ); ?>
						<label class="screen-reader-text" for="amsk_qty_<?php echo (int) $post_id; ?>"><?php esc_html_e( 'Quantity', 'anfac-media-safarkaabe' ); ?></label>
						<input id="amsk_qty_<?php echo (int) $post_id; ?>" class="amsk-qty" type="number" name="quantity" value="1" min="1" max="<?php echo esc_attr( null === $product['stock'] ? 100 : min( 100, $product['stock'] ) ); ?>" />
						<button type="submit" class="amsk-button"><?php esc_html_e( 'Add to cart', 'anfac-media-safarkaabe' ); ?></button>
					</form>
				<?php endif; ?>
			</div>
		</article>
		<?php
		return ob_get_clean();
	}

	public static function shop( $atts ) {
		self::enqueue();
		$atts  = shortcode_atts( array( 'category' => '', 'columns' => 3, 'limit' => 24, 'cart_url' => '' ), $atts, 'amsk_shop' );
		$query = array(
			'post_type'      => 'amsk_product',
			'post_status'    => 'publish',
			'posts_per_page' => max( 1, min( 100, (int) $atts['limit'] ) ),
			'fields'         => 'ids',
			'orderby'        => 'menu_order title',
			'order'          => 'ASC',
		);
		if ( $atts['category'] ) {
			$query['tax_query'] = array( array( 'taxonomy' => 'amsk_product_cat', 'field' => 'slug', 'terms' => sanitize_title( $atts['category'] ) ) ); // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_tax_query
		}
		$ids      = get_posts( $query );
		$cart_url = $atts['cart_url'] ? esc_url_raw( $atts['cart_url'] ) : '';
		$out      = self::notice();
		if ( ! $ids ) {
			return $out . '<p class="amsk-empty">' . esc_html__( 'No products yet. Please check back soon.', 'anfac-media-safarkaabe' ) . '</p>';
		}
		$columns = max( 1, min( 4, (int) $atts['columns'] ) );
		$out    .= '<div class="amsk-grid amsk-grid--' . esc_attr( $columns ) . '">';
		foreach ( $ids as $id ) {
			$out .= self::product_card( $id, $cart_url );
		}
		return $out . '</div>';
	}

	public static function product( $atts ) {
		self::enqueue();
		$atts = shortcode_atts( array( 'id' => 0, 'cart_url' => '' ), $atts, 'amsk_product' );
		$card = self::product_card( absint( $atts['id'] ), $atts['cart_url'] ? esc_url_raw( $atts['cart_url'] ) : '' );
		return self::notice() . ( $card ? '<div class="amsk-grid amsk-grid--1">' . $card . '</div>' : '' );
	}

	public static function cart() {
		self::enqueue();
		$order_view = self::order_from_link();
		if ( $order_view ) {
			return self::notice() . self::render_order( $order_view );
		}
		$cart = AMSK_Cart::get();
		$out  = self::notice();
		if ( ! $cart ) {
			return $out . '<p class="amsk-empty">' . esc_html__( 'Your cart is empty.', 'anfac-media-safarkaabe' ) . '</p>';
		}
		$available = AMSK_Payments::available();
		$settings  = AMSK_Settings::get();
		$user      = wp_get_current_user();
		$total     = 0;
		ob_start();
		?>
		<div class="amsk-cart">
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="amsk-cart__items">
				<input type="hidden" name="action" value="amsk_update_cart" />
				<input type="hidden" name="amsk_return" value="<?php echo esc_url( self::current_url() ); ?>" />
				<?php wp_nonce_field( 'amsk_cart', 'amsk_nonce' ); ?>
				<table class="amsk-table">
					<thead><tr><th><?php esc_html_e( 'Product', 'anfac-media-safarkaabe' ); ?></th><th><?php esc_html_e( 'Quantity', 'anfac-media-safarkaabe' ); ?></th><th><?php esc_html_e( 'Price', 'anfac-media-safarkaabe' ); ?></th><th><span class="screen-reader-text"><?php esc_html_e( 'Remove', 'anfac-media-safarkaabe' ); ?></span></th></tr></thead>
					<tbody>
					<?php foreach ( $cart as $id => $qty ) : ?>
						<?php $product = AMSK_Products::get_sellable( $id ); $line = $product['price_cents'] * $qty; $total += $line; ?>
						<tr>
							<td data-label="<?php esc_attr_e( 'Product', 'anfac-media-safarkaabe' ); ?>"><?php echo esc_html( $product['title'] ); ?></td>
							<td data-label="<?php esc_attr_e( 'Quantity', 'anfac-media-safarkaabe' ); ?>"><input class="amsk-qty" type="number" min="0" max="100" name="qty[<?php echo (int) $id; ?>]" value="<?php echo (int) $qty; ?>" aria-label="<?php esc_attr_e( 'Quantity', 'anfac-media-safarkaabe' ); ?>" /></td>
							<td data-label="<?php esc_attr_e( 'Price', 'anfac-media-safarkaabe' ); ?>"><?php echo esc_html( amsk_money( $line ) ); ?></td>
							<td><button type="submit" name="remove" value="<?php echo (int) $id; ?>" class="amsk-link"><?php esc_html_e( 'Remove', 'anfac-media-safarkaabe' ); ?></button></td>
						</tr>
					<?php endforeach; ?>
					</tbody>
					<tfoot><tr><th colspan="2"><?php esc_html_e( 'Total', 'anfac-media-safarkaabe' ); ?></th><th colspan="2"><?php echo esc_html( amsk_money( $total ) ); ?></th></tr></tfoot>
				</table>
				<button type="submit" class="amsk-button amsk-button--ghost"><?php esc_html_e( 'Update cart', 'anfac-media-safarkaabe' ); ?></button>
			</form>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="amsk-checkout" data-amsk-checkout>
				<h3><?php esc_html_e( 'Your details', 'anfac-media-safarkaabe' ); ?></h3>
				<input type="hidden" name="action" value="amsk_checkout" />
				<input type="hidden" name="amsk_return" value="<?php echo esc_url( self::current_url() ); ?>" />
				<?php wp_nonce_field( 'amsk_checkout', 'amsk_nonce' ); ?>
				<label><?php esc_html_e( 'Full name', 'anfac-media-safarkaabe' ); ?><input type="text" name="buyer_name" maxlength="120" required value="<?php echo esc_attr( $user->exists() ? $user->display_name : '' ); ?>" /></label>
				<label><?php esc_html_e( 'Phone number', 'anfac-media-safarkaabe' ); ?><input type="tel" name="buyer_phone" maxlength="40" required placeholder="61 234 5678" /></label>
				<label><?php esc_html_e( 'Email (optional, for updates)', 'anfac-media-safarkaabe' ); ?><input type="email" name="buyer_email" maxlength="120" value="<?php echo esc_attr( $user->exists() ? $user->user_email : '' ); ?>" /></label>
				<label><?php esc_html_e( 'Note for ANFAC MEDIA (optional)', 'anfac-media-safarkaabe' ); ?><textarea name="buyer_note" maxlength="1000" rows="3"></textarea></label>
				<fieldset class="amsk-pay">
					<legend><?php esc_html_e( 'How do you want to pay?', 'anfac-media-safarkaabe' ); ?></legend>
					<?php $first = true; ?>
					<?php if ( $available['waafi'] ) : ?>
						<label class="amsk-pay__option"><input type="radio" name="payment_method" value="waafi" data-amsk-phone-pay <?php checked( $first ); ?> /> <span><strong><?php esc_html_e( 'Pay now by phone – EVC Plus, Zaad or Sahal', 'anfac-media-safarkaabe' ); ?></strong><br /><?php esc_html_e( 'You will get a message on your phone. Enter your PIN to approve.', 'anfac-media-safarkaabe' ); ?></span></label>
						<?php $first = false; ?>
					<?php endif; ?>
					<?php if ( $available['edahab'] ) : ?>
						<label class="amsk-pay__option"><input type="radio" name="payment_method" value="edahab" data-amsk-phone-pay <?php checked( $first ); ?> /> <span><strong><?php esc_html_e( 'Pay now by phone – eDahab', 'anfac-media-safarkaabe' ); ?></strong><br /><?php esc_html_e( 'You will get a message on your phone. Enter your PIN to approve.', 'anfac-media-safarkaabe' ); ?></span></label>
						<?php $first = false; ?>
					<?php endif; ?>
					<?php if ( $available['seller'] ) : ?>
						<label class="amsk-pay__option"><input type="radio" name="payment_method" value="seller" <?php checked( $first ); ?> /> <span><strong><?php esc_html_e( 'Pay ANFAC MEDIA directly', 'anfac-media-safarkaabe' ); ?></strong><br /><?php echo esc_html( $settings['pay_seller_text'] ); ?></span></label>
						<?php $first = false; ?>
					<?php endif; ?>
					<?php if ( $first ) : ?>
						<p><?php esc_html_e( 'Ordering is not open yet. Please contact ANFAC MEDIA.', 'anfac-media-safarkaabe' ); ?></p>
					<?php endif; ?>
				</fieldset>
				<p class="amsk-total"><?php esc_html_e( 'Total to pay', 'anfac-media-safarkaabe' ); ?>: <strong><?php echo esc_html( amsk_money( $total ) ); ?></strong></p>
				<?php if ( ! $first ) : ?>
					<button type="submit" class="amsk-button amsk-button--wide"><?php esc_html_e( 'Place order', 'anfac-media-safarkaabe' ); ?></button>
				<?php endif; ?>
				<p class="amsk-waiting" hidden aria-live="polite"></p>
			</form>
		</div>
		<?php
		return $out . ob_get_clean();
	}

	/** Order linked by ?amsk_order=REF&amsk_key=SECRET (sent to the buyer after checkout and by email). */
	private static function order_from_link() {
		if ( empty( $_GET['amsk_order'] ) || empty( $_GET['amsk_key'] ) ) {
			return 0;
		}
		return AMSK_Orders::find_by_key( sanitize_text_field( wp_unslash( $_GET['amsk_order'] ) ), sanitize_text_field( wp_unslash( $_GET['amsk_key'] ) ) );
	}

	public static function render_order( $order_id ) {
		$statuses = AMSK_Orders::statuses();
		$payments = AMSK_Orders::payment_labels();
		$status   = AMSK_Orders::meta( $order_id, 'status' );
		$payment  = AMSK_Orders::meta( $order_id, 'payment_status' );
		$items    = AMSK_Orders::meta( $order_id, 'items' );
		$message  = AMSK_Orders::meta( $order_id, 'payment_message' );
		$state    = 'paid' === $payment ? 'ok' : ( in_array( $payment, array( 'failed' ), true ) || 'cancelled' === $status ? 'error' : 'info' );
		ob_start();
		?>
		<section class="amsk-order">
			<h3><?php /* translators: %s: order reference */ echo esc_html( sprintf( __( 'Order %s', 'anfac-media-safarkaabe' ), AMSK_Orders::meta( $order_id, 'reference' ) ) ); ?></h3>
			<?php if ( $message && in_array( $payment, array( 'paid', 'failed', 'unknown' ), true ) ) : ?>
				<div class="amsk-notice amsk-notice--<?php echo esc_attr( $state ); ?>" role="status"><?php echo esc_html( $message ); ?></div>
			<?php endif; ?>
			<p><strong><?php esc_html_e( 'Status', 'anfac-media-safarkaabe' ); ?>:</strong> <?php echo esc_html( isset( $statuses[ $status ] ) ? $statuses[ $status ] : $status ); ?><br />
				<strong><?php esc_html_e( 'Payment', 'anfac-media-safarkaabe' ); ?>:</strong> <?php echo esc_html( isset( $payments[ $payment ] ) ? $payments[ $payment ] : $payment ); ?></p>
			<ul class="amsk-order__items">
				<?php foreach ( is_array( $items ) ? $items : array() as $item ) : ?>
					<li><?php echo esc_html( sprintf( '%d × %s – %s', (int) $item['quantity'], $item['title'], amsk_money( $item['unit_cents'] * $item['quantity'] ) ) ); ?></li>
				<?php endforeach; ?>
			</ul>
			<p class="amsk-total"><?php esc_html_e( 'Total', 'anfac-media-safarkaabe' ); ?>: <strong><?php echo esc_html( amsk_money( AMSK_Orders::meta( $order_id, 'total_cents' ) ) ); ?></strong></p>
			<?php if ( 'none' === $payment && 'cancelled' !== $status ) : ?>
				<p><?php echo esc_html( AMSK_Settings::get( 'pay_seller_text' ) ); ?></p>
			<?php endif; ?>
			<?php if ( 'new' === $status && in_array( $payment, array( 'none', 'pending' ), true ) ) : ?>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm(this.dataset.confirm);" data-confirm="<?php esc_attr_e( 'Cancel this order?', 'anfac-media-safarkaabe' ); ?>">
					<input type="hidden" name="action" value="amsk_buyer_cancel" />
					<input type="hidden" name="amsk_order" value="<?php echo esc_attr( AMSK_Orders::meta( $order_id, 'reference' ) ); ?>" />
					<input type="hidden" name="amsk_key" value="<?php echo esc_attr( AMSK_Orders::meta( $order_id, 'key' ) ); ?>" />
					<input type="hidden" name="amsk_return" value="<?php echo esc_url( self::current_url() ); ?>" />
					<?php wp_nonce_field( 'amsk_buyer_cancel', 'amsk_nonce' ); ?>
					<button type="submit" class="amsk-button amsk-button--ghost"><?php esc_html_e( 'Cancel order', 'anfac-media-safarkaabe' ); ?></button>
				</form>
			<?php endif; ?>
			<p class="amsk-small"><?php esc_html_e( 'Keep this page link to check your order later.', 'anfac-media-safarkaabe' ); ?></p>
		</section>
		<?php
		return ob_get_clean();
	}

	public static function my_orders() {
		self::enqueue();
		$out        = self::notice();
		$order_view = self::order_from_link();
		if ( $order_view ) {
			return $out . self::render_order( $order_view );
		}
		if ( ! is_user_logged_in() ) {
			return $out . '<p class="amsk-empty">' . esc_html__( 'Sign in to see your orders. You can also open the order link we showed you after checkout or sent by email.', 'anfac-media-safarkaabe' ) . '</p>';
		}
		$ids = get_posts( array(
			'post_type'      => 'amsk_order',
			'post_status'    => 'any',
			'posts_per_page' => 50,
			'fields'         => 'ids',
			'meta_key'       => '_amsk_buyer_user', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
			'meta_value'     => get_current_user_id(), // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
		) );
		if ( ! $ids ) {
			return $out . '<p class="amsk-empty">' . esc_html__( 'You have no orders yet.', 'anfac-media-safarkaabe' ) . '</p>';
		}
		$statuses = AMSK_Orders::statuses();
		$out     .= '<ul class="amsk-orders">';
		foreach ( $ids as $id ) {
			$status = AMSK_Orders::meta( $id, 'status' );
			$out   .= sprintf(
				'<li><a href="%1$s">%2$s</a> – %3$s – %4$s</li>',
				esc_url( add_query_arg( array( 'amsk_order' => AMSK_Orders::meta( $id, 'reference' ), 'amsk_key' => AMSK_Orders::meta( $id, 'key' ) ), self::current_url() ) ),
				esc_html( AMSK_Orders::meta( $id, 'reference' ) ),
				esc_html( isset( $statuses[ $status ] ) ? $statuses[ $status ] : $status ),
				esc_html( amsk_money( AMSK_Orders::meta( $id, 'total_cents' ) ) )
			);
		}
		return $out . '</ul>';
	}
}
