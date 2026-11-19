<?php
/**
 * Cart (a cookie holding product IDs and quantities only) and the form handlers:
 * add to cart, update cart, checkout, and buyer cancel. Prices and stock are always read from the database.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AMSK_Cart {
	const COOKIE = 'amsk_cart';

	public static function register() {
		foreach ( array( 'amsk_add_to_cart', 'amsk_update_cart', 'amsk_checkout', 'amsk_buyer_cancel' ) as $action ) {
			add_action( 'admin_post_' . $action, array( __CLASS__, 'handle_' . substr( $action, 5 ) ) );
			add_action( 'admin_post_nopriv_' . $action, array( __CLASS__, 'handle_' . substr( $action, 5 ) ) );
		}
	}

	/** Returns array( product_id => quantity ) with only sellable products. */
	public static function get() {
		$raw  = isset( $_COOKIE[ self::COOKIE ] ) ? sanitize_text_field( wp_unslash( $_COOKIE[ self::COOKIE ] ) ) : '';
		$cart = array();
		foreach ( explode( ',', $raw ) as $pair ) {
			$parts = explode( ':', $pair );
			if ( 2 !== count( $parts ) ) {
				continue;
			}
			$id  = absint( $parts[0] );
			$qty = absint( $parts[1] );
			if ( $id && $qty >= 1 && $qty <= 100 && AMSK_Products::get_sellable( $id ) ) {
				$cart[ $id ] = $qty;
			}
			if ( count( $cart ) >= 50 ) {
				break;
			}
		}
		return $cart;
	}

	private static function save( $cart ) {
		$pairs = array();
		foreach ( $cart as $id => $qty ) {
			if ( $qty > 0 ) {
				$pairs[] = absint( $id ) . ':' . min( 100, absint( $qty ) );
			}
		}
		$value   = implode( ',', $pairs );
		$expires = $value ? time() + 30 * DAY_IN_SECONDS : time() - HOUR_IN_SECONDS;
		setcookie( self::COOKIE, $value, array(
			'expires'  => $expires,
			'path'     => COOKIEPATH ? COOKIEPATH : '/',
			'domain'   => COOKIE_DOMAIN,
			'secure'   => is_ssl(),
			'httponly' => true,
			'samesite' => 'Lax',
		) );
	}

	/** Safe place to send the visitor back to (only this site). */
	private static function back_url( $fallback = '' ) {
		$url = isset( $_POST['amsk_return'] ) ? esc_url_raw( wp_unslash( $_POST['amsk_return'] ) ) : '';
		$url = wp_validate_redirect( $url, $fallback ? $fallback : home_url( '/' ) );
		return remove_query_arg( array( 'amsk_msg', 'amsk_err', 'amsk_order', 'amsk_key' ), $url );
	}

	private static function finish( $url, $args = array() ) {
		wp_safe_redirect( add_query_arg( $args, $url ) );
		exit;
	}

	private static function check_nonce( $action ) {
		$nonce = isset( $_POST['amsk_nonce'] ) ? sanitize_text_field( wp_unslash( $_POST['amsk_nonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, $action ) ) {
			wp_die( esc_html__( 'This page has expired. Go back, refresh the page and try again.', 'anfac-media-safarkaabe' ), 403 );
		}
	}

	public static function handle_add_to_cart() {
		self::check_nonce( 'amsk_cart' );
		$back = self::back_url();
		$id   = isset( $_POST['product_id'] ) ? absint( $_POST['product_id'] ) : 0;
		$qty  = isset( $_POST['quantity'] ) ? max( 1, min( 100, absint( $_POST['quantity'] ) ) ) : 1;
		if ( ! AMSK_Products::get_sellable( $id ) ) {
			self::finish( $back, array( 'amsk_err' => 'unavailable' ) );
		}
		$cart        = self::get();
		$cart[ $id ] = min( 100, ( isset( $cart[ $id ] ) ? $cart[ $id ] : 0 ) + $qty );
		self::save( $cart );
		$cart_page = isset( $_POST['amsk_cart_url'] ) ? wp_validate_redirect( esc_url_raw( wp_unslash( $_POST['amsk_cart_url'] ) ), '' ) : '';
		self::finish( $cart_page ? $cart_page : $back, array( 'amsk_msg' => 'added' ) );
	}

	public static function handle_update_cart() {
		self::check_nonce( 'amsk_cart' );
		$back = self::back_url();
		$cart = self::get();
		$qtys = isset( $_POST['qty'] ) && is_array( $_POST['qty'] ) ? wp_unslash( $_POST['qty'] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- each value is absint()ed below.
		foreach ( $qtys as $id => $qty ) {
			$id = absint( $id );
			if ( isset( $cart[ $id ] ) ) {
				$cart[ $id ] = min( 100, absint( $qty ) );
			}
		}
		if ( isset( $_POST['remove'] ) ) {
			unset( $cart[ absint( $_POST['remove'] ) ] );
		}
		self::save( array_filter( $cart ) );
		self::finish( $back, array( 'amsk_msg' => 'updated' ) );
	}

	public static function handle_checkout() {
		self::check_nonce( 'amsk_checkout' );
		$back   = self::back_url();
		$name   = isset( $_POST['buyer_name'] ) ? sanitize_text_field( wp_unslash( $_POST['buyer_name'] ) ) : '';
		$phone  = isset( $_POST['buyer_phone'] ) ? sanitize_text_field( wp_unslash( $_POST['buyer_phone'] ) ) : '';
		$email  = isset( $_POST['buyer_email'] ) ? sanitize_email( wp_unslash( $_POST['buyer_email'] ) ) : '';
		$note   = isset( $_POST['buyer_note'] ) ? sanitize_textarea_field( wp_unslash( $_POST['buyer_note'] ) ) : '';
		$method = isset( $_POST['payment_method'] ) ? sanitize_key( wp_unslash( $_POST['payment_method'] ) ) : '';
		$available = AMSK_Payments::available();
		if ( '' === $name || strlen( $name ) > 120 || '' === $phone || strlen( $phone ) > 40 || strlen( $note ) > 1000 ) {
			self::finish( $back, array( 'amsk_err' => 'details' ) );
		}
		if ( ! in_array( $method, array( 'seller', 'waafi', 'edahab' ), true ) || empty( $available[ $method ] ) ) {
			self::finish( $back, array( 'amsk_err' => 'method' ) );
		}
		$pay_phone = null;
		if ( 'seller' !== $method ) {
			$pay_phone = AMSK_Payments::normalize_phone( $phone );
			if ( ! $pay_phone ) {
				self::finish( $back, array( 'amsk_err' => 'phone' ) );
			}
			$ip = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : 'unknown';
			if ( ! AMSK_Payments::allow( 'ip:' . $ip, 10, HOUR_IN_SECONDS ) || ! AMSK_Payments::allow( 'phone:' . $pay_phone, 5, HOUR_IN_SECONDS ) ) {
				self::finish( $back, array( 'amsk_err' => 'limit' ) );
			}
		}
		$order_id = AMSK_Orders::create( self::get(), array( 'name' => $name, 'phone' => $phone, 'email' => $email, 'note' => $note ), $method );
		if ( is_wp_error( $order_id ) ) {
			set_transient( 'amsk_err_' . md5( $phone . $name ), $order_id->get_error_message(), 120 );
			self::finish( $back, array( 'amsk_err' => 'order', 'amsk_ek' => md5( $phone . $name ) ) );
		}
		update_post_meta( $order_id, '_amsk_page_url', $back );
		self::save( array() );
		if ( 'seller' !== $method ) {
			AMSK_Orders::charge( $order_id, $method, $pay_phone );
		}
		self::finish( $back, array(
			'amsk_order' => AMSK_Orders::meta( $order_id, 'reference' ),
			'amsk_key'   => AMSK_Orders::meta( $order_id, 'key' ),
		) );
	}

	public static function handle_buyer_cancel() {
		self::check_nonce( 'amsk_buyer_cancel' );
		$back     = self::back_url();
		$order_id = AMSK_Orders::find_by_key(
			isset( $_POST['amsk_order'] ) ? sanitize_text_field( wp_unslash( $_POST['amsk_order'] ) ) : '',
			isset( $_POST['amsk_key'] ) ? sanitize_text_field( wp_unslash( $_POST['amsk_key'] ) ) : ''
		);
		if ( ! $order_id ) {
			self::finish( $back, array( 'amsk_err' => 'notfound' ) );
		}
		$ok = AMSK_Orders::buyer_cancel( $order_id );
		self::finish( $back, array(
			'amsk_order' => AMSK_Orders::meta( $order_id, 'reference' ),
			'amsk_key'   => AMSK_Orders::meta( $order_id, 'key' ),
			'amsk_msg'   => $ok ? 'cancelled' : 'nocancel',
		) );
	}
}
