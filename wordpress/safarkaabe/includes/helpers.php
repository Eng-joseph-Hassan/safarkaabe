<?php
/**
 * Shared helpers used by every module.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

/** ISO 8601 UTC time with milliseconds, like JavaScript's toISOString(). */
function skw_now( $offset_seconds = 0 ) {
	$t  = microtime( true ) + $offset_seconds;
	$ms = (int) floor( ( $t - floor( $t ) ) * 1000 );
	return gmdate( 'Y-m-d\TH:i:s', (int) floor( $t ) ) . '.' . str_pad( (string) $ms, 3, '0', STR_PAD_LEFT ) . 'Z';
}

function skw_today( $offset_days = 0 ) {
	return gmdate( 'Y-m-d', time() + $offset_days * 86400 );
}

function skw_uuid() {
	$b    = random_bytes( 16 );
	$b[6] = chr( ord( $b[6] ) & 0x0f | 0x40 );
	$b[8] = chr( ord( $b[8] ) & 0x3f | 0x80 );
	return vsprintf( '%s%s-%s-%s-%s-%s%s%s', str_split( bin2hex( $b ), 4 ) );
}

function skw_code( $bytes = 4 ) {
	return strtoupper( bin2hex( random_bytes( $bytes ) ) );
}

/** Settings. In WordPress they come from the "skw_settings" option; in tests from $GLOBALS['skw_test_config']. */
function skw_config( $key, $default = null ) {
	global $skw_config_loader;
	$all = is_callable( $skw_config_loader ) ? call_user_func( $skw_config_loader ) : array();
	return isset( $all[ $key ] ) && '' !== $all[ $key ] ? $all[ $key ] : $default;
}

/** Base path of the app, always with slashes on both ends, e.g. "/safarkaabe/". */
function skw_base() {
	global $skw_base_path;
	return $skw_base_path ? $skw_base_path : '/safarkaabe/';
}

/** Link inside the app, e.g. skw_app_link('?booking=ID') -> "/safarkaabe/?booking=ID". */
function skw_app_link( $suffix = '' ) {
	return skw_base() . ltrim( $suffix, '/' );
}

/** Full address with the site origin (used in emails). */
function skw_app_url( $suffix = '' ) {
	global $skw_site_origin;
	return rtrim( (string) $skw_site_origin, '/' ) . skw_app_link( $suffix );
}

function skw_require_string( $value, $field, $max = 160 ) {
	if ( ! is_string( $value ) || '' === trim( $value ) || mb_strlen( trim( $value ) ) > $max ) {
		throw new SKW_Http_Error( 400, $field . ' is required and must be no longer than ' . $max . ' characters.' );
	}
	return trim( $value );
}

function skw_normalize_email( $value ) {
	$email = strtolower( skw_require_string( $value, 'Email', 254 ) );
	if ( ! preg_match( '/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $email ) ) {
		throw new SKW_Http_Error( 400, 'Enter a valid email address.' );
	}
	return $email;
}

function skw_validate_password( $value ) {
	if ( ! is_string( $value ) || strlen( $value ) < 12 || strlen( $value ) > 256 ) {
		throw new SKW_Http_Error( 400, 'Password must be at least 12 characters long.' );
	}
	return $value;
}

function skw_is_iso_date( $value ) {
	if ( ! is_string( $value ) || ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m ) ) {
		return false;
	}
	return checkdate( (int) $m[2], (int) $m[3], (int) $m[1] );
}

/** Accepts PNG, JPEG or WebP base64 up to $max_bytes. Returns the base64 string. */
function skw_validate_image( $data, $mime, $max_bytes = 262144 ) {
	$kb = (int) ( $max_bytes / 1024 );
	if ( ! in_array( $mime, array( 'image/png', 'image/jpeg', 'image/webp' ), true ) || ! is_string( $data )
		|| strlen( $data ) > (int) ( ceil( $max_bytes / 3 ) * 4 ) || ! preg_match( '/^[A-Za-z0-9+\/]*={0,2}$/', $data ) ) {
		throw new SKW_Http_Error( 400, 'Choose a PNG, JPEG, or WebP image no larger than ' . $kb . ' KB.' );
	}
	$bytes = base64_decode( $data, true );
	if ( false === $bytes || '' === $bytes || strlen( $bytes ) > $max_bytes ) {
		throw new SKW_Http_Error( 400, 'The image must be no larger than ' . $kb . ' KB.' );
	}
	$png  = 'image/png' === $mime && 0 === strpos( $bytes, "\x89PNG\r\n\x1a\n" );
	$jpeg = 'image/jpeg' === $mime && "\xff\xd8" === substr( $bytes, 0, 2 );
	$webp = 'image/webp' === $mime && 'RIFF' === substr( $bytes, 0, 4 ) && 'WEBP' === substr( $bytes, 8, 4 );
	if ( ! $png && ! $jpeg && ! $webp ) {
		throw new SKW_Http_Error( 400, 'The selected file is not a valid PNG, JPEG, or WebP image.' );
	}
	return $data;
}

