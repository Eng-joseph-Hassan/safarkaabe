<?php
/**
 * Notifications, notification settings, voice/video calls (signalling by polling), and safe answers
 * for features that are not on this website yet (status updates, communities, phone push).
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

function skw_notification_public( $n ) {
	$t   = $n['type'];
	$cat = ( 'MESSAGE' === $t || 0 === strpos( $t, 'CALL' ) ) ? 'MESSAGES' : ( 0 === strpos( $t, 'PAYMENT' ) ? 'PAYMENTS' : ( 0 === strpos( $t, 'STATUS' ) ? 'STATUS' : ( 0 === strpos( $t, 'TRAVEL_NEWS' ) ? 'TRAVEL_NEWS' : ( 0 === strpos( $t, 'PROMOTION' ) ? 'PROMOTIONS' : 'BOOKINGS' ) ) ) );
	return array(
		'id' => $n['id'], 'recipientUserId' => $n['recipient_user_id'], 'agencyId' => $n['agency_id'], 'bookingId' => $n['booking_id'],
		'conversationId' => $n['conversation_id'], 'type' => $t, 'category' => $cat, 'title' => $n['title'], 'body' => $n['body'],
		'href' => $n['href'], 'createdAt' => $n['created_at'], 'readAt' => $n['read_at'],
	);
}

SKW_Router::add( 'GET', '#^/api/notifications$#', function () {
	$user = skw_require_role();
	$rows = SKW_DB::get_results( 'SELECT * FROM {notifications} WHERE recipient_user_id = ? ORDER BY created_at DESC LIMIT 100', array( $user['id'] ) );
	$out  = array_map( 'skw_notification_public', $rows );
	$unread = 0;
	foreach ( $out as $n ) {
		$unread += $n['readAt'] ? 0 : 1;
	}
	return array( 'notifications' => $out, 'unreadCount' => $unread );
} );

SKW_Router::add( 'POST', '#^/api/notifications/read-all$#', function () {
	$user = skw_mutation();
	SKW_DB::query( 'UPDATE {notifications} SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL', array( skw_now(), $user['id'] ) );
	return array( 'ok' => true );
} );

SKW_Router::add( 'DELETE', '#^/api/notifications$#', function () {
	$user = skw_mutation();
	SKW_DB::query( 'DELETE FROM {notifications} WHERE recipient_user_id = ?', array( $user['id'] ) );
	return array( 'ok' => true );
} );

SKW_Router::add( '*', '#^/api/notifications/([0-9a-z-]+)$#i', function ( $p, $req ) {
	$user = skw_mutation();
	if ( 'DELETE' === $req['method'] ) {
		SKW_DB::query( 'DELETE FROM {notifications} WHERE id = ? AND recipient_user_id = ?', array( $p[0], $user['id'] ) );
		return array( 'ok' => true );
	}
	$body = skw_body();
	$read = isset( $body['action'] ) && 'UNREAD' === $body['action'] ? null : skw_now();
	SKW_DB::query( 'UPDATE {notifications} SET read_at = ? WHERE id = ? AND recipient_user_id = ?', array( $read, $p[0], $user['id'] ) );
	return array( 'ok' => true );
} );

function skw_default_prefs() {
	return array(
		'soundEnabled' => true, 'desktopPushEnabled' => true, 'bookingAlerts' => true, 'paymentNotifications' => true, 'travelNews' => true,
		'promotionalNotifications' => false, 'statusUpdates' => true, 'lockScreenPreviews' => true, 'quietHoursEnabled' => false,
		'quietHoursStart' => '22:00', 'quietHoursEnd' => '08:00', 'timezone' => 'UTC', 'mutedConversationIds' => array(),
	);
}

function skw_get_prefs( $user_id ) {
	$saved = json_decode( (string) SKW_DB::get_var( 'SELECT prefs_json FROM {notification_prefs} WHERE user_id = ?', array( $user_id ) ), true );
	return array_merge( skw_default_prefs(), is_array( $saved ) ? $saved : array() );
}

SKW_Router::add( 'GET', '#^/api/notification-preferences$#', function () {
	$user = skw_require_role();
	return skw_get_prefs( $user['id'] );
} );

SKW_Router::add( 'PATCH', '#^/api/notification-preferences$#', function () {
	$user  = skw_mutation();
	$prefs = skw_get_prefs( $user['id'] );
	$body  = skw_body();
	foreach ( skw_default_prefs() as $k => $default ) {
		if ( ! array_key_exists( $k, $body ) ) {
			continue;
		}
		if ( is_bool( $default ) && is_bool( $body[ $k ] ) ) {
			$prefs[ $k ] = $body[ $k ];
		} elseif ( in_array( $k, array( 'quietHoursStart', 'quietHoursEnd' ), true ) && is_string( $body[ $k ] ) && preg_match( '/^([01]\d|2[0-3]):[0-5]\d$/', $body[ $k ] ) ) {
			$prefs[ $k ] = $body[ $k ];
		} elseif ( 'timezone' === $k && is_string( $body[ $k ] ) && strlen( $body[ $k ] ) <= 64 ) {
			$prefs[ $k ] = $body[ $k ];
		}
	}
	SKW_DB::upsert( 'notification_prefs', array( 'user_id' => $user['id'], 'prefs_json' => json_encode( $prefs ), 'updated_at' => skw_now() ), array( 'user_id' ) );
	return $prefs;
} );

SKW_Router::add( '*', '#^/api/notification-mutes$#', function ( $p, $req ) {
	$user  = skw_mutation();
	$body  = skw_body();
	$id    = skw_require_string( isset( $body['conversationId'] ) ? $body['conversationId'] : null, 'Conversation', 80 );
	$prefs = skw_get_prefs( $user['id'] );
	$muted = array_values( array_diff( (array) $prefs['mutedConversationIds'], array( $id ) ) );
	if ( 'POST' === $req['method'] ) {
		$muted[] = $id;
	}
	$prefs['mutedConversationIds'] = array_slice( $muted, -500 );
	SKW_DB::upsert( 'notification_prefs', array( 'user_id' => $user['id'], 'prefs_json' => json_encode( $prefs ), 'updated_at' => skw_now() ), array( 'user_id' ) );
	return array( 'ok' => true, 'mutedConversationIds' => $prefs['mutedConversationIds'] );
} );



/* ---------- Calls ---------- */

