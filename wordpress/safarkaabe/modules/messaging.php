<?php
/**
 * Chat: conversations, messages (text, photo, voice), attachments, read receipts and blocking.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

const SKW_MAX_ATTACHMENT = 2000000;

function skw_party_key( $u ) {
	if ( 'SUPER_ADMIN' === $u['role'] ) {
		return 'ADMIN';
	}
	return 'AGENCY' === $u['role'] ? 'AGENCY:' . $u['agency_id'] : 'USER:' . $u['id'];
}

function skw_peer_key( $c, $u ) {
	if ( 'CLIENT' === $u['role'] ) {
		return $c['agency_id'] ? 'AGENCY:' . $c['agency_id'] : 'ADMIN';
	}
	if ( 'AGENCY' === $u['role'] ) {
		return $c['customer_id'] ? 'USER:' . $c['customer_id'] : 'ADMIN';
	}
	return $c['customer_id'] ? 'USER:' . $c['customer_id'] : 'AGENCY:' . $c['agency_id'];
}

function skw_party_members( $key ) {
	if ( 'ADMIN' === $key ) {
		return skw_admin_ids();
	}
	if ( 0 === strpos( $key, 'AGENCY:' ) ) {
		return skw_agency_staff_ids( substr( $key, 7 ) );
	}
	return 0 === strpos( $key, 'USER:' ) ? array( substr( $key, 5 ) ) : array();
}

/** 'BLOCKED_BY_ME', 'BLOCKED_BY_THEM' or null. Blocks apply to a whole party (all staff of an agency). */
function skw_block_between( $user, $peer_key ) {
	$mine = skw_party_members( skw_party_key( $user ) );
	$mine = $mine ? $mine : array( $user['id'] );
	if ( SKW_DB::get_var( 'SELECT 1 FROM {blocked_parties} WHERE blocked_key = ? AND blocker_id IN (' . SKW_DB::marks( count( $mine ) ) . ') LIMIT 1', array_merge( array( $peer_key ), $mine ) ) ) {
		return 'BLOCKED_BY_ME';
	}
	$theirs = skw_party_members( $peer_key );
	if ( $theirs && SKW_DB::get_var( 'SELECT 1 FROM {blocked_parties} WHERE blocked_key = ? AND blocker_id IN (' . SKW_DB::marks( count( $theirs ) ) . ') LIMIT 1', array_merge( array( skw_party_key( $user ) ), $theirs ) ) ) {
		return 'BLOCKED_BY_THEM';
	}
	return null;
}

function skw_accessible_conversation( $id, $user ) {
	$c = SKW_DB::get_row( 'SELECT * FROM {conversations} WHERE id = ?', array( $id ) );
	if ( ! $c ) {
		return null;
	}
	if ( 'SUPER_ADMIN' === $user['role'] || ( 'AGENCY' === $user['role'] && $c['agency_id'] === $user['agency_id'] ) || ( 'CLIENT' === $user['role'] && $c['customer_id'] === $user['id'] ) ) {
		return $c;
	}
	return null;
}

/** Notifies the other side of a conversation about a new message. */
function skw_message_notifications( $c, $sender, $message_id, $text ) {
	$ids = array();
	if ( 'CLIENT' === $sender['role'] ) {
		$ids = skw_party_members( $c['agency_id'] ? 'AGENCY:' . $c['agency_id'] : 'ADMIN' );
	} elseif ( 'AGENCY' === $sender['role'] ) {
		$ids = skw_party_members( $c['customer_id'] ? 'USER:' . $c['customer_id'] : 'ADMIN' );
	} else {
		$ids = array_merge( $c['customer_id'] ? array( $c['customer_id'] ) : array(), $c['agency_id'] ? skw_agency_staff_ids( $c['agency_id'] ) : array() );
	}
	$items = array();
	foreach ( array_unique( $ids ) as $rid ) {
		if ( $rid === $sender['id'] ) {
			continue;
		}
		$items[] = array( 'recipientUserId' => $rid, 'agencyId' => $c['agency_id'], 'conversationId' => $c['id'], 'type' => 'MESSAGE', 'title' => 'New message from ' . $sender['name'], 'body' => mb_substr( $text, 0, 220 ), 'href' => skw_app_link( '?conversation=' . rawurlencode( $c['id'] ) ), 'dedupeKey' => 'MESSAGE:' . $message_id . ':' . $rid );
	}
	skw_notify( $items );
}