function skw_audit( $actor_id, $action, $target ) {
	SKW_DB::insert( 'audit_logs', array(
		'id'         => skw_uuid(),
		'actor_id'   => $actor_id ? $actor_id : null,
		'action'     => $action,
		'target'     => (string) $target,
		'created_at' => skw_now(),
	) );
}

/**
 * Fixed-window rate limit. Returns true while under the limit.
 */
function skw_rate_limit( $key, $limit, $seconds ) {
	$now = time();
	$row = SKW_DB::get_row( 'SELECT attempts, expires_at FROM {rate_limits} WHERE rl_key = ?', array( $key ) );
	if ( ! $row || (int) $row['expires_at'] <= $now ) {
		SKW_DB::upsert( 'rate_limits', array( 'rl_key' => $key, 'attempts' => 1, 'expires_at' => $now + $seconds ), array( 'rl_key' ) );
		return 1 <= $limit;
	}
	SKW_DB::query( 'UPDATE {rate_limits} SET attempts = attempts + 1 WHERE rl_key = ?', array( $key ) );
	return (int) $row['attempts'] + 1 <= $limit;
}

function skw_rate_limited( $key ) {
	$row = SKW_DB::get_row( 'SELECT attempts, expires_at FROM {rate_limits} WHERE rl_key = ?', array( $key ) );
	return $row && (int) $row['expires_at'] > time() ? (int) $row['attempts'] : 0;
}

function skw_rate_clear( $key ) {
	SKW_DB::query( 'DELETE FROM {rate_limits} WHERE rl_key = ?', array( $key ) );
}

/**
 * Saves notifications (one per dedupe key). $items: recipientUserId, type, title, body, href,
 * dedupeKey and optional agencyId, bookingId, conversationId.
 */
function skw_notify( $items ) {
	$created = 0;
	foreach ( $items as $item ) {
		if ( empty( $item['recipientUserId'] ) ) {
			continue;
		}
		try {
			$notification_id = skw_uuid();
			$created += SKW_DB::insert( 'notifications', array(
				'id'                => $notification_id,
				'recipient_user_id' => $item['recipientUserId'],
				'agency_id'         => isset( $item['agencyId'] ) ? $item['agencyId'] : null,
				'booking_id'        => isset( $item['bookingId'] ) ? $item['bookingId'] : null,
				'conversation_id'   => isset( $item['conversationId'] ) ? $item['conversationId'] : null,
				'type'              => $item['type'],
				'title'             => mb_substr( (string) $item['title'], 0, 160 ),
				'body'              => mb_substr( (string) $item['body'], 0, 500 ),
				'href'              => isset( $item['href'] ) ? $item['href'] : null,
				'dedupe_key'        => isset( $item['dedupeKey'] ) ? $item['dedupeKey'] : skw_uuid(),
				'created_at'        => skw_now(),
				'read_at'           => null,
			) );
			if ( function_exists( 'skw_push_for_notification' ) ) {
				skw_push_for_notification( $item, $notification_id ); // Alert on the phone too, even when the app is closed.
			}
		} catch ( Exception $error ) {
			if ( ! SKW_DB::is_duplicate( $error ) ) {
				error_log( 'SAFAR KAABE notification failed: ' . $error->getMessage() );
			}
		}
	}
	return $created;
}

function skw_agency_staff_ids( $agency_id ) {
	return array_column( SKW_DB::get_results( "SELECT id FROM {users} WHERE agency_id = ? AND role = 'AGENCY'", array( $agency_id ) ), 'id' );
}

function skw_admin_ids() {
	return array_column( SKW_DB::get_results( "SELECT id FROM {users} WHERE role = 'SUPER_ADMIN'" ), 'id' );
}

/** Sends an email (wp_mail on the website, saved to a file in tests). Returns true when handed over. */
function skw_mail( $to, $subject, $text ) {
	global $skw_mailer;
	if ( is_callable( $skw_mailer ) ) {
		return (bool) call_user_func( $skw_mailer, $to, $subject, $text );
	}
	return false;
}

/** Money: cents -> "70.50". */
function skw_money( $cents ) {
	return number_format( ( (int) $cents ) / 100, 2, '.', '' );
}

/** Integer-safe reading of a JSON number. */
function skw_int( $value ) {
	if ( is_int( $value ) ) {
		return $value;
	}
	if ( is_float( $value ) && floor( $value ) === $value ) {
		return (int) $value;
	}
	if ( is_string( $value ) && preg_match( '/^-?\d+$/', $value ) ) {
		return (int) $value;
	}
	return null;
}