SKW_Router::add( 'GET', '#^/api/calls/ice-config$#', function () {
	skw_require_role();
	return array( 'iceServers' => array( array( 'urls' => array( 'stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478' ) ) ), 'turnAvailable' => false );
} );

function skw_call_last_seen_end( $c ) {
	$a = $c['caller_seen_at'] ? $c['caller_seen_at'] : ( $c['accepted_at'] ? $c['accepted_at'] : $c['created_at'] );
	$b = $c['callee_seen_at'] ? $c['callee_seen_at'] : ( $c['accepted_at'] ? $c['accepted_at'] : $c['created_at'] );
	return $a < $b ? $a : $b;
}

function skw_missed_call_notice( $call, $caller_name ) {
	skw_notify( array( array(
		'recipientUserId' => $call['callee_id'], 'conversationId' => $call['conversation_id'], 'type' => 'CALL_MISSED',
		'title' => 'Missed ' . ( 'VIDEO' === $call['call_type'] ? 'video' : 'voice' ) . ' call', 'body' => 'You missed a call from ' . $caller_name . '. Open the chat to call back.',
		'href' => skw_app_link( '?conversation=' . rawurlencode( $call['conversation_id'] ) ), 'dedupeKey' => 'CALL_MISSED:' . $call['id'],
	) ) );
}

