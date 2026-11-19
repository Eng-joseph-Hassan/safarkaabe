<?php
/**
 * Routing and JSON responses for <base>/api/*. Works inside WordPress and in the standalone test server.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

class SKW_Http_Error extends Exception {
	public $status;
	public $payload;
	public function __construct( $status, $message, $payload = array() ) {
		parent::__construct( $message );
		$this->status  = (int) $status;
		$this->payload = $payload;
	}
}

/** Thrown to stop after a response was already sent (for example a file download). */
class SKW_Sent extends Exception {}

class SKW_Router {
	private static $routes = array();

	/**
	 * @param string   $method  GET, POST, PATCH, PUT, DELETE (or "*" for any).
	 * @param string   $pattern Regex for the path after the base, e.g. '#^/api/bookings/([0-9a-z-]+)$#i'.
	 * @param callable $handler function ( array $params, array $req ) returning an array (sent as JSON 200).
	 */
	public static function add( $method, $pattern, $handler ) {
		self::$routes[] = array( strtoupper( $method ), $pattern, $handler );
	}

	public static function match( $method, $path ) {
		$path_matched = false;
		foreach ( self::$routes as $route ) {
			if ( ! preg_match( $route[1], $path, $m ) ) {
				continue;
			}
			$path_matched = true;
			if ( '*' === $route[0] || $route[0] === $method || ( 'HEAD' === $method && 'GET' === $route[0] ) ) {
				array_shift( $m );
				return array( $route[2], $m );
			}
		}
		return $path_matched ? 'METHOD' : null;
	}
}

/** The request being handled (set by skw_dispatch). */
function skw_req( $key = null ) {
	global $skw_request;
	if ( null === $key ) {
		return $skw_request;
	}
	return isset( $skw_request[ $key ] ) ? $skw_request[ $key ] : null;
}

function skw_header( $name, $value ) {
	global $skw_response_headers;
	$skw_response_headers[] = array( $name, $value );
}

function skw_send_headers( $status, $type ) {
	global $skw_response_headers;
	if ( headers_sent() ) {
		return;
	}
	http_response_code( $status );
	header( 'Content-Type: ' . $type );
	header( 'X-Content-Type-Options: nosniff' );
	header( 'Referrer-Policy: strict-origin-when-cross-origin' );
	header( 'X-Robots-Tag: noindex, nofollow' );
	header( 'Cache-Control: no-store' );
	header( 'X-LiteSpeed-Cache-Control: no-cache' );
	foreach ( (array) $skw_response_headers as $h ) {
		header( $h[0] . ': ' . $h[1], false );
	}
	$skw_response_headers = array();
}

function skw_json( $status, $data ) {
	skw_send_headers( $status, 'application/json; charset=utf-8' );
	echo json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	throw new SKW_Sent();
}

/** Sends raw bytes (images, attachments, CSV). */
function skw_send_raw( $status, $type, $bytes, $extra = array() ) {
	foreach ( $extra as $name => $value ) {
		skw_header( $name, $value );
	}
	skw_send_headers( $status, $type );
	echo $bytes; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- binary file body.
	throw new SKW_Sent();
}

/** Decoded JSON body (array). Too large or invalid JSON gives a 400/413 error. */
function skw_body( $max_bytes = 16384 ) {
	static $cache = array();
	$raw = skw_req( 'body' );
	if ( strlen( (string) $raw ) > $max_bytes ) {
		throw new SKW_Http_Error( 413, 'The request is too large.' );
	}
	if ( '' === trim( (string) $raw ) ) {
		return array();
	}
	$key = md5( $raw );
	if ( ! isset( $cache[ $key ] ) ) {
		$data = json_decode( $raw, true );
		if ( ! is_array( $data ) ) {
			throw new SKW_Http_Error( 400, 'Send valid JSON.' );
		}
		$cache[ $key ] = $data;
	}
	return $cache[ $key ];
}

/**
 * Handles one API request. $path is the part after the base path, starting with "/api/".
 * $req: method, path, query, headers (lower-case keys), cookies, ip, body, origin_host.
 */
function skw_dispatch( $req ) {
	global $skw_request, $skw_response_headers;
	$skw_request          = $req;
	$skw_response_headers = array();
	try {
		$found = SKW_Router::match( $req['method'], $req['path'] );
		if ( null === $found ) {
			skw_json( 404, array( 'error' => 'This page or action was not found.' ) );
		}
		if ( 'METHOD' === $found ) {
			skw_json( 405, array( 'error' => 'That action is not allowed here.' ) );
		}
		$result = call_user_func( $found[0], $found[1], $req );
		skw_json( 200, null === $result ? array( 'ok' => true ) : $result );
	} catch ( SKW_Sent $done ) {
		return;
	} catch ( SKW_Http_Error $error ) {
		try {
			skw_json( $error->status, array_merge( array( 'error' => $error->getMessage() ), $error->payload ) );
		} catch ( SKW_Sent $done ) {
			return;
		}
	} catch ( Throwable $error ) {
		error_log( 'SAFAR KAABE API error on ' . $req['method'] . ' ' . $req['path'] . ': ' . $error->getMessage() . ' @ ' . $error->getFile() . ':' . $error->getLine() );
		try {
			skw_json( 500, array( 'error' => 'The server could not complete your request. Please try again.' ) );
		} catch ( SKW_Sent $done ) {
			return;
		}
	}
}
