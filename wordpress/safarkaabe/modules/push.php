<?php
/**
 * Call and message alerts on phones and computers (Web Push), and declining a call from the alert itself.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

SKW_Router::add( 'GET', '#^/api/push/public-key$#', function () {
	if ( ! skw_push_supported() ) {
		return array( 'configured' => false, 'publicKey' => null );
	}
	try {
		return array( 'configured' => true, 'publicKey' => skw_vapid()['public'] );
	} catch ( Throwable $e ) {
		error_log( 'SAFAR KAABE push key: ' . $e->getMessage() );
		return array( 'configured' => false, 'publicKey' => null );
	}
} );

SKW_Router::add( '*', '#^/api/push/subscriptions$#', function ( $p, $req ) {
	$user = skw_mutation();
	$body = skw_body( 8192 );
	$sub  = isset( $body['subscription'] ) && is_array( $body['subscription'] ) ? $body['subscription'] : $body;
	$end  = isset( $sub['endpoint'] ) && is_string( $sub['endpoint'] ) ? $sub['endpoint'] : '';
	if ( 'DELETE' === $req['method'] ) {
		if ( '' === $end ) {
			throw new SKW_Http_Error( 400, 'Endpoint is required.' );
		}
		SKW_DB::query( 'DELETE FROM {push_subscriptions} WHERE user_id = ? AND endpoint_hash = ?', array( $user['id'], hash( 'sha256', $end ) ) );
		return array( 'ok' => true );
	}
	if ( 'POST' !== $req['method'] ) {
		throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
	}
	$keys = isset( $sub['keys'] ) && is_array( $sub['keys'] ) ? $sub['keys'] : array();
	if ( strlen( $end ) > 2048 || ! skw_push_endpoint_allowed( $end ) || empty( $keys['p256dh'] ) || empty( $keys['auth'] ) || ! is_string( $keys['p256dh'] ) || ! is_string( $keys['auth'] )
		|| 65 !== strlen( skw_b64u_decode( $keys['p256dh'] ) ) || strlen( skw_b64u_decode( $keys['auth'] ) ) < 16 ) {
		throw new SKW_Http_Error( 400, 'A valid browser push subscription is required.' );
	}
	$now = skw_now();
	// One browser belongs to the person signed in on it now.
	$hash    = hash( 'sha256', $end );
	$changed = SKW_DB::query( 'UPDATE {push_subscriptions} SET user_id = ?, endpoint = ?, p256dh = ?, auth = ?, updated_at = ? WHERE endpoint_hash = ?', array( $user['id'], $end, $keys['p256dh'], $keys['auth'], $now, $hash ) );
	if ( ! $changed && ! SKW_DB::get_var( 'SELECT 1 FROM {push_subscriptions} WHERE endpoint_hash = ?', array( $hash ) ) ) {
		try {
			SKW_DB::insert( 'push_subscriptions', array(
				'id' => skw_uuid(), 'user_id' => $user['id'], 'endpoint_hash' => $hash, 'endpoint' => $end,
				'p256dh' => $keys['p256dh'], 'auth' => $keys['auth'], 'created_at' => $now, 'updated_at' => $now,
			) );
		} catch ( Exception $e ) {
			if ( ! SKW_DB::is_duplicate( $e ) ) {
				throw $e;
			}
		}
	}
	skw_json( 201, array( 'ok' => true ) );
} );

// The Android app's own alerts need a Firebase account; the website alerts above work without it.
SKW_Router::add( '*', '#^/api/push/native-tokens$#', function () {
	skw_mutation();
	return array( 'ok' => true, 'configured' => false );
} );

/** "Decline" tapped on the call alert: the phone has no session there, so a one-time token proves it. */
SKW_Router::add( 'POST', '#^/api/calls/([0-9a-z-]+)/push-decline$#i', function ( $p ) {
	$body  = skw_body();
	$call  = SKW_DB::get_row( 'SELECT * FROM {chat_calls} WHERE id = ?', array( $p[0] ) );
	$token = isset( $body['token'] ) && is_string( $body['token'] ) ? $body['token'] : '';
	if ( ! $call || ! $call['push_token'] || '' === $token || ! hash_equals( (string) $call['push_token'], $token ) ) {
		throw new SKW_Http_Error( 404, 'Call not found.' );
	}
	$declined = 1 === SKW_DB::query( "UPDATE {chat_calls} SET status = 'REJECTED', ended_at = ? WHERE id = ? AND status = 'RINGING'", array( skw_now(), $call['id'] ) );
	if ( $declined ) {
		skw_push_call_ended( $call, 'DECLINED' );
	}
	return array( 'ok' => true, 'declined' => $declined );
} );

/** The ringing alert for a call (also sent again every few seconds while it rings, like a phone). */
function skw_push_call_ring( $call, $caller_name ) {
	$video = 'VIDEO' === $call['call_type'];
	skw_push_later( $call['callee_id'], array(
		'title' => ( $video ? 'Video call' : 'Voice call' ) . ' · ' . $caller_name,
		'body'  => $caller_name . ' is calling you on SAFAR KAABE.',
		'url'   => skw_app_url( '?conversation=' . rawurlencode( $call['conversation_id'] ) ),
		'type'  => 'CALL_INCOMING',
		'tag'   => 'call-' . $call['id'],
		'data'  => array( 'callId' => $call['id'], 'conversationId' => $call['conversation_id'], 'callType' => $call['call_type'], 'callerName' => $caller_name, 'declineToken' => $call['push_token'] ),
	) );
}

/** Stops the ringing alert. A missed call stays on the screen; an answered or declined one goes away. */
function skw_push_call_ended( $call, $reason ) {
	$caller = (string) SKW_DB::get_var( 'SELECT name FROM {users} WHERE id = ?', array( $call['caller_id'] ) );
	skw_push_later( $call['callee_id'], array(
		'title' => 'MISSED' === $reason ? 'Missed call · ' . $caller : 'Call ended',
		'body'  => 'MISSED' === $reason ? 'You missed a call from ' . $caller . '. Tap to call back.' : 'The call with ' . $caller . ' has ended.',
		'url'   => skw_app_url( '?conversation=' . rawurlencode( $call['conversation_id'] ) ),
		'type'  => 'CALL_ENDED',
		'tag'   => 'call-' . $call['id'],
		'data'  => array( 'callId' => $call['id'], 'conversationId' => $call['conversation_id'], 'reason' => $reason ),
	) );
}