SKW_Router::add( 'POST', '#^/api/conversations/([0-9a-z-]+)/calls$#i', function ( $p ) {
	$user = skw_mutation();
	$c    = skw_accessible_conversation( $p[0], $user );
	if ( ! $c ) {
		throw new SKW_Http_Error( 404, 'Conversation not found.' );
	}
	$body = skw_body();
	$type = isset( $body['callType'] ) && is_string( $body['callType'] ) ? strtoupper( $body['callType'] ) : '';
	if ( ! in_array( $type, array( 'AUDIO', 'VIDEO' ), true ) ) {
		throw new SKW_Http_Error( 400, 'Choose an audio or video call.' );
	}
	$order  = "ORDER BY CASE WHEN presence_status = 'AVAILABLE' THEN 0 WHEN presence_status = 'AWAY' THEN 1 ELSE 2 END, last_seen_at DESC, created_at LIMIT 1";
	$callee = null;
	if ( 'CLIENT' === $user['role'] || ( 'SUPER_ADMIN' === $user['role'] && ! $c['customer_id'] ) ) {
		$callee = $c['agency_id'] ? SKW_DB::get_row( "SELECT id, name FROM {users} WHERE agency_id = ? AND role = 'AGENCY' $order", array( $c['agency_id'] ) ) : SKW_DB::get_row( "SELECT id, name FROM {users} WHERE role = 'SUPER_ADMIN' ORDER BY created_at LIMIT 1" );
	} elseif ( $c['customer_id'] ) {
		$callee = SKW_DB::get_row( "SELECT id, name FROM {users} WHERE id = ? AND role = 'CLIENT'", array( $c['customer_id'] ) );
	} elseif ( $c['agency_id'] ) {
		$callee = SKW_DB::get_row( "SELECT id, name FROM {users} WHERE agency_id = ? AND role = 'AGENCY' $order", array( $c['agency_id'] ) );
	}
	if ( ! $callee || $callee['id'] === $user['id'] ) {
		throw new SKW_Http_Error( 409, 'No other call participant is available in this conversation.' );
	}
	if ( skw_block_between( $user, skw_peer_key( $c, $user ) ) ) {
		throw new SKW_Http_Error( 403, 'You cannot call this person because one of you has blocked the other.' );
	}
	$ids  = array( $user['id'], $callee['id'], $user['id'], $callee['id'] );
	$busy = SKW_DB::get_var( "SELECT id FROM {chat_calls} WHERE status IN ('RINGING', 'ACCEPTED') AND (caller_id IN (?, ?) OR callee_id IN (?, ?)) LIMIT 1", $ids );
	if ( $busy ) {
		throw new SKW_Http_Error( 409, 'This participant is already in another call. Try again shortly.' );
	}
	$id  = skw_uuid();
	$now = skw_now();
	SKW_DB::insert( 'chat_calls', array( 'id' => $id, 'conversation_id' => $c['id'], 'caller_id' => $user['id'], 'callee_id' => $callee['id'], 'call_type' => $type, 'status' => 'RINGING', 'created_at' => $now, 'push_token' => skw_b64u_encode( random_bytes( 18 ) ), 'ring_push_at' => $now, 'caller_device' => isset( $body['deviceId'] ) && is_string( $body['deviceId'] ) ? substr( $body['deviceId'], 0, 64 ) : null ) );
	skw_notify( array( array( 'recipientUserId' => $callee['id'], 'agencyId' => $c['agency_id'], 'conversationId' => $c['id'], 'type' => 'CALL_INCOMING', 'title' => 'Incoming ' . ( 'VIDEO' === $type ? 'video' : 'voice' ) . ' call', 'body' => $user['name'] . ' is calling you. Open SAFAR KAABE to answer.', 'href' => skw_app_link( '?conversation=' . rawurlencode( $c['id'] ) ), 'dedupeKey' => 'CALL_INCOMING:' . $id ) ) );
	skw_push_call_ring( SKW_DB::get_row( 'SELECT * FROM {chat_calls} WHERE id = ?', array( $id ) ), $user['name'] ); // Rings the phone even when the app is closed.
	skw_json( 201, array( 'call' => array( 'id' => $id, 'conversationId' => $c['id'], 'callerId' => $user['id'], 'calleeId' => $callee['id'], 'peerName' => $callee['name'], 'callType' => $type, 'status' => 'RINGING', 'createdAt' => $now ) ) );
} );

