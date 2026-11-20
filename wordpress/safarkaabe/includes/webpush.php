<?php
/**
 * Web Push: call and message alerts that reach a phone or computer even when SAFAR KAABE is closed.
 * Standard browser push (RFC 8030/8291/8292): VAPID signing (ES256) and aes128gcm encryption with OpenSSL.
 * No outside service account is needed; the signing key is created once and kept in the {settings} table.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

function skw_b64u_encode( $bytes ) {
	return rtrim( strtr( base64_encode( $bytes ), '+/', '-_' ), '=' );
}

function skw_b64u_decode( $text ) {
	$text = strtr( (string) $text, '-_', '+/' );
	return (string) base64_decode( $text . str_repeat( '=', ( 4 - strlen( $text ) % 4 ) % 4 ), true );
}

function skw_setting( $key ) {
	return SKW_DB::get_var( 'SELECT svalue FROM {settings} WHERE skey = ?', array( $key ) );
}

/** Can this server send push alerts? (Needs PHP 7.3+ OpenSSL with key agreement, and curl.) */
function skw_push_supported() {
	return function_exists( 'openssl_pkey_derive' ) && function_exists( 'curl_init' ) && in_array( 'aes-128-gcm', array_map( 'strtolower', openssl_get_cipher_methods() ), true );
}

function skw_ec_new_key() {
	$options = array( 'private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1' );
	$key     = openssl_pkey_new( $options );
	if ( ! $key && getenv( 'OPENSSL_CONF' ) ) {
		$key = openssl_pkey_new( $options + array( 'config' => getenv( 'OPENSSL_CONF' ) ) );
	}
	if ( ! $key ) {
		throw new RuntimeException( 'OpenSSL could not create a key.' );
	}
	return $key;
}

/** Uncompressed P-256 public point (65 bytes) of a key. */
function skw_ec_public_point( $key ) {
	$d = openssl_pkey_get_details( $key );
	return "\x04" . str_pad( $d['ec']['x'], 32, "\0", STR_PAD_LEFT ) . str_pad( $d['ec']['y'], 32, "\0", STR_PAD_LEFT );
}

/** The server's VAPID key pair, created on first use. Returns array( 'key' => private key, 'public' => base64url ). */
function skw_vapid() {
	static $vapid = null;
	if ( $vapid ) {
		return $vapid;
	}
	$pem = skw_setting( 'vapid_private_pem' );
	if ( ! $pem ) {
		$new = skw_ec_new_key();
		$out = '';
		openssl_pkey_export( $new, $out, null, getenv( 'OPENSSL_CONF' ) ? array( 'config' => getenv( 'OPENSSL_CONF' ) ) : array() );
		try {
			SKW_DB::insert( 'settings', array( 'skey' => 'vapid_private_pem', 'svalue' => $out ) );
		} catch ( Exception $e ) {
			if ( ! SKW_DB::is_duplicate( $e ) ) {
				throw $e;
			}
		}
		$pem = skw_setting( 'vapid_private_pem' ); // Another request may have saved its key first; use that one.
	}
	$key   = openssl_pkey_get_private( $pem );
	$vapid = array( 'key' => $key, 'public' => skw_b64u_encode( skw_ec_public_point( $key ) ) );
	return $vapid;
}

/** OpenSSL gives ECDSA signatures as DER; JWT needs the 64-byte r||s form. */
function skw_ecdsa_der_to_raw( $der ) {
	$pos = 2;
	$raw = '';
	for ( $i = 0; $i < 2; $i++ ) {
		if ( "\x02" !== $der[ $pos ] ) {
			throw new RuntimeException( 'Unexpected signature format.' );
		}
		$len  = ord( $der[ $pos + 1 ] );
		$int  = ltrim( substr( $der, $pos + 2, $len ), "\0" );
		$raw .= str_pad( $int, 32, "\0", STR_PAD_LEFT );
		$pos += 2 + $len;
	}
	return $raw;
}

function skw_vapid_authorization( $endpoint ) {
	global $skw_site_origin;
	$vapid  = skw_vapid();
	$parts  = parse_url( $endpoint );
	$aud    = $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' );
	$sub    = $skw_site_origin && 0 === strpos( $skw_site_origin, 'https://' ) ? $skw_site_origin : 'https://anfacmedia.com';
	$header = skw_b64u_encode( json_encode( array( 'typ' => 'JWT', 'alg' => 'ES256' ) ) );
	$claims = skw_b64u_encode( json_encode( array( 'aud' => $aud, 'exp' => time() + 12 * 3600, 'sub' => $sub ), JSON_UNESCAPED_SLASHES ) );
	$der    = '';
	openssl_sign( $header . '.' . $claims, $der, $vapid['key'], OPENSSL_ALGO_SHA256 );
	return 'vapid t=' . $header . '.' . $claims . '.' . skw_b64u_encode( skw_ecdsa_der_to_raw( $der ) ) . ', k=' . $vapid['public'];
}

