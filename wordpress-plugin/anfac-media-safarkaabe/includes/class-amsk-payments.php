<?php
/**
 * Pay by phone through WaafiPay (EVC Plus, Zaad, Sahal) and eDahab.
 * A PHP port of the request format used by the marupay package (https://github.com/iamshabell/marupay).
 *
 * Every charge ends in one of three results:
 *   paid    – the provider confirmed the money was taken;
 *   failed  – the provider clearly refused (no money taken);
 *   unknown – anything unclear (timeout, network error, unexpected reply). Never treated as failed,
 *             because the customer may still approve the PIN prompt. The shop owner checks the merchant portal.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AMSK_Payments {

	public static function available() {
		$s = AMSK_Settings::get();
		return array(
			'waafi'  => (int) $s['waafi_enabled'] === 1 && $s['waafi_merchant_uid'] && $s['waafi_api_user_id'] && $s['waafi_api_key'],
			'edahab' => (int) $s['edahab_enabled'] === 1 && $s['edahab_agent_code'] && $s['edahab_api_key'] && $s['edahab_secret_key'],
			'seller' => (int) $s['pay_seller_enabled'] === 1,
		);
	}

	/**
	 * Accepts 61xxxxxxx, 061..., 252..., +252..., 00252... (spaces and dashes allowed).
	 * Returns "2526XXXXXXXX" style (252 + 9 digits starting with 6, 7 or 9), or null.
	 */
	public static function normalize_phone( $raw ) {
		$digits = preg_replace( '/[\s\-().]/', '', (string) $raw );
		if ( 0 === strpos( $digits, '+' ) ) {
			$digits = substr( $digits, 1 );
		}
		if ( 0 === strpos( $digits, '00252' ) ) {
			$digits = substr( $digits, 2 );
		}
		if ( ! ctype_digit( $digits ) ) {
			return null;
		}
		if ( 0 === strpos( $digits, '252' ) ) {
			$local = substr( $digits, 3 );
		} elseif ( 0 === strpos( $digits, '0' ) ) {
			$local = substr( $digits, 1 );
		} else {
			$local = $digits;
		}
		return preg_match( '/^[679]\d{8}$/', $local ) ? '252' . $local : null;
	}

	/**
	 * Charges a phone. $provider is "waafi" or "edahab"; $amount_cents in US cents.
	 * Returns array( 'status' => paid|failed|unknown, 'transaction_id' => string, 'message' => plain-language text ).
	 */
	public static function charge( $provider, $phone, $amount_cents, $description ) {
		$amount = round( ( (int) $amount_cents ) / 100, 2 );
		if ( 'edahab' === $provider ) {
			return self::charge_edahab( $phone, $amount, $description );
		}
		return self::charge_waafi( $phone, $amount, $description );
	}

	private static function uuid() {
		return function_exists( 'wp_generate_uuid4' ) ? wp_generate_uuid4() : md5( uniqid( '', true ) );
	}

	private static function unknown( $message ) {
		return array(
			'status'         => 'unknown',
			'transaction_id' => '',
			'message'        => $message ? $message : __( 'We could not confirm the payment yet. Please do not pay again; we will check and contact you.', 'anfac-media-safarkaabe' ),
		);
	}

	private static function post_json( $url, $body_json ) {
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 90 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}
		return wp_remote_post( $url, array(
			'timeout'     => 45,
			'redirection' => 0,
			'headers'     => array( 'Content-Type' => 'application/json' ),
			'body'        => $body_json,
		) );
	}

	private static function charge_waafi( $phone, $amount, $description ) {
		$s         = AMSK_Settings::get();
		$reference = self::uuid();
		$body      = array(
			'schemaVersion' => '1.0',
			'requestId'     => self::uuid(),
			'timestamp'     => gmdate( 'Y-m-d H:i:s' ),
			'channelName'   => 'WEB',
			'serviceName'   => 'API_PURCHASE',
			'serviceParams' => array(
				'merchantUid'     => $s['waafi_merchant_uid'],
				'apiUserId'       => $s['waafi_api_user_id'],
				'apiKey'          => $s['waafi_api_key'],
				'paymentMethod'   => 'MWALLET_ACCOUNT',
				'payerInfo'       => array( 'accountNo' => $phone ),
				'transactionInfo' => array(
					'referenceId' => $reference,
					'invoiceId'   => self::uuid(),
					'amount'      => $amount,
					'currency'    => 'USD',
					'description' => $description,
				),
			),
		);
		$response = self::post_json( $s['waafi_base_url'], wp_json_encode( $body ) );
		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return self::unknown( '' );
		}
		$data = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $data ) ) {
			return self::unknown( '' );
		}
		$code      = isset( $data['responseCode'] ) ? (string) $data['responseCode'] : '';
		$msg       = isset( $data['responseMsg'] ) ? (string) $data['responseMsg'] : '';
		$error     = isset( $data['errorCode'] ) ? (string) $data['errorCode'] : '';
		$params    = isset( $data['params'] ) && is_array( $data['params'] ) ? $data['params'] : null;
		if ( '2001' === $code && $params ) {
			return array( 'status' => 'paid', 'transaction_id' => isset( $params['transactionId'] ) ? (string) $params['transactionId'] : $reference, 'message' => __( 'Payment received. Thank you!', 'anfac-media-safarkaabe' ) );
		}
		if ( 'E101073' === $error ) {
			return array( 'status' => 'failed', 'transaction_id' => '', 'message' => __( 'There is not enough money in the wallet. No money was taken.', 'anfac-media-safarkaabe' ) );
		}
		if ( 'RCS_NO_ROUTE_FOUND' === $msg ) {
			return array( 'status' => 'failed', 'transaction_id' => '', 'message' => __( 'This number is not registered for EVC Plus, Zaad or Sahal. No money was taken.', 'anfac-media-safarkaabe' ) );
		}
		if ( 'RCS_USER_REJECTED' === $msg || 'E10205' === $error ) {
			return array( 'status' => 'failed', 'transaction_id' => '', 'message' => __( 'The payment was not approved on the phone. No money was taken.', 'anfac-media-safarkaabe' ) );
		}
		return self::unknown( '' );
	}

	private static function charge_edahab( $phone, $amount, $description ) {
		$s    = AMSK_Settings::get();
		$body = array(
			'apiKey'       => $s['edahab_api_key'],
			'edahabNumber' => substr( $phone, 3 ),
			'amount'       => $amount,
			'currency'     => 'USD',
			'agentCode'    => $s['edahab_agent_code'],
			'description'  => $description,
		);
		// The hash must be made from exactly the JSON text that is sent.
		$json     = wp_json_encode( $body, JSON_UNESCAPED_SLASHES );
		$hash     = hash( 'sha256', $json . $s['edahab_secret_key'] );
		$response = self::post_json( $s['edahab_base_url'] . '/api/issueinvoice?hash=' . $hash, $json );
		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return self::unknown( '' );
		}
		$data = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $data ) ) {
			return self::unknown( '' );
		}
		$status = isset( $data['InvoiceStatus'] ) ? (string) $data['InvoiceStatus'] : '';
		if ( 'Paid' === $status ) {
			return array( 'status' => 'paid', 'transaction_id' => isset( $data['TransactionId'] ) ? (string) $data['TransactionId'] : '', 'message' => __( 'Payment received. Thank you!', 'anfac-media-safarkaabe' ) );
		}
		if ( ! empty( $data['ValidationErrors'][0]['Property'] ) && 'EDahabNumber' === $data['ValidationErrors'][0]['Property'] ) {
			return array( 'status' => 'failed', 'transaction_id' => '', 'message' => __( 'This number is not registered for eDahab. No money was taken.', 'anfac-media-safarkaabe' ) );
		}
		if ( isset( $data['StatusCode'] ) && 5 === (int) $data['StatusCode'] ) {
			return array( 'status' => 'failed', 'transaction_id' => '', 'message' => __( 'There is not enough money in the eDahab wallet. No money was taken.', 'anfac-media-safarkaabe' ) );
		}
		if ( in_array( strtolower( $status ), array( 'rejected', 'declined', 'cancelled', 'canceled', 'failed' ), true ) ) {
			return array( 'status' => 'failed', 'transaction_id' => '', 'message' => __( 'The payment was not approved. No money was taken.', 'anfac-media-safarkaabe' ) );
		}
		return self::unknown( '' );
	}

	/** Simple rate limit with transients. Returns false when the limit is reached. */
	public static function allow( $key, $limit, $seconds ) {
		$name  = 'amsk_rl_' . md5( $key );
		$count = (int) get_transient( $name );
		if ( $count >= $limit ) {
			return false;
		}
		set_transient( $name, $count + 1, $seconds );
		return true;
	}
}