SKW_Router::add( 'GET', '#^/api/calls/active$#', function () {
	$user = skw_require_role();
	$now  = skw_now();
	SKW_DB::query( "UPDATE {chat_calls} SET caller_seen_at = ? WHERE caller_id = ? AND status IN ('RINGING', 'ACCEPTED')", array( $now, $user['id'] ) );
	SKW_DB::query( "UPDATE {chat_calls} SET callee_seen_at = ? WHERE callee_id = ? AND status IN ('RINGING', 'ACCEPTED')", array( $now, $user['id'] ) );
	foreach ( SKW_DB::get_results( "SELECT * FROM {chat_calls} WHERE status = 'RINGING' AND created_at < ?", array( skw_now( -60 ) ) ) as $call ) {
		if ( 1 === SKW_DB::query( "UPDATE {chat_calls} SET status = 'MISSED', ended_at = ? WHERE id = ? AND status = 'RINGING'", array( $now, $call['id'] ) ) ) {
			skw_missed_call_notice( $call, (string) SKW_DB::get_var( 'SELECT name FROM {users} WHERE id = ?', array( $call['caller_id'] ) ) );
			skw_push_call_ended( $call, 'MISSED' );
		}
	}
	// While someone is calling, ring the other phone again every few seconds (like a phone ringing).
	foreach ( SKW_DB::get_results( "SELECT * FROM {chat_calls} WHERE caller_id = ? AND status = 'RINGING' AND created_at >= ?", array( $user['id'], skw_now( -55 ) ) ) as $call ) {
		if ( 1 === SKW_DB::query( 'UPDATE {chat_calls} SET ring_push_at = ? WHERE id = ? AND (ring_push_at IS NULL OR ring_push_at < ?)', array( $now, $call['id'], skw_now( -6 ) ) ) ) {
			skw_push_call_ring( $call, $user['name'] );
		}
	}
	$stale = skw_now( -90 );
	foreach ( SKW_DB::get_results( "SELECT * FROM {chat_calls} WHERE status = 'ACCEPTED'" ) as $call ) {
		$a = $call['caller_seen_at'] ? $call['caller_seen_at'] : ( $call['accepted_at'] ? $call['accepted_at'] : $call['created_at'] );
		$b = $call['callee_seen_at'] ? $call['callee_seen_at'] : ( $call['accepted_at'] ? $call['accepted_at'] : $call['created_at'] );
		if ( $a < $stale || $b < $stale ) {
			SKW_DB::query( "UPDATE {chat_calls} SET status = 'ENDED', ended_at = ? WHERE id = ? AND status = 'ACCEPTED'", array( skw_call_last_seen_end( $call ), $call['id'] ) );
		}
	}
	$rows = SKW_DB::get_results(
		"SELECT c.id, c.conversation_id AS conversationId, c.caller_id AS callerId, cu.name AS callerName, cu.avatar_mime AS callerAvatarMime, cu.avatar_data AS callerAvatarData,
			c.callee_id AS calleeId, ce.name AS calleeName, ce.avatar_mime AS calleeAvatarMime, ce.avatar_data AS calleeAvatarData, c.call_type AS callType, c.status, c.created_at AS createdAt,
			CASE WHEN c.caller_id = ? THEN c.caller_device ELSE c.callee_device END AS myDeviceId
		FROM {chat_calls} c JOIN {users} cu ON cu.id = c.caller_id JOIN {users} ce ON ce.id = c.callee_id
		WHERE (c.caller_id = ? OR c.callee_id = ?) AND c.status IN ('RINGING', 'ACCEPTED') ORDER BY c.created_at DESC LIMIT 10",
		array( $user['id'], $user['id'], $user['id'] )
	);
	foreach ( $rows as &$r ) {
		$mine                = $r['callerId'] === $user['id'];
		$r['peerName']       = $mine ? $r['calleeName'] : $r['callerName'];
		$r['peerAvatarMime'] = $mine ? $r['calleeAvatarMime'] : $r['callerAvatarMime'];
		$r['peerAvatarData'] = $mine ? $r['calleeAvatarData'] : $r['callerAvatarData'];
	}
	unset( $r );
	return array( 'calls' => $rows );
} );