/** Encrypts one message for one browser (RFC 8291, aes128gcm). */
function skw_push_encrypt( $payload, $p256dh, $auth ) {
	$ua_public = skw_b64u_decode( $p256dh );
	$secret    = skw_b64u_decode( $auth );
	if ( 65 !== strlen( $ua_public ) || "\x04" !== $ua_public[0] || strlen( $secret ) < 16 ) {
		throw new RuntimeException( 'The browser push keys are not valid.' );
	}
	$local     = skw_ec_new_key();
	$as_public = skw_ec_public_point( $local );
	$ua_pem    = "-----BEGIN PUBLIC KEY-----\n" . chunk_split( base64_encode( hex2bin( '3059301306072a8648ce3d020106082a8648ce3d030107034200' ) . $ua_public ), 64, "\n" ) . "-----END PUBLIC KEY-----\n";
	$ua_key    = openssl_pkey_get_public( $ua_pem );
	$shared    = $ua_key ? openssl_pkey_derive( $ua_key, $local, 32 ) : false;
	if ( ! $shared ) {
		throw new RuntimeException( 'The browser push key could not be used.' );
	}
	$prk_key = hash_hmac( 'sha256', $shared, $secret, true );
	$ikm     = hash_hmac( 'sha256', "WebPush: info\0" . $ua_public . $as_public . "\x01", $prk_key, true );
	$salt    = random_bytes( 16 );
	$prk     = hash_hmac( 'sha256', $ikm, $salt, true );
	$cek     = substr( hash_hmac( 'sha256', "Content-Encoding: aes128gcm\0\x01", $prk, true ), 0, 16 );
	$nonce   = substr( hash_hmac( 'sha256', "Content-Encoding: nonce\0\x01", $prk, true ), 0, 12 );
	$tag     = '';
	$cipher  = openssl_encrypt( $payload . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16 );
	if ( false === $cipher ) {
		throw new RuntimeException( 'The push message could not be encrypted.' );
	}
	return $salt . pack( 'N', 4096 ) . chr( 65 ) . $as_public . $cipher . $tag;
}

/** Only real browser push services (never other addresses, so the server cannot be pointed elsewhere). */
function skw_push_endpoint_allowed( $endpoint ) {
	$parts = parse_url( (string) $endpoint );
	if ( empty( $parts['host'] ) || empty( $parts['scheme'] ) ) {
		return false;
	}
	$host = strtolower( $parts['host'] );
	if ( skw_config( 'push_test_host' ) && $host === skw_config( 'push_test_host' ) ) {
		return true; // Local tests only (set through the test configuration, never on the website).
	}
	if ( 'https' !== $parts['scheme'] ) {
		return false;
	}
	foreach ( array( 'googleapis.com', 'mozilla.com', 'mozaws.net', 'notify.windows.com', 'push.apple.com' ) as $suffix ) {
		if ( $host === $suffix || substr( $host, -strlen( '.' . $suffix ) ) === '.' . $suffix ) {
			return true;
		}
	}
	return false;
}

/**
 * Sends one alert to every browser of a user. $message: title, body, url, type, tag, data, notificationId.
 * Calls use high urgency and a short life (a call alert that arrives a minute late is useless).
 */
