<?php
/**
 * Status updates (24 hours, like stories) and communities (group chats).
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

function skw_status_owner_key( $s ) {
	if ( 'SUPER_ADMIN' === $s['user_role'] ) {
		return 'ADMIN';
	}
	return 'AGENCY' === $s['user_role'] ? 'AGENCY:' . $s['user_agency_id'] : 'USER:' . $s['user_id'];
}

/** Parties the user has a conversation with (they count as contacts for "Contacts only" statuses). */
function skw_status_contacts( $user ) {
	$keys = array();
	if ( 'CLIENT' === $user['role'] ) {
		foreach ( SKW_DB::get_results( 'SELECT DISTINCT agency_id FROM {conversations} WHERE customer_id = ?', array( $user['id'] ) ) as $r ) {
			$keys[] = $r['agency_id'] ? 'AGENCY:' . $r['agency_id'] : 'ADMIN';
		}
	} elseif ( 'AGENCY' === $user['role'] ) {
		$keys[] = 'AGENCY:' . $user['agency_id'];
		foreach ( SKW_DB::get_results( 'SELECT DISTINCT customer_id FROM {conversations} WHERE agency_id = ?', array( $user['agency_id'] ) ) as $r ) {
			$keys[] = $r['customer_id'] ? 'USER:' . $r['customer_id'] : 'ADMIN';
		}
	} else {
		$keys[] = 'ADMIN';
		foreach ( SKW_DB::get_results( 'SELECT DISTINCT agency_id, customer_id FROM {conversations} WHERE agency_id IS NULL OR customer_id IS NULL' ) as $r ) {
			$keys[] = $r['customer_id'] ? 'USER:' . $r['customer_id'] : 'AGENCY:' . $r['agency_id'];
		}
	}
	return array_unique( $keys );
}

function skw_can_view_status( $user, $s, $contacts ) {
	if ( $s['user_id'] === $user['id'] ) {
		return true;
	}
	if ( skw_block_between( $user, skw_status_owner_key( $s ) ) ) {
		return false;
	}
	return 'CONTACTS' !== $s['audience'] || in_array( skw_status_owner_key( $s ), $contacts, true );
}

const SKW_STATUS_SELECT = "SELECT s.id, s.user_id, s.body, s.attachment_mime, s.attachment_data IS NOT NULL AS has_photo, s.audience, s.created_at, s.expires_at,
	u.name AS user_name, u.role AS user_role, u.agency_id AS user_agency_id,
	CASE WHEN u.role = 'AGENCY' THEN a.logo_mime ELSE u.avatar_mime END AS avatar_mime,
	CASE WHEN u.role = 'AGENCY' THEN a.logo_data ELSE u.avatar_data END AS avatar_data
	FROM {chat_statuses} s JOIN {users} u ON u.id = s.user_id LEFT JOIN {agencies} a ON a.id = u.agency_id";

/** A status the user may see, or a 404. */
function skw_visible_status( $id, $user ) {
	$s = SKW_DB::get_row( SKW_STATUS_SELECT . ' WHERE s.id = ? AND s.expires_at > ?', array( $id, skw_now() ) );
	if ( ! $s || ! skw_can_view_status( $user, $s, 'CONTACTS' === $s['audience'] ? skw_status_contacts( $user ) : array() ) ) {
		throw new SKW_Http_Error( 404, 'Status not found or expired.' );
	}
	return $s;
}