SKW_Router::add( 'GET', '#^/api/calls/history$#', function () {
	$user = skw_require_role();
	$rows = SKW_DB::get_results(
		'SELECT c.id, c.conversation_id, c.caller_id, c.call_type, c.status, c.created_at, c.accepted_at, c.ended_at, cu.name AS caller_name, cu.avatar_mime AS caller_mime, cu.avatar_data AS caller_data, ce.name AS callee_name, ce.avatar_mime AS callee_mime, ce.avatar_data AS callee_data
		FROM {chat_calls} c JOIN {users} cu ON cu.id = c.caller_id JOIN {users} ce ON ce.id = c.callee_id WHERE c.caller_id = ? OR c.callee_id = ? ORDER BY c.created_at DESC LIMIT 100',
		array( $user['id'], $user['id'] )
	);
	$out = array();
	foreach ( $rows as $c ) {
		$outgoing = $c['caller_id'] === $user['id'];
		$out[]    = array(
			'id' => $c['id'], 'conversationId' => $c['conversation_id'], 'callType' => $c['call_type'], 'status' => $c['status'],
			'direction' => $outgoing ? 'OUTGOING' : 'INCOMING', 'createdAt' => $c['created_at'],
			'durationSeconds' => $c['accepted_at'] && $c['ended_at'] ? max( 0, (int) round( strtotime( $c['ended_at'] ) - strtotime( $c['accepted_at'] ) ) ) : null,
			'peerName' => $outgoing ? $c['callee_name'] : $c['caller_name'], 'peerAvatarMime' => $outgoing ? $c['callee_mime'] : $c['caller_mime'], 'peerAvatarData' => $outgoing ? $c['callee_data'] : $c['caller_data'],
		);
	}
	return array( 'calls' => $out );
} );

SKW_Router::add( '*', '#^/api/calls/([0-9a-z-]+)/signals$#i', function ( $p, $req ) {
	$user = skw_require_role();
	$call = SKW_DB::get_row( 'SELECT * FROM {chat_calls} WHERE id = ?', array( $p[0] ) );
	if ( ! $call || ( $call['caller_id'] !== $user['id'] && $call['callee_id'] !== $user['id'] ) ) {
		throw new SKW_Http_Error( 404, 'Call not found.' );
	}
	if ( 'GET' === $req['method'] ) {
		$after = isset( $req['query']['after'] ) && ctype_digit( (string) $req['query']['after'] ) ? (int) $req['query']['after'] : 0;
		$rows  = SKW_DB::get_results( 'SELECT id, sender_id, signal_type, payload_json, created_at FROM {chat_call_signals} WHERE call_id = ? AND sender_id <> ? AND id > ? ORDER BY id LIMIT 100', array( $call['id'], $user['id'], $after ) );
		$out   = array();
		foreach ( $rows as $s ) {
			$out[] = array( 'id' => (int) $s['id'], 'senderId' => $s['sender_id'], 'signalType' => $s['signal_type'], 'payload' => json_decode( $s['payload_json'], true ), 'createdAt' => $s['created_at'] );
		}
		return array( 'call' => array( 'id' => $call['id'], 'callType' => $call['call_type'], 'status' => $call['status'] ), 'signals' => $out );
	}
	skw_require_csrf();
	if ( ! in_array( $call['status'], array( 'RINGING', 'ACCEPTED' ), true ) ) {
		throw new SKW_Http_Error( 409, 'This call has already ended.' );
	}
	$body    = skw_body( 32768 );
	$type    = isset( $body['signalType'] ) && is_string( $body['signalType'] ) ? strtoupper( $body['signalType'] ) : '';
	$allowed = 'ICE' === $type || ( 'OFFER' === $type && $user['id'] === $call['caller_id'] ) || ( 'ANSWER' === $type && $user['id'] === $call['callee_id'] );
	$payload = isset( $body['payload'] ) && is_array( $body['payload'] ) ? json_encode( $body['payload'] ) : '';
	if ( ! $allowed || ! $payload || strlen( $payload ) > 24000 ) {
		throw new SKW_Http_Error( 400, 'The call could not exchange its connection details.' );
	}
	SKW_DB::insert( 'chat_call_signals', array( 'call_id' => $call['id'], 'sender_id' => $user['id'], 'signal_type' => $type, 'payload_json' => $payload, 'created_at' => skw_now() ) );
	skw_json( 201, array( 'ok' => true ) );
} );