function skw_push_to_user( $user_id, $message ) {
	if ( ! $user_id || ! skw_push_supported() ) {
		return 0;
	}
	$subs = SKW_DB::get_results( 'SELECT id, endpoint, p256dh, auth FROM {push_subscriptions} WHERE user_id = ?', array( $user_id ) );
	if ( ! $subs ) {
		return 0;
	}
	$is_call = isset( $message['type'] ) && 0 === strpos( (string) $message['type'], 'CALL_' );
	$json    = json_encode( $message, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	$sent    = 0;
	foreach ( $subs as $sub ) {
		if ( ! skw_push_endpoint_allowed( $sub['endpoint'] ) ) {
			continue;
		}
		try {
			$body = skw_push_encrypt( $json, $sub['p256dh'], $sub['auth'] );
			$ch   = curl_init( $sub['endpoint'] );
			curl_setopt_array( $ch, array(
				CURLOPT_POST           => true,
				CURLOPT_POSTFIELDS     => $body,
				CURLOPT_RETURNTRANSFER => true,
				CURLOPT_CONNECTTIMEOUT => 3,
				CURLOPT_TIMEOUT        => 5,
				CURLOPT_HTTPHEADER     => array(
					'Content-Type: application/octet-stream',
					'Content-Encoding: aes128gcm',
					'TTL: ' . ( $is_call ? 60 : 86400 ),
					'Urgency: ' . ( $is_call ? 'high' : 'normal' ),
					'Authorization: ' . skw_vapid_authorization( $sub['endpoint'] ),
				),
			) );
			curl_exec( $ch );
			$status = (int) curl_getinfo( $ch, CURLINFO_HTTP_CODE );
			curl_close( $ch );
			if ( 404 === $status || 410 === $status ) {
				SKW_DB::query( 'DELETE FROM {push_subscriptions} WHERE id = ?', array( $sub['id'] ) ); // That browser turned alerts off.
			} elseif ( $status >= 200 && $status < 300 ) {
				$sent++;
			} else {
				error_log( 'SAFAR KAABE push: the push service answered ' . $status );
			}
		} catch ( Throwable $e ) {
			error_log( 'SAFAR KAABE push failed: ' . $e->getMessage() );
		}
	}
	return $sent;
}

/** Is the user's quiet time now? (Calls still ring.) */
function skw_push_quiet_now( $prefs ) {
	if ( empty( $prefs['quietHoursEnabled'] ) ) {
		return false;
	}
	try {
		$now = new DateTime( 'now', new DateTimeZone( ! empty( $prefs['timezone'] ) ? $prefs['timezone'] : 'UTC' ) );
	} catch ( Exception $e ) {
		$now = new DateTime( 'now', new DateTimeZone( 'UTC' ) );
	}
	$t     = $now->format( 'H:i' );
	$start = (string) $prefs['quietHoursStart'];
	$end   = (string) $prefs['quietHoursEnd'];
	return $start <= $end ? ( $t >= $start && $t < $end ) : ( $t >= $start || $t < $end );
}

/** Push for a notification that skw_notify just saved, following the person's notification settings. */
function skw_push_for_notification( $item, $notification_id ) {
	$type = (string) $item['type'];
	if ( 'CALL_MISSED' === $type || 'CALL_INCOMING' === $type || ! function_exists( 'skw_get_prefs' ) ) {
		return; // Calls have their own ringing alert (skw_push_call_ring), which also shows a missed call.
	}
	$prefs   = skw_get_prefs( $item['recipientUserId'] );
	$is_call = 'CALL_INCOMING' === $type;
	if ( ! $is_call ) {
		if ( empty( $prefs['desktopPushEnabled'] ) || skw_push_quiet_now( $prefs ) ) {
			return;
		}
		if ( ! empty( $item['conversationId'] ) && in_array( $item['conversationId'], (array) $prefs['mutedConversationIds'], true ) ) {
			return;
		}
		if ( ( false !== strpos( $type, 'PROMO' ) && empty( $prefs['promotionalNotifications'] ) ) || ( false !== strpos( $type, 'BOOKING' ) && empty( $prefs['bookingAlerts'] ) ) ) {
			return;
		}
	}
	$hidden = empty( $prefs['lockScreenPreviews'] ) && ! $is_call;
	$extra  = isset( $item['push'] ) && is_array( $item['push'] ) ? $item['push'] : array();
	skw_push_later( $item['recipientUserId'], array(
		'title'          => $hidden ? 'SAFAR KAABE' : (string) $item['title'],
		'body'           => $hidden ? 'You have a new notification.' : (string) $item['body'],
		'url'            => skw_push_absolute_url( isset( $item['href'] ) ? $item['href'] : '' ),
		'notificationId' => $notification_id,
		'type'           => $type,
		'tag'            => isset( $extra['tag'] ) ? $extra['tag'] : ( ! empty( $item['conversationId'] ) ? 'chat-' . $item['conversationId'] : null ),
		'data'           => isset( $extra['data'] ) ? $extra['data'] : null,
	) );
}

function skw_push_absolute_url( $href ) {
	global $skw_site_origin;
	$href = (string) $href;
	if ( preg_match( '#^https?://#i', $href ) ) {
		return $href;
	}
	if ( '' === $href ) {
		return skw_app_url( '' );
	}
	return rtrim( (string) $skw_site_origin, '/' ) . ( '/' === $href[0] ? $href : skw_app_link( $href ) );
}

/**
 * Alerts are sent after the answer has gone back to the person who acted (sending a message or starting a call),
 * so they never wait for the push services.
 */
function skw_push_later( $user_id, $message ) {
	global $skw_push_queue;
	if ( ! $user_id || ! skw_push_supported() ) {
		return;
	}
	if ( ! is_array( $skw_push_queue ) ) {
		$skw_push_queue = array();
		register_shutdown_function( 'skw_push_flush' );
	}
	$skw_push_queue[] = array( $user_id, $message );
}

function skw_push_flush() {
	global $skw_push_queue;
	$queue          = is_array( $skw_push_queue ) ? $skw_push_queue : array();
	$skw_push_queue = array();
	if ( ! $queue ) {
		return;
	}
	if ( function_exists( 'litespeed_finish_request' ) ) {
		litespeed_finish_request();
	} elseif ( function_exists( 'fastcgi_finish_request' ) ) {
		fastcgi_finish_request();
	}
	foreach ( $queue as $item ) {
		try {
			skw_push_to_user( $item[0], $item[1] );
		} catch ( Throwable $e ) {
			error_log( 'SAFAR KAABE push failed: ' . $e->getMessage() );
		}
	}
}