SKW_Router::add( 'GET', '#^/api/statuses$#', function () {
	$user = skw_require_role();
	SKW_DB::query( 'DELETE FROM {chat_statuses} WHERE expires_at <= ?', array( skw_now() ) );
	$contacts = skw_status_contacts( $user );
	$out      = array();
	foreach ( SKW_DB::get_results( SKW_STATUS_SELECT . ' WHERE s.expires_at > ? ORDER BY s.created_at DESC', array( skw_now() ) ) as $s ) {
		if ( ! skw_can_view_status( $user, $s, $contacts ) ) {
			continue;
		}
		$mine  = $s['user_id'] === $user['id'];
		$out[] = array(
			'id' => $s['id'], 'userId' => $s['user_id'], 'userName' => $s['user_name'], 'userRole' => $s['user_role'],
			'avatarMime' => $s['avatar_mime'], 'avatarData' => $s['avatar_data'], 'body' => (string) $s['body'], 'attachmentMime' => $s['attachment_mime'],
			'audience' => $s['audience'] ? $s['audience'] : 'EVERYONE', 'createdAt' => $s['created_at'], 'expiresAt' => $s['expires_at'],
			'replyCount' => (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {chat_status_replies} WHERE status_id = ?', array( $s['id'] ) ),
			'reactionCount' => (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {chat_status_reactions} WHERE status_id = ?', array( $s['id'] ) ),
			'myReaction' => SKW_DB::get_var( 'SELECT emoji FROM {chat_status_reactions} WHERE status_id = ? AND user_id = ?', array( $s['id'], $user['id'] ) ),
			'viewedByMe' => $mine || (bool) SKW_DB::get_var( 'SELECT 1 FROM {chat_status_views} WHERE status_id = ? AND viewer_id = ?', array( $s['id'], $user['id'] ) ),
			'viewCount' => $mine ? (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {chat_status_views} WHERE status_id = ?', array( $s['id'] ) ) : null,
		);
	}
	return array( 'statuses' => $out );
} );

SKW_Router::add( 'POST', '#^/api/statuses$#', function () {
	$user = skw_mutation();
	$body = skw_body( 2800000 );
	$text = isset( $body['body'] ) && is_string( $body['body'] ) ? trim( $body['body'] ) : '';
	if ( mb_strlen( $text ) > 500 ) {
		throw new SKW_Http_Error( 400, 'Status text cannot be longer than 500 characters.' );
	}
	$photo = ! empty( $body['attachmentData'] ) ? skw_chat_attachment( $body['attachmentData'], isset( $body['attachmentMime'] ) ? $body['attachmentMime'] : '', 'IMAGE' ) : null;
	if ( '' === $text && ! $photo ) {
		throw new SKW_Http_Error( 400, 'Write a status or add a photo.' );
	}
	$audience = isset( $body['audience'] ) ? $body['audience'] : 'EVERYONE';
	if ( ! in_array( $audience, array( 'EVERYONE', 'CONTACTS' ), true ) ) {
		throw new SKW_Http_Error( 400, 'Choose who can see this status: everyone or your contacts.' );
	}
	$id      = skw_uuid();
	$created = skw_now();
	$expires = skw_now( 86400 );
	SKW_DB::insert( 'chat_statuses', array( 'id' => $id, 'user_id' => $user['id'], 'body' => $text, 'attachment_mime' => $photo ? $photo[0] : null, 'attachment_data' => $photo ? $photo[1] : null, 'audience' => $audience, 'created_at' => $created, 'expires_at' => $expires ) );
	skw_audit( $user['id'], 'CHAT_STATUS_CREATED', $id );
	skw_json( 201, array( 'status' => array( 'id' => $id, 'userId' => $user['id'], 'body' => $text, 'attachmentMime' => $photo ? $photo[0] : null, 'audience' => $audience, 'createdAt' => $created, 'expiresAt' => $expires, 'viewCount' => 0 ) ) );
} );

SKW_Router::add( '*', '#^/api/statuses/([0-9a-z-]+)/views$#i', function ( $p, $req ) {
	$user = skw_require_role();
	$s    = skw_visible_status( $p[0], $user );
	if ( 'POST' === $req['method'] ) {
		skw_require_csrf();
		if ( $s['user_id'] !== $user['id'] && ! SKW_DB::get_var( 'SELECT 1 FROM {chat_status_views} WHERE status_id = ? AND viewer_id = ?', array( $s['id'], $user['id'] ) ) ) {
			SKW_DB::insert( 'chat_status_views', array( 'status_id' => $s['id'], 'viewer_id' => $user['id'], 'viewed_at' => skw_now() ) );
		}
		return array( 'ok' => true );
	}
	if ( $s['user_id'] !== $user['id'] ) {
		throw new SKW_Http_Error( 403, 'Only the status owner can see who viewed it.' );
	}
	$viewers = SKW_DB::get_results( "SELECT v.viewer_id AS userId, v.viewed_at AS viewedAt, u.name AS userName, u.role AS userRole,
		CASE WHEN u.role = 'AGENCY' THEN a.logo_mime ELSE u.avatar_mime END AS avatarMime, CASE WHEN u.role = 'AGENCY' THEN a.logo_data ELSE u.avatar_data END AS avatarData,
		(SELECT r.emoji FROM {chat_status_reactions} r WHERE r.status_id = v.status_id AND r.user_id = v.viewer_id) AS reaction
		FROM {chat_status_views} v JOIN {users} u ON u.id = v.viewer_id LEFT JOIN {agencies} a ON a.id = u.agency_id WHERE v.status_id = ? ORDER BY v.viewed_at DESC", array( $s['id'] ) );
	return array( 'audience' => $s['audience'], 'viewCount' => count( $viewers ), 'viewers' => $viewers );
} );

SKW_Router::add( '*', '#^/api/statuses/([0-9a-z-]+)/replies$#i', function ( $p, $req ) {
	$user = skw_require_role();
	$s    = skw_visible_status( $p[0], $user );
	if ( 'GET' === $req['method'] ) {
		if ( $s['user_id'] !== $user['id'] ) {
			throw new SKW_Http_Error( 403, 'Only the status owner can view its replies.' );
		}
		return array( 'replies' => SKW_DB::get_results( 'SELECT r.id, r.body, r.created_at AS createdAt, r.user_id AS userId, u.name AS userName FROM {chat_status_replies} r JOIN {users} u ON u.id = r.user_id WHERE r.status_id = ? ORDER BY r.created_at', array( $s['id'] ) ) );
	}
	skw_require_csrf();
	$body = skw_body();
	$text = isset( $body['body'] ) && is_string( $body['body'] ) ? trim( $body['body'] ) : '';
	if ( '' === $text || mb_strlen( $text ) > 500 ) {
		throw new SKW_Http_Error( 400, 'A reply must be between 1 and 500 characters.' );
	}
	if ( $s['user_id'] === $user['id'] ) {
		throw new SKW_Http_Error( 400, 'You cannot reply to your own status.' );
	}
	$reply = array( 'id' => skw_uuid(), 'status_id' => $s['id'], 'user_id' => $user['id'], 'body' => $text, 'created_at' => skw_now() );
	SKW_DB::insert( 'chat_status_replies', $reply );
	skw_notify( array( array( 'recipientUserId' => $s['user_id'], 'type' => 'STATUS_REPLY', 'title' => $user['name'] . ' replied to your status', 'body' => mb_substr( $text, 0, 220 ), 'dedupeKey' => 'STATUS_REPLY:' . $reply['id'] ) ) );
	skw_json( 201, array( 'reply' => array( 'id' => $reply['id'], 'statusId' => $s['id'], 'userId' => $user['id'], 'userName' => $user['name'], 'body' => $text, 'createdAt' => $reply['created_at'] ) ) );
} );

SKW_Router::add( 'POST', '#^/api/statuses/([0-9a-z-]+)/reactions$#i', function ( $p ) {
	$user  = skw_mutation();
	$s     = skw_visible_status( $p[0], $user );
	$body  = skw_body();
	$emoji = isset( $body['emoji'] ) && is_string( $body['emoji'] ) ? $body['emoji'] : '';
	if ( ! in_array( $emoji, array( '😍', '😂', '😮', '❤️' ), true ) ) {
		throw new SKW_Http_Error( 400, 'Choose one of the available status reactions.' );
	}
	$old = SKW_DB::get_var( 'SELECT emoji FROM {chat_status_reactions} WHERE status_id = ? AND user_id = ?', array( $s['id'], $user['id'] ) );
	if ( $old === $emoji ) {
		SKW_DB::query( 'DELETE FROM {chat_status_reactions} WHERE status_id = ? AND user_id = ?', array( $s['id'], $user['id'] ) );
		return array( 'reaction' => null );
	}
	SKW_DB::upsert( 'chat_status_reactions', array( 'status_id' => $s['id'], 'user_id' => $user['id'], 'emoji' => $emoji, 'created_at' => skw_now() ), array( 'status_id', 'user_id' ) );
	if ( $s['user_id'] !== $user['id'] ) {
		skw_notify( array( array( 'recipientUserId' => $s['user_id'], 'type' => 'STATUS_REACTION', 'title' => $user['name'] . ' reacted to your status', 'body' => $user['name'] . ' reacted ' . $emoji . ' to your travel update.', 'dedupeKey' => 'STATUS_REACTION:' . $s['id'] . ':' . $user['id'] . ':' . $emoji ) ) );
	}
	return array( 'reaction' => $emoji );
} );

SKW_Router::add( 'GET', '#^/api/statuses/([0-9a-z-]+)/attachment$#i', function ( $p ) {
	$user = skw_require_role();
	$s    = skw_visible_status( $p[0], $user );
	$row  = SKW_DB::get_row( 'SELECT attachment_mime, attachment_data FROM {chat_statuses} WHERE id = ? AND attachment_data IS NOT NULL', array( $s['id'] ) );
	if ( ! $row ) {
		throw new SKW_Http_Error( 404, 'Status photo not found or expired.' );
	}
	skw_send_raw( 200, $row['attachment_mime'], base64_decode( $row['attachment_data'] ), array( 'Cache-Control' => 'private, max-age=3600' ) );
} );

SKW_Router::add( '*', '#^/api/statuses/([0-9a-z-]+)$#i', function ( $p, $req ) {
	$user = skw_mutation();
	$s    = SKW_DB::get_row( 'SELECT id, user_id, body, attachment_data IS NOT NULL AS has_photo FROM {chat_statuses} WHERE id = ? AND expires_at > ?', array( $p[0], skw_now() ) );
	if ( ! $s ) {
		throw new SKW_Http_Error( 404, 'Status not found or expired.' );
	}
	if ( $s['user_id'] !== $user['id'] ) {
		throw new SKW_Http_Error( 403, 'You can only change or delete your own status.' );
	}
	if ( 'DELETE' === $req['method'] ) {
		SKW_DB::query( 'DELETE FROM {chat_statuses} WHERE id = ?', array( $s['id'] ) );
		SKW_DB::query( 'DELETE FROM {chat_status_views} WHERE status_id = ?', array( $s['id'] ) );
		SKW_DB::query( 'DELETE FROM {chat_status_replies} WHERE status_id = ?', array( $s['id'] ) );
		SKW_DB::query( 'DELETE FROM {chat_status_reactions} WHERE status_id = ?', array( $s['id'] ) );
		return array( 'ok' => true );
	}
	$body = skw_body();
	$out  = array( 'ok' => true );
	if ( isset( $body['audience'] ) ) {
		if ( ! in_array( $body['audience'], array( 'EVERYONE', 'CONTACTS' ), true ) ) {
			throw new SKW_Http_Error( 400, 'Choose who can see this status: everyone or your contacts.' );
		}
		SKW_DB::update( 'chat_statuses', array( 'audience' => $body['audience'] ), array( 'id' => $s['id'] ) );
		$out['audience'] = $body['audience'];
	}
	if ( isset( $body['body'] ) ) {
		$text = is_string( $body['body'] ) ? trim( $body['body'] ) : '';
		if ( mb_strlen( $text ) > 500 || ( '' === $text && ! (int) $s['has_photo'] ) ) {
			throw new SKW_Http_Error( 400, mb_strlen( $text ) > 500 ? 'Status text cannot be longer than 500 characters.' : 'A photo status must keep a caption or photo.' );
		}
		SKW_DB::update( 'chat_statuses', array( 'body' => $text ), array( 'id' => $s['id'] ) );
		$out['body'] = $text;
	}
	return $out;
} );

/* ---------- Communities ---------- */

SKW_Router::add( 'GET', '#^/api/communities$#', function () {
	$user = skw_require_role();
	$rows = SKW_DB::get_results( 'SELECT c.id, c.name, c.description, c.created_by AS createdBy, c.created_at AS createdAt, u.name AS ownerName FROM {chat_communities} c JOIN {users} u ON u.id = c.created_by' );
	foreach ( $rows as &$c ) {
		$last              = SKW_DB::get_row( 'SELECT body, created_at FROM {chat_community_messages} WHERE community_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', array( $c['id'] ) );
		$c['memberCount']  = (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {chat_community_members} WHERE community_id = ?', array( $c['id'] ) );
		$c['isMember']     = SKW_DB::get_var( 'SELECT 1 FROM {chat_community_members} WHERE community_id = ? AND user_id = ?', array( $c['id'], $user['id'] ) ) ? 1 : 0;
		$c['lastMessage']  = $last ? $last['body'] : null;
		$c['lastMessageAt'] = $last ? $last['created_at'] : null;
	}
	unset( $c );
	usort( $rows, function ( $a, $b ) {
		return strcmp( $b['lastMessageAt'] ? $b['lastMessageAt'] : $b['createdAt'], $a['lastMessageAt'] ? $a['lastMessageAt'] : $a['createdAt'] );
	} );
	return array( 'communities' => $rows );
} );

function skw_community_text( $body, $field, $min, $max, $message ) {
	$text = isset( $body[ $field ] ) && is_string( $body[ $field ] ) ? trim( $body[ $field ] ) : '';
	if ( mb_strlen( $text ) < $min || mb_strlen( $text ) > $max ) {
		throw new SKW_Http_Error( 400, $message );
	}
	return $text;
}

SKW_Router::add( 'POST', '#^/api/communities$#', function () {
	$user = skw_mutation();
	$body = skw_body();
	$bad  = 'Use a community name from 2 to 80 characters and a description up to 500 characters.';
	$name = skw_community_text( $body, 'name', 2, 80, $bad );
	$desc = skw_community_text( $body, 'description', 0, 500, $bad );
	$id   = skw_uuid();
	$now  = skw_now();
	SKW_DB::transaction( function () use ( $id, $name, $desc, $user, $now ) {
		SKW_DB::insert( 'chat_communities', array( 'id' => $id, 'name' => $name, 'description' => $desc, 'created_by' => $user['id'], 'created_at' => $now ) );
		SKW_DB::insert( 'chat_community_members', array( 'community_id' => $id, 'user_id' => $user['id'], 'joined_at' => $now ) );
	} );
	skw_json( 201, array( 'community' => array( 'id' => $id, 'name' => $name, 'description' => $desc, 'createdBy' => $user['id'], 'createdAt' => $now, 'memberCount' => 1, 'isMember' => true ) ) );
} );

SKW_Router::add( 'POST', '#^/api/communities/([0-9a-z-]+)/(join|leave)$#i', function ( $p ) {
	$user = skw_mutation();
	if ( ! SKW_DB::get_var( 'SELECT 1 FROM {chat_communities} WHERE id = ?', array( $p[0] ) ) ) {
		throw new SKW_Http_Error( 404, 'Community not found.' );
	}
	if ( 'join' === strtolower( $p[1] ) ) {
		SKW_DB::upsert( 'chat_community_members', array( 'community_id' => $p[0], 'user_id' => $user['id'], 'joined_at' => skw_now() ), array( 'community_id', 'user_id' ) );
	} else {
		SKW_DB::query( 'DELETE FROM {chat_community_members} WHERE community_id = ? AND user_id = ?', array( $p[0], $user['id'] ) );
	}
	return array( 'ok' => true );
} );

SKW_Router::add( '*', '#^/api/communities/([0-9a-z-]+)/messages$#i', function ( $p, $req ) {
	$user = skw_require_role();
	if ( ! SKW_DB::get_var( 'SELECT 1 FROM {chat_communities} WHERE id = ?', array( $p[0] ) ) ) {
		throw new SKW_Http_Error( 404, 'Community not found.' );
	}
	if ( ! SKW_DB::get_var( 'SELECT 1 FROM {chat_community_members} WHERE community_id = ? AND user_id = ?', array( $p[0], $user['id'] ) ) ) {
		throw new SKW_Http_Error( 403, 'Join this community to view and send messages.' );
	}
	if ( 'GET' === $req['method'] ) {
		$rows = SKW_DB::get_results( 'SELECT m.id, m.sender_id AS senderId, u.name AS senderName, u.role AS senderRole, u.avatar_mime AS senderImageMime, u.avatar_data AS senderImageData, m.body, m.created_at AS createdAt, m.edited_at AS editedAt FROM {chat_community_messages} m JOIN {users} u ON u.id = m.sender_id WHERE m.community_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 300', array( $p[0] ) );
		return array( 'messages' => array_reverse( $rows ) );
	}
	skw_require_csrf();
	$text = skw_community_text( skw_body(), 'message', 1, 5000, 'Community messages must be between 1 and 5,000 characters.' );
	$id   = skw_uuid();
	$now  = skw_now();
	SKW_DB::insert( 'chat_community_messages', array( 'id' => $id, 'community_id' => $p[0], 'sender_id' => $user['id'], 'body' => $text, 'created_at' => $now ) );
	skw_json( 201, array( 'message' => array( 'id' => $id, 'senderId' => $user['id'], 'senderName' => $user['name'], 'senderRole' => $user['role'], 'body' => $text, 'createdAt' => $now ) ) );
} );

SKW_Router::add( '*', '#^/api/communities/([0-9a-z-]+)/messages/([0-9a-z-]+)$#i', function ( $p, $req ) {
	$user = skw_mutation();
	$m    = SKW_DB::get_row( 'SELECT id, sender_id FROM {chat_community_messages} WHERE id = ? AND community_id = ?', array( $p[1], $p[0] ) );
	if ( ! $m ) {
		throw new SKW_Http_Error( 404, 'Community message not found.' );
	}
	if ( $m['sender_id'] !== $user['id'] && 'SUPER_ADMIN' !== $user['role'] ) {
		throw new SKW_Http_Error( 403, 'You can only change or remove your own community messages.' );
	}
	if ( 'DELETE' === $req['method'] ) {
		SKW_DB::query( 'DELETE FROM {chat_community_messages} WHERE id = ?', array( $m['id'] ) );
		return array( 'ok' => true );
	}
	$text = skw_community_text( skw_body(), 'message', 1, 5000, 'Community messages must be between 1 and 5,000 characters.' );
	SKW_DB::update( 'chat_community_messages', array( 'body' => $text, 'edited_at' => skw_now() ), array( 'id' => $m['id'] ) );
	return array( 'ok' => true, 'body' => $text );
} );

SKW_Router::add( '*', '#^/api/communities/([0-9a-z-]+)$#i', function ( $p, $req ) {
	$user = skw_mutation();
	$c    = SKW_DB::get_row( 'SELECT id, created_by FROM {chat_communities} WHERE id = ?', array( $p[0] ) );
	if ( ! $c ) {
		throw new SKW_Http_Error( 404, 'Community not found.' );
	}
	if ( $c['created_by'] !== $user['id'] && 'SUPER_ADMIN' !== $user['role'] ) {
		throw new SKW_Http_Error( 403, 'Only the community owner or a Super Admin can manage this community.' );
	}
	if ( 'DELETE' === $req['method'] ) {
		SKW_DB::transaction( function () use ( $c ) {
			SKW_DB::query( 'DELETE FROM {chat_community_messages} WHERE community_id = ?', array( $c['id'] ) );
			SKW_DB::query( 'DELETE FROM {chat_community_members} WHERE community_id = ?', array( $c['id'] ) );
			SKW_DB::query( 'DELETE FROM {chat_communities} WHERE id = ?', array( $c['id'] ) );
		} );
		return array( 'ok' => true );
	}
	$body = skw_body();
	$bad  = 'Use a community name from 2 to 80 characters and a description up to 500 characters.';
	SKW_DB::update( 'chat_communities', array( 'name' => skw_community_text( $body, 'name', 2, 80, $bad ), 'description' => skw_community_text( $body, 'description', 0, 500, $bad ) ), array( 'id' => $c['id'] ) );
	return array( 'ok' => true );
} );
