<?php
/**
 * Accounts and sessions. Same cookies and checks as the SAFAR KAABE app, so its page works unchanged:
 * sk_session (HttpOnly) + sk_csrf (read by the page and sent back in the X-CSRF-Token header).
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

const SKW_SESSION_SECONDS = 604800; // 7 days

function skw_public_user( $u ) {
	return array(
		'id'               => $u['id'],
		'email'            => $u['email'],
		'name'             => $u['name'],
		'phone'            => isset( $u['phone'] ) && $u['phone'] ? $u['phone'] : '',
		'role'             => $u['role'],
		'agencyId'         => ! empty( $u['agency_id'] ) ? $u['agency_id'] : null,
		'avatarMime'       => ! empty( $u['avatar_mime'] ) ? $u['avatar_mime'] : null,
		'avatarData'       => ! empty( $u['avatar_data'] ) ? $u['avatar_data'] : null,
		'presenceStatus'   => ! empty( $u['presence_status'] ) ? $u['presence_status'] : 'AVAILABLE',
		'lastSeenAt'       => ! empty( $u['last_seen_at'] ) ? $u['last_seen_at'] : null,
		'loginCodeEnabled' => isset( $u['login_code_enabled'] ) && 1 === (int) $u['login_code_enabled'],
		'themePreference'  => isset( $u['theme_preference'] ) && in_array( $u['theme_preference'], array( 'light', 'dark', 'system' ), true ) ? $u['theme_preference'] : null,
	);
}

function skw_hash_password( $password ) {
	return password_hash( $password, PASSWORD_DEFAULT );
}

function skw_cookie_header( $name, $value, $max_age, $http_only ) {
	$secure = skw_req( 'secure' ) ? '; Secure' : '';
	return $name . '=' . rawurlencode( $value ) . '; Path=' . skw_base() . '; Max-Age=' . (int) $max_age . '; SameSite=Strict' . ( $http_only ? '; HttpOnly' : '' ) . $secure;
}

function skw_create_session( $user ) {
	$token = rtrim( strtr( base64_encode( random_bytes( 32 ) ), '+/', '-_' ), '=' );
	$csrf  = rtrim( strtr( base64_encode( random_bytes( 32 ) ), '+/', '-_' ), '=' );
	SKW_DB::insert( 'sessions', array(
		'id_hash'    => hash( 'sha256', $token ),
		'user_id'    => $user['id'],
		'csrf_hash'  => hash( 'sha256', $csrf ),
		'expires_at' => time() + SKW_SESSION_SECONDS,
		'created_at' => skw_now(),
	) );
	skw_header( 'Set-Cookie', skw_cookie_header( 'sk_session', $token, SKW_SESSION_SECONDS, true ) );
	skw_header( 'Set-Cookie', skw_cookie_header( 'sk_csrf', $csrf, SKW_SESSION_SECONDS, false ) );
}

function skw_clear_session_cookies() {
	skw_header( 'Set-Cookie', skw_cookie_header( 'sk_session', '', 0, true ) );
	skw_header( 'Set-Cookie', skw_cookie_header( 'sk_csrf', '', 0, false ) );
}

/** The signed-in user row (array) or null. Cached per request. */
function skw_current_user() {
	global $skw_request;
	if ( array_key_exists( 'user_cache', (array) $skw_request ) ) {
		return $skw_request['user_cache'];
	}
	$user    = null;
	$cookies = skw_req( 'cookies' );
	$token   = isset( $cookies['sk_session'] ) ? $cookies['sk_session'] : '';
	if ( $token ) {
		$row = SKW_DB::get_row(
			'SELECT s.id_hash AS session_hash, s.csrf_hash, u.* FROM {sessions} s JOIN {users} u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?',
			array( hash( 'sha256', $token ), time() )
		);
		if ( $row ) {
			if ( 'AGENCY' === $row['role'] && ! SKW_DB::get_var( "SELECT 1 FROM {agencies} WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1", array( $row['agency_id'] ) ) ) {
				$row = null;
			}
			$user = $row;
		}
	}
	$skw_request['user_cache'] = $user;
	return $user;
}

/** Requires a signed-in user with one of $roles. Returns the user. */
function skw_require_role( $roles = array( 'SUPER_ADMIN', 'AGENCY', 'CLIENT' ) ) {
	$user = skw_current_user();
	if ( ! $user ) {
		throw new SKW_Http_Error( 401, 'Sign in to continue.' );
	}
	if ( ! in_array( $user['role'], (array) $roles, true ) ) {
		throw new SKW_Http_Error( 403, 'Your account does not have permission to perform this action.' );
	}
	return $user;
}

/** Same check as the app: same-origin request and a matching CSRF token. */
function skw_require_csrf() {
	$headers = skw_req( 'headers' );
	$origin  = isset( $headers['origin'] ) ? $headers['origin'] : '';
	$host    = skw_req( 'host' );
	if ( $origin && $origin !== 'http://' . $host && $origin !== 'https://' . $host ) {
		throw new SKW_Http_Error( 403, 'Cross-origin requests are not allowed.' );
	}
	$user    = skw_current_user();
	$cookies = skw_req( 'cookies' );
	$token   = isset( $headers['x-csrf-token'] ) ? (string) $headers['x-csrf-token'] : '';
	$cookie  = isset( $cookies['sk_csrf'] ) ? (string) $cookies['sk_csrf'] : '';
	if ( ! $user || '' === $token || ! hash_equals( $cookie, $token ) || ! hash_equals( (string) $user['csrf_hash'], hash( 'sha256', $token ) ) ) {
		throw new SKW_Http_Error( 403, 'You were signed out for your safety. Sign in again to continue.' );
	}
}

/** Signed-in mutation helper: role check + CSRF. */
function skw_mutation( $roles = array( 'SUPER_ADMIN', 'AGENCY', 'CLIENT' ) ) {
	$user = skw_require_role( $roles );
	skw_require_csrf();
	return $user;
}

function skw_user_by_id( $id ) {
	return SKW_DB::get_row( 'SELECT * FROM {users} WHERE id = ?', array( $id ) );
}