SKW_Router::add( 'GET', '#^/api/conversations$#', function () {
	$user = skw_require_role();
	if ( 'SUPER_ADMIN' === $user['role'] ) {
		$where = '1 = 1';
		$args  = array();
	} elseif ( 'AGENCY' === $user['role'] ) {
		$where = 'c.agency_id = ?';
		$args  = array( $user['agency_id'] );
	} else {
		$where = 'c.customer_id = ?';
		$args  = array( $user['id'] );
	}
	$rows = SKW_DB::get_results(
		"SELECT c.*, a.name AS agency_name, a.logo_mime AS agency_logo_mime, a.logo_data AS agency_logo_data, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone, u.avatar_mime AS customer_avatar_mime, u.avatar_data AS customer_avatar_data
		FROM {conversations} c LEFT JOIN {agencies} a ON a.id = c.agency_id LEFT JOIN {users} u ON u.id = c.customer_id
		WHERE $where AND NOT EXISTS (SELECT 1 FROM {conversation_hidden} h WHERE h.conversation_id = c.id AND h.user_id = ?) ORDER BY c.last_message_at DESC",
		array_merge( $args, array( $user['id'] ) )
	);
	$now = skw_now();
	$out = array();
	foreach ( $rows as $c ) {
		$peer_key = skw_peer_key( $c, $user );
		$peers    = skw_party_members( $peer_key );
		$peer     = $peers ? SKW_DB::get_row( 'SELECT MAX(last_seen_at) AS seen, MAX(CASE WHEN typing_conversation_id = ? AND typing_until > ? THEN 1 ELSE 0 END) AS typing FROM {users} WHERE id IN (' . SKW_DB::marks( count( $peers ) ) . ')', array_merge( array( $c['id'], $now ), $peers ) ) : null;
		$presence = $peers ? SKW_DB::get_var( 'SELECT presence_status FROM {users} WHERE id IN (' . SKW_DB::marks( count( $peers ) ) . ') AND last_seen_at IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1', $peers ) : null;
		$contact  = $c['agency_id'] ? SKW_DB::get_row( "SELECT email, phone FROM {users} WHERE agency_id = ? AND role = 'AGENCY' ORDER BY created_at LIMIT 1", array( $c['agency_id'] ) ) : null;
		$out[]    = array(
			'id' => $c['id'], 'agencyId' => $c['agency_id'], 'customerId' => $c['customer_id'], 'subject' => $c['subject'],
			'createdAt' => $c['created_at'], 'lastMessageAt' => $c['last_message_at'],
			'agencyName' => $c['agency_name'], 'agencyLogoMime' => $c['agency_logo_mime'], 'agencyLogoData' => $c['agency_logo_data'],
			'agencyContactEmail' => $contact ? $contact['email'] : null, 'agencyContactPhone' => $contact ? $contact['phone'] : null,
			'customerName' => $c['customer_name'], 'customerEmail' => $c['customer_email'], 'customerPhone' => $c['customer_phone'],
			'customerAvatarMime' => $c['customer_avatar_mime'], 'customerAvatarData' => $c['customer_avatar_data'],
			'lastMessage' => SKW_DB::get_var( 'SELECT body FROM {messages} WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', array( $c['id'] ) ),
			'unreadCount' => (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {messages} WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL', array( $c['id'], $user['id'] ) ),
			'peerPresenceStatus' => $presence ? $presence : 'OFFLINE', 'peerLastSeenAt' => $peer ? $peer['seen'] : null, 'peerTyping' => $peer ? (int) $peer['typing'] : 0,
			'peerKey' => $peer_key, 'blockedByMe' => 'BLOCKED_BY_ME' === skw_block_between( $user, $peer_key ),
		);
	}
	return array( 'conversations' => $out );
} );

SKW_Router::add( 'POST', '#^/api/conversations$#', function () {
	$user    = skw_mutation();
	$body    = skw_body();
	$subject = skw_require_string( isset( $body['subject'] ) ? $body['subject'] : null, 'Subject', 160 );
	$message = skw_require_string( isset( $body['message'] ) ? $body['message'] : null, 'Message', 5000 );
	$agency  = null;
	$client  = null;
	if ( 'SUPER_ADMIN' === $user['role'] ) {
		$type = skw_require_string( isset( $body['recipientType'] ) ? $body['recipientType'] : null, 'Recipient type', 16 );
		$rid  = skw_require_string( isset( $body['recipientId'] ) ? $body['recipientId'] : null, 'Recipient', 80 );
		if ( 'AGENCY' === $type ) {
			if ( ! SKW_DB::get_var( "SELECT 1 FROM {agencies} WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1", array( $rid ) ) ) {
				throw new SKW_Http_Error( 404, 'The selected travel agency is not available.' );
			}
			$agency = $rid;
		} elseif ( 'CLIENT' === $type ) {
			if ( ! SKW_DB::get_var( "SELECT 1 FROM {users} WHERE id = ? AND role = 'CLIENT'", array( $rid ) ) ) {
				throw new SKW_Http_Error( 404, 'The selected traveler is not available.' );
			}
			$client = $rid;
		} else {
			throw new SKW_Http_Error( 400, 'Choose a traveler or agency as the conversation recipient.' );
		}
	} elseif ( 'CLIENT' === $user['role'] ) {
		$client = $user['id'];
		if ( empty( $body['support'] ) ) {
			$agency = skw_require_string( isset( $body['agencyId'] ) ? $body['agencyId'] : null, 'Agency', 80 );
			if ( ! SKW_DB::get_var( "SELECT 1 FROM {agencies} WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1", array( $agency ) ) ) {
				throw new SKW_Http_Error( 404, 'The selected travel agency is not available.' );
			}
		}
	} else {
		$agency = $user['agency_id'];
		if ( ! empty( $body['recipientId'] ) ) {
			$client = skw_require_string( $body['recipientId'], 'Traveler', 80 );
			if ( ! SKW_DB::get_var( "SELECT 1 FROM {users} WHERE id = ? AND role = 'CLIENT'", array( $client ) ) ) {
				throw new SKW_Http_Error( 404, 'The selected traveler is not available.' );
			}
		}
	}
	$c     = array( 'id' => skw_uuid(), 'agency_id' => $agency, 'customer_id' => $client );
	$block = skw_block_between( $user, skw_peer_key( $c, $user ) );
	if ( $block ) {
		throw new SKW_Http_Error( 403, 'BLOCKED_BY_ME' === $block ? 'You blocked this contact. Unblock them in My profile to start a chat.' : 'You cannot start a chat with this contact right now.' );
	}
	$now = skw_now();
	$mid = skw_uuid();
	SKW_DB::transaction( function () use ( $c, $subject, $user, $now, $mid, $message ) {
		SKW_DB::insert( 'conversations', array_merge( $c, array( 'subject' => $subject, 'created_by' => $user['id'], 'created_at' => $now, 'last_message_at' => $now ) ) );
		SKW_DB::insert( 'messages', array( 'id' => $mid, 'conversation_id' => $c['id'], 'sender_id' => $user['id'], 'body' => $message, 'message_type' => 'TEXT', 'created_at' => $now ) );
	} );
	skw_message_notifications( $c, $user, $mid, $message );
	skw_json( 201, array( 'conversation' => array( 'id' => $c['id'], 'agencyId' => $agency, 'customerId' => $client, 'subject' => $subject, 'createdAt' => $now, 'lastMessageAt' => $now, 'lastMessage' => $message, 'unreadCount' => 0 ) ) );
} );

SKW_Router::add( 'DELETE', '#^/api/conversations/([0-9a-z-]+)$#i', function ( $p ) {
	$user = skw_mutation();
	$c    = skw_accessible_conversation( $p[0], $user );
	if ( ! $c ) {
		throw new SKW_Http_Error( 404, 'Conversation not found.' );
	}
	SKW_DB::upsert( 'conversation_hidden', array( 'conversation_id' => $c['id'], 'user_id' => $user['id'], 'hidden_at' => skw_now() ), array( 'conversation_id', 'user_id' ) );
	return array( 'ok' => true );
} );

SKW_Router::add( 'GET', '#^/api/conversations/([0-9a-z-]+)/messages$#i', function ( $p ) {
	$user = skw_require_role();
	$c    = skw_accessible_conversation( $p[0], $user );
	if ( ! $c ) {
		throw new SKW_Http_Error( 404, 'Conversation not found.' );
	}
	$rows = SKW_DB::get_results(
		"SELECT m.id, m.sender_id AS senderId, u.name AS senderName, u.role AS senderRole,
			CASE WHEN u.role = 'AGENCY' THEN a.logo_mime ELSE u.avatar_mime END AS senderImageMime,
			CASE WHEN u.role = 'AGENCY' THEN a.logo_data ELSE u.avatar_data END AS senderImageData,
			m.body, m.message_type AS messageType, m.attachment_mime AS attachmentMime, m.attachment_name AS attachmentName,
			m.duration_ms AS durationMs, m.edited_at AS editedAt, m.created_at AS createdAt, m.read_at AS readAt
		FROM {messages} m JOIN {users} u ON u.id = m.sender_id LEFT JOIN {agencies} a ON a.id = u.agency_id
		WHERE m.conversation_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 200",
		array( $c['id'] )
	);
	foreach ( $rows as &$r ) {
		$r['durationMs'] = null === $r['durationMs'] ? null : (int) $r['durationMs'];
	}
	unset( $r );
	return array( 'messages' => array_reverse( $rows ), 'block' => skw_block_between( $user, skw_peer_key( $c, $user ) ) );
} );

/** Validates a data: URL attachment. Returns array(mime, base64). */
function skw_chat_attachment( $data_url, $mime, $type ) {
	$mime    = strtolower( trim( explode( ';', (string) $mime )[0] ) );
	$allowed = 'IMAGE' === $type ? array( 'image/jpeg', 'image/png', 'image/webp' ) : array( 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac' );
	if ( ! in_array( $mime, $allowed, true ) || ! is_string( $data_url ) || strlen( $data_url ) > (int) ceil( SKW_MAX_ATTACHMENT * 4 / 3 ) + 160 ) {
		throw new SKW_Http_Error( 400, 'IMAGE' === $type ? 'Choose a JPEG, PNG, or WebP image no larger than 2 MB.' : 'Choose a supported audio recording no larger than 2 MB.' );
	}
	if ( ! preg_match( '#^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/]*={0,2})$#i', $data_url, $m ) || strtolower( $m[1] ) !== $mime ) {
		throw new SKW_Http_Error( 400, 'The selected attachment is invalid.' );
	}
	$bytes = base64_decode( $m[2], true );
	if ( false === $bytes || '' === $bytes || strlen( $bytes ) > SKW_MAX_ATTACHMENT ) {
		throw new SKW_Http_Error( 413, 'Attachments must be no larger than 2 MB.' );
	}
	$ok = ( 'image/png' === $mime && 0 === strpos( $bytes, "\x89PNG" ) ) || ( 'image/jpeg' === $mime && "\xff\xd8" === substr( $bytes, 0, 2 ) )
		|| ( 'image/webp' === $mime && 'RIFF' === substr( $bytes, 0, 4 ) && 'WEBP' === substr( $bytes, 8, 4 ) )
		|| ( 'audio/webm' === $mime && "\x1a\x45\xdf\xa3" === substr( $bytes, 0, 4 ) ) || ( 'audio/ogg' === $mime && 'OggS' === substr( $bytes, 0, 4 ) )
		|| ( 'audio/mp4' === $mime && 'ftyp' === substr( $bytes, 4, 4 ) ) || ( 'audio/wav' === $mime && 'RIFF' === substr( $bytes, 0, 4 ) && 'WAVE' === substr( $bytes, 8, 4 ) )
		|| ( 'audio/mpeg' === $mime && ( 'ID3' === substr( $bytes, 0, 3 ) || ( "\xff" === $bytes[0] && ( ord( $bytes[1] ) & 0xe0 ) === 0xe0 ) ) )
		|| ( 'audio/aac' === $mime && "\xff" === $bytes[0] && ( ord( $bytes[1] ) & 0xf6 ) === 0xf0 );
	if ( ! $ok ) {
		throw new SKW_Http_Error( 400, 'The selected attachment is invalid.' );
	}
	return array( $mime, $m[2] );
}

SKW_Router::add( 'POST', '#^/api/conversations/([0-9a-z-]+)/messages$#i', function ( $p ) {
	$user = skw_mutation();
	$c    = skw_accessible_conversation( $p[0], $user );
	if ( ! $c ) {
		throw new SKW_Http_Error( 404, 'Conversation not found.' );
	}
	$block = skw_block_between( $user, skw_peer_key( $c, $user ) );
	if ( $block ) {
		throw new SKW_Http_Error( 403, 'BLOCKED_BY_ME' === $block ? 'You blocked this contact. Unblock them from their profile to send messages again.' : 'You cannot send messages in this chat right now.' );
	}
	$body = skw_body( 2800000 );
	$type = isset( $body['messageType'] ) && is_string( $body['messageType'] ) ? strtoupper( $body['messageType'] ) : 'TEXT';
	if ( ! in_array( $type, array( 'TEXT', 'IMAGE', 'AUDIO' ), true ) ) {
		throw new SKW_Http_Error( 400, 'Choose a text, image, or voice message.' );
	}
	$text = isset( $body['message'] ) && is_string( $body['message'] ) ? trim( $body['message'] ) : '';
	if ( mb_strlen( $text ) > 5000 ) {
		throw new SKW_Http_Error( 400, 'Messages cannot be longer than 5,000 characters.' );
	}
	if ( 'TEXT' === $type && '' === $text ) {
		throw new SKW_Http_Error( 400, 'Write a message before sending.' );
	}
	$att      = 'TEXT' === $type ? null : skw_chat_attachment( isset( $body['attachmentData'] ) ? $body['attachmentData'] : null, isset( $body['attachmentMime'] ) ? $body['attachmentMime'] : '', $type );
	$name     = $att ? substr( preg_replace( '/[^a-z0-9._-]/i', '_', (string) ( ! empty( $body['attachmentName'] ) ? $body['attachmentName'] : ( 'IMAGE' === $type ? 'photo.jpg' : 'voice-message' ) ) ), 0, 120 ) : null;
	$duration = 'AUDIO' === $type && isset( $body['durationMs'] ) && is_numeric( $body['durationMs'] ) ? max( 0, min( 120000, (int) round( $body['durationMs'] ) ) ) : null;
	$display  = '' !== $text ? $text : ( 'IMAGE' === $type ? 'Photo' : 'Voice message' );
	$id       = skw_uuid();
	$now      = skw_now();
	SKW_DB::transaction( function () use ( $id, $c, $user, $display, $type, $att, $name, $duration, $now ) {
		SKW_DB::insert( 'messages', array( 'id' => $id, 'conversation_id' => $c['id'], 'sender_id' => $user['id'], 'body' => $display, 'message_type' => $type,
			'attachment_mime' => $att ? $att[0] : null, 'attachment_data' => $att ? $att[1] : null, 'attachment_name' => $name, 'duration_ms' => $duration, 'created_at' => $now ) );
		SKW_DB::update( 'conversations', array( 'last_message_at' => $now ), array( 'id' => $c['id'] ) );
		SKW_DB::update( 'users', array( 'typing_conversation_id' => null, 'typing_until' => null ), array( 'id' => $user['id'] ) );
		SKW_DB::query( 'DELETE FROM {conversation_hidden} WHERE conversation_id = ?', array( $c['id'] ) );
	} );
	skw_message_notifications( $c, $user, $id, $display );
	skw_json( 201, array( 'message' => array( 'id' => $id, 'senderId' => $user['id'], 'senderName' => $user['name'], 'senderRole' => $user['role'], 'body' => $display, 'messageType' => $type, 'attachmentMime' => $att ? $att[0] : null, 'attachmentName' => $name, 'durationMs' => $duration, 'createdAt' => $now, 'readAt' => null ) ) );
} );

SKW_Router::add( 'GET', '#^/api/conversations/([0-9a-z-]+)/messages/([0-9a-z-]+)/attachment$#i', function ( $p, $req ) {
	$user = skw_require_role();
	$c    = skw_accessible_conversation( $p[0], $user );
	$m    = $c ? SKW_DB::get_row( 'SELECT attachment_mime, attachment_data, attachment_name FROM {messages} WHERE id = ? AND conversation_id = ?', array( $p[1], $c['id'] ) ) : null;
	if ( ! $m || ! $m['attachment_data'] ) {
		throw new SKW_Http_Error( 404, 'Attachment not found.' );
	}
	$bytes = base64_decode( $m['attachment_data'] );
	$size  = strlen( $bytes );
	$range = isset( $req['headers']['range'] ) ? $req['headers']['range'] : '';
	$extra = array( 'Accept-Ranges' => 'bytes', 'Content-Disposition' => 'inline; filename="' . preg_replace( '/[^a-z0-9._-]/i', '_', (string) $m['attachment_name'] ) . '"' );
	if ( $range && preg_match( '/^bytes=(\d*)-(\d*)$/', trim( $range ), $r ) && ( '' !== $r[1] || '' !== $r[2] ) ) {
		if ( '' === $r[1] ) {
			$start = max( 0, $size - (int) $r[2] );
			$end   = $size - 1;
		} else {
			$start = (int) $r[1];
			$end   = '' === $r[2] ? $size - 1 : min( (int) $r[2], $size - 1 );
		}
		if ( $start >= $size || $start > $end ) {
			skw_send_raw( 416, $m['attachment_mime'], '', array_merge( $extra, array( 'Content-Range' => 'bytes */' . $size ) ) );
		}
		skw_send_raw( 206, $m['attachment_mime'], substr( $bytes, $start, $end - $start + 1 ), array_merge( $extra, array( 'Content-Range' => 'bytes ' . $start . '-' . $end . '/' . $size ) ) );
	}
	skw_send_raw( 200, $m['attachment_mime'], $bytes, $extra );
} );

SKW_Router::add( '*', '#^/api/conversations/([0-9a-z-]+)/messages/([0-9a-z-]+)$#i', function ( $p, $req ) {
	$user = skw_mutation();
	$c    = skw_accessible_conversation( $p[0], $user );
	$m    = $c ? SKW_DB::get_row( 'SELECT id, sender_id, message_type FROM {messages} WHERE id = ? AND conversation_id = ?', array( $p[1], $c['id'] ) ) : null;
	if ( ! $m ) {
		throw new SKW_Http_Error( 404, 'Message not found.' );
	}
	if ( $m['sender_id'] !== $user['id'] ) {
		throw new SKW_Http_Error( 403, 'You can only change messages you sent.' );
	}
	if ( 'DELETE' === $req['method'] ) {
		SKW_DB::query( 'DELETE FROM {messages} WHERE id = ?', array( $m['id'] ) );
		return array( 'ok' => true );
	}
	if ( 'PATCH' !== $req['method'] ) {
		throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
	}
	if ( skw_block_between( $user, skw_peer_key( $c, $user ) ) ) {
		throw new SKW_Http_Error( 403, 'You cannot edit messages in this chat because one of you has blocked the other.' );
	}
	if ( 'TEXT' !== $m['message_type'] ) {
		throw new SKW_Http_Error( 400, 'Only text messages can be edited.' );
	}
	$body = skw_body();
	$text = skw_require_string( isset( $body['message'] ) ? $body['message'] : null, 'Message', 5000 );
	$now  = skw_now();
	SKW_DB::update( 'messages', array( 'body' => $text, 'edited_at' => $now ), array( 'id' => $m['id'] ) );
	return array( 'message' => array( 'id' => $m['id'], 'body' => $text, 'editedAt' => $now ) );
} );

SKW_Router::add( 'POST', '#^/api/conversations/([0-9a-z-]+)/read$#i', function ( $p ) {
	$user = skw_mutation();
	$c    = skw_accessible_conversation( $p[0], $user );
	if ( ! $c ) {
		throw new SKW_Http_Error( 404, 'Conversation not found.' );
	}
	$participant = 'CLIENT' === $user['role'] ? $c['customer_id'] === $user['id'] : ( 'AGENCY' === $user['role'] ? $c['agency_id'] === $user['agency_id'] : ( ! $c['agency_id'] || ! $c['customer_id'] ) );
	if ( $participant ) {
		SKW_DB::query( 'UPDATE {messages} SET read_at = ? WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL', array( skw_now(), $c['id'], $user['id'] ) );
	}
	return array( 'ok' => true );
} );

SKW_Router::add( '*', '#^/api/blocks$#', function ( $p, $req ) {
	$user  = skw_require_role();
	$party = skw_party_members( skw_party_key( $user ) );
	$party = $party ? $party : array( $user['id'] );
	if ( 'GET' === $req['method'] ) {
		$rows = SKW_DB::get_results( 'SELECT blocked_key, MIN(created_at) AS created FROM {blocked_parties} WHERE blocker_id IN (' . SKW_DB::marks( count( $party ) ) . ') GROUP BY blocked_key ORDER BY MIN(created_at) DESC', $party );
		$out  = array();
		foreach ( $rows as $r ) {
			$name = 'SAFAR KAABE support';
			if ( 0 === strpos( $r['blocked_key'], 'AGENCY:' ) ) {
				$name = (string) SKW_DB::get_var( 'SELECT name FROM {agencies} WHERE id = ?', array( substr( $r['blocked_key'], 7 ) ) );
			} elseif ( 0 === strpos( $r['blocked_key'], 'USER:' ) ) {
				$name = (string) SKW_DB::get_var( 'SELECT name FROM {users} WHERE id = ?', array( substr( $r['blocked_key'], 5 ) ) );
			}
			$out[] = array( 'key' => $r['blocked_key'], 'createdAt' => $r['created'], 'name' => $name );
		}
		return array( 'blocks' => $out );
	}
	skw_require_csrf();
	$body = skw_body();
	if ( 'POST' === $req['method'] ) {
		$c = skw_accessible_conversation( skw_require_string( isset( $body['conversationId'] ) ? $body['conversationId'] : null, 'Conversation', 80 ), $user );
		if ( ! $c ) {
			throw new SKW_Http_Error( 404, 'Conversation not found.' );
		}
		$key = skw_peer_key( $c, $user );
		if ( $key === skw_party_key( $user ) ) {
			throw new SKW_Http_Error( 400, 'You cannot block yourself.' );
		}
		SKW_DB::upsert( 'blocked_parties', array( 'blocker_id' => $user['id'], 'blocked_key' => $key, 'created_at' => skw_now() ), array( 'blocker_id', 'blocked_key' ) );
		skw_audit( $user['id'], 'CONTACT_BLOCKED', $key );
		return array( 'ok' => true, 'key' => $key );
	}
	if ( 'DELETE' === $req['method'] ) {
		$key = skw_require_string( isset( $body['key'] ) ? $body['key'] : null, 'Blocked contact', 120 );
		SKW_DB::query( 'DELETE FROM {blocked_parties} WHERE blocked_key = ? AND blocker_id IN (' . SKW_DB::marks( count( $party ) ) . ')', array_merge( array( $key ), $party ) );
		skw_audit( $user['id'], 'CONTACT_UNBLOCKED', $key );
		return array( 'ok' => true );
	}
	throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
} );
