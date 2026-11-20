<?php
/**
 * Serves the SAFAR KAABE app at <base> (page, icons, images, service worker) and its API at <base>api/.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

function skw_load_modules() {
	static $loaded = false;
	if ( $loaded ) {
		return;
	}
	$loaded = true;
	foreach ( glob( SKW_DIR . 'modules/*.php' ) as $file ) {
		require_once $file;
	}
}

/**
 * Handles a request whose path is inside the app. $rel is the path after the base, without a leading slash
 * (e.g. "", "index.html", "logo-mark.png", "api/catalog").
 */
function skw_handle( $method, $rel, $req ) {
	$rel = ltrim( $rel, '/' );
	if ( 0 === strpos( $rel, 'api/' ) || 'api' === $rel ) {
		skw_load_modules();
		$req['method'] = $method;
		$req['path']   = '/' . $rel;
		skw_dispatch( $req );
		return;
	}
	skw_serve_static( $rel );
}

function skw_serve_static( $rel ) {
	$types = array(
		'html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8',
		'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'svg' => 'image/svg+xml',
		'ico' => 'image/x-icon', 'webmanifest' => 'application/manifest+json', 'json' => 'application/json', 'mp4' => 'video/mp4',
	);
	$file = rawurldecode( $rel );
	if ( '' === $file || '/' === substr( $file, -1 ) ) {
		$file = 'index.html';
	}
	$ext  = strtolower( pathinfo( $file, PATHINFO_EXTENSION ) );
	$root = realpath( SKW_DIR . 'app' );
	$path = realpath( SKW_DIR . 'app/' . $file );
	// Only real files inside app/ with a known type; everything else is the app page (single-page app).
	if ( false !== strpos( $file, '..' ) || ! $path || 0 !== strpos( $path, $root . DIRECTORY_SEPARATOR ) || ! is_file( $path ) || ! isset( $types[ $ext ] ) ) {
		if ( $ext && 'html' !== $ext ) {
			http_response_code( 404 );
			header( 'Content-Type: text/plain; charset=utf-8' );
			echo 'Not found';
			return;
		}
		$path = $root . DIRECTORY_SEPARATOR . 'index.html';
		$ext  = 'html';
	}
	http_response_code( 200 );
	header( 'Content-Type: ' . $types[ $ext ] );
	header( 'X-Content-Type-Options: nosniff' );
	header( 'X-Robots-Tag: noindex, nofollow' );
	if ( 'html' === $ext || 'sw.js' === basename( $path ) || 'webmanifest' === $ext ) {
		header( 'Cache-Control: no-cache' );
		header( 'X-LiteSpeed-Cache-Control: no-cache' );
		if ( 'html' === $ext ) {
			header( "Content-Security-Policy: frame-ancestors 'self'" );
		}
		if ( 'sw.js' === basename( $path ) ) {
			header( 'Service-Worker-Allowed: ' . skw_base() );
		}
	} else {
		header( 'Cache-Control: public, max-age=604800' );
	}
	if ( 'html' === $ext ) {
		skw_send_page( $path );
		return;
	}
	header( 'Content-Length: ' . filesize( $path ) );
	readfile( $path );
}

/** Where the browser loads images, styles and the video from (directly from the hosting, without PHP). */
function skw_asset_base() {
	global $skw_asset_base;
	return is_string( $skw_asset_base ) ? $skw_asset_base : '';
}

/**
 * Sends the app page. When a person opens it, the first answers the app needs (setup, sign-in, trips, bookings ...)
 * are put inside the page, so it starts without waiting for more trips to the server.
 */
function skw_send_page( $path ) {
	$html = str_replace( '%%SKW_ASSETS%%', htmlspecialchars( skw_asset_base(), ENT_QUOTES ), (string) file_get_contents( $path ) );
	$req  = skw_request_from_globals();
	$mode = isset( $req['headers']['sec-fetch-mode'] ) ? strtolower( (string) $req['headers']['sec-fetch-mode'] ) : '';
	$boot = '';
	if ( 'navigate' === $mode && 'GET' === $req['method'] ) {
		try {
			$boot = skw_boot_script( $req );
		} catch ( Throwable $e ) {
			error_log( 'SAFAR KAABE start-up data: ' . $e->getMessage() );
			$boot = '';
		}
	}
	if ( '' !== $boot ) {
		// Personal data: never store this copy anywhere.
		header( 'Cache-Control: private, no-store' );
		header( 'Vary: Cookie', false );
	}
	$html = str_replace( '<!--SKW_BOOT-->', $boot, $html );
	header( 'Content-Length: ' . strlen( $html ) );
	echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- the app page.
}