SKW_Router::add( 'PATCH', '#^/api/calls/([0-9a-z-]+)$#i', function ( $p ) {
	$user = skw_mutation();
	$call = SKW_DB::get_row( 'SELECT * FROM {chat_calls} WHERE id = ?', array( $p[0] ) );
	if ( ! $call || ( $call['caller_id'] !== $user['id'] && $call['callee_id'] !== $user['id'] ) ) {
		throw new SKW_Http_Error( 404, 'Call not found.' );
	}
	$body   = skw_body();
	$action = isset( $body['action'] ) && is_string( $body['action'] ) ? strtoupper( $body['action'] ) : '';
	$now    = skw_now();
	if ( 'ACCEPT' === $action && $call['callee_id'] === $user['id'] && 'RINGING' === $call['status'] ) {
		if ( 1 === SKW_DB::query( "UPDATE {chat_calls} SET status = 'ACCEPTED', accepted_at = ?, callee_device = ? WHERE id = ? AND status = 'RINGING'", array( $now, isset( $body['deviceId'] ) && is_string( $body['deviceId'] ) ? substr( $body['deviceId'], 0, 64 ) : null, $call['id'] ) ) ) {
			skw_push_call_ended( $call, 'ANSWERED' ); // Stops the ringing on the person's other devices.
		}
	} elseif ( 'REJECT' === $action && $call['callee_id'] === $user['id'] && 'RINGING' === $call['status'] ) {
		if ( 1 === SKW_DB::query( "UPDATE {chat_calls} SET status = 'REJECTED', ended_at = ? WHERE id = ? AND status = 'RINGING'", array( $now, $call['id'] ) ) ) {
			skw_push_call_ended( $call, 'DECLINED' );
		}
	} elseif ( 'END' === $action && 'RINGING' === $call['status'] ) {
		$status = $call['caller_id'] === $user['id'] ? 'MISSED' : 'REJECTED';
		if ( 1 === SKW_DB::query( "UPDATE {chat_calls} SET status = ?, ended_at = ? WHERE id = ? AND status = 'RINGING'", array( $status, $now, $call['id'] ) ) && 'MISSED' === $status ) {
			skw_missed_call_notice( $call, $user['name'] );
			skw_push_call_ended( $call, 'MISSED' );
		} elseif ( 'REJECTED' === $status ) {
			skw_push_call_ended( $call, 'DECLINED' );
		}
	} elseif ( 'END' === $action && 'ACCEPTED' === $call['status'] ) {
		SKW_DB::query( "UPDATE {chat_calls} SET status = 'ENDED', ended_at = ? WHERE id = ? AND status = 'ACCEPTED'", array( $now, $call['id'] ) );
	} elseif ( ! in_array( $action, array( 'ACCEPT', 'REJECT', 'END' ), true ) ) {
		throw new SKW_Http_Error( 400, 'Choose answer, decline, or end call.' );
	} elseif ( ! in_array( $call['status'], array( 'RINGING', 'ACCEPTED' ), true ) ) {
		throw new SKW_Http_Error( 409, 'This call has already ended.' );
	} else {
		throw new SKW_Http_Error( 403, 'Only the person receiving the call can answer or decline it.' );
	}
	return array( 'status' => SKW_DB::get_var( 'SELECT status FROM {chat_calls} WHERE id = ?', array( $call['id'] ) ) );
} );
