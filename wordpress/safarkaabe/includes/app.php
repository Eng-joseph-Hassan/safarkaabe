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
	header( 'Content-Length: ' . filesize( $path ) );
	readfile( $path );
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