/** Runs one GET API route inside this request. Returns the JSON text, or null when it did not answer 200. */
function skw_internal_get( $api_path, $req ) {
	global $skw_capture_status;
	skw_load_modules();
	$req['method']      = 'GET';
	$req['path']        = $api_path;
	$req['body']        = '';
	$req['query']       = array();
	$skw_capture_status = 0;
	ob_start();
	try {
		skw_dispatch( $req );
	} finally {
		$out                = (string) ob_get_clean();
		$status             = $skw_capture_status;
		$skw_capture_status = null;
	}
	return 200 === $status && '' !== $out ? $out : null;
}

function skw_boot_script( $req ) {
	$answers = array();
	$get     = function ( $p ) use ( &$answers, $req ) {
		$json = skw_internal_get( '/' . $p, $req );
		if ( null !== $json ) {
			$answers[ $p ] = $json;
		}
		return $json;
	};
	$status = json_decode( (string) $get( 'api/setup/status' ), true );
	if ( empty( $status['configured'] ) ) {
		return '';
	}
	$session = json_decode( (string) $get( 'api/auth/session' ), true );
	$user    = is_array( $session ) && ! empty( $session['user'] ) ? $session['user'] : null;
	if ( $user ) {
		$get( 'api/portal/summary' );
		$get( 'api/bookings' );
		$get( 'api/catalog' );
		if ( isset( $user['role'] ) && 'CLIENT' === $user['role'] ) {
			$get( 'api/saved-offers' );
			$get( 'api/waitlist' );
		}
		foreach ( array( 'api/notifications', 'api/conversations', 'api/blocks', 'api/statuses', 'api/notification-preferences', 'api/calls/active' ) as $p ) {
			$get( $p );
		}
	} else {
		$get( 'api/agencies/active' );
		$get( 'api/catalog' );
	}
	$get( 'api/payments/methods' );
	$get( 'api/catalog/realtime' );
	$parts = array();
	foreach ( $answers as $p => $json ) {
		// "<" only appears inside JSON strings, where < means the same; this keeps </script> out of the page.
		$parts[] = json_encode( $p ) . ':' . str_replace( '<', '<', $json );
	}
	return '<script>window.__SKW_BOOT__={' . implode( ',', $parts ) . '};</script>';
}

/** Builds the request array from PHP globals. */
function skw_request_from_globals() {
	$headers = array();
	foreach ( $_SERVER as $k => $v ) {
		if ( 0 === strpos( $k, 'HTTP_' ) ) {
			$headers[ strtolower( str_replace( '_', '-', substr( $k, 5 ) ) ) ] = $v;
		}
	}
	if ( isset( $_SERVER['CONTENT_TYPE'] ) ) {
		$headers['content-type'] = $_SERVER['CONTENT_TYPE'];
	}
	$query = array();
	if ( isset( $_SERVER['QUERY_STRING'] ) ) {
		parse_str( $_SERVER['QUERY_STRING'], $query );
	}
	$secure  = ( ! empty( $_SERVER['HTTPS'] ) && 'off' !== $_SERVER['HTTPS'] ) || ( isset( $headers['x-forwarded-proto'] ) && 'https' === $headers['x-forwarded-proto'] );
	$cookies = $_COOKIE;
	// WordPress adds backslashes to cookies, headers and the query; remove them again.
	if ( function_exists( 'wp_unslash' ) ) {
		$headers = wp_unslash( $headers );
		$cookies = wp_unslash( $cookies );
		$query   = wp_unslash( $query );
	}
	return array(
		'method'  => isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( $_SERVER['REQUEST_METHOD'] ) : 'GET',
		'headers' => $headers,
		'cookies' => $cookies,
		'query'   => $query,
		'ip'      => isset( $_SERVER['REMOTE_ADDR'] ) ? substr( (string) $_SERVER['REMOTE_ADDR'], 0, 64 ) : 'unknown',
		'host'    => isset( $headers['host'] ) ? $headers['host'] : '',
		'secure'  => $secure,
		'body'    => in_array( isset( $_SERVER['REQUEST_METHOD'] ) ? $_SERVER['REQUEST_METHOD'] : 'GET', array( 'POST', 'PUT', 'PATCH', 'DELETE' ), true ) ? (string) file_get_contents( 'php://input' ) : '',
	);
}
