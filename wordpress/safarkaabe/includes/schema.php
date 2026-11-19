<?php
/**
 * All SAFAR KAABE tables. Defined once, created for MySQL (WordPress) or SQLite (tests).
 * Column types: id (VARCHAR 64), key (VARCHAR 191, indexable), str (VARCHAR 255), date (ISO text),
 * text (long text), int (64-bit integer), real (decimal number).
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

function skw_schema() {
	return array(
		'users'                 => array(
			'cols'    => array(
				'id' => 'id', 'email' => 'key', 'name' => 'str', 'phone' => 'str', 'password_hash' => 'str',
				'role' => 'key', 'agency_id' => 'id NULL', 'avatar_mime' => 'str NULL', 'avatar_data' => 'text NULL',
				'presence_status' => "key DEFAULT 'AVAILABLE'", 'last_seen_at' => 'date NULL', 'typing_conversation_id' => 'id NULL',
				'typing_until' => 'date NULL', 'theme_preference' => 'key NULL', 'login_code_enabled' => 'int DEFAULT 0', 'created_at' => 'date',
			),
			'pk'      => 'id',
			'unique'  => array( 'email' ),
			'index'   => array( 'agency_id', 'role' ),
		),
		'agencies'              => array(
			'cols'  => array(
				'id' => 'id', 'name' => 'str', 'tier' => 'key', 'markup_pct' => 'real', 'status' => "key DEFAULT 'ACTIVE'",
				'is_approved' => 'int DEFAULT 1', 'logo_mime' => 'str NULL', 'logo_data' => 'text NULL', 'created_at' => 'date',
			),
			'pk'    => 'id',
		),
		'sessions'              => array(
			'cols'  => array( 'id_hash' => 'key', 'user_id' => 'id', 'csrf_hash' => 'str', 'expires_at' => 'int', 'created_at' => 'date' ),
			'pk'    => 'id_hash',
			'index' => array( 'user_id', 'expires_at' ),
		),
		'password_reset_codes'  => array(
			'cols' => array( 'email' => 'key', 'user_id' => 'id', 'code_hash' => 'str', 'expires_at' => 'int', 'attempts' => 'int DEFAULT 0', 'created_at' => 'int' ),
			'pk'   => 'email',
		),
		'rate_limits'           => array(
			'cols'  => array( 'rl_key' => 'key', 'attempts' => 'int', 'expires_at' => 'int' ),
			'pk'    => 'rl_key',
		),
		'audit_logs'            => array(
			'cols'  => array( 'id' => 'id', 'actor_id' => 'id NULL', 'action' => 'key', 'target' => 'text', 'created_at' => 'date' ),
			'pk'    => 'id',
			'index' => array( 'created_at' ),
		),
		'catalog_products'      => array(
			'cols'  => array(
				'id' => 'id', 'agency_id' => 'id', 'title' => 'str', 'title_so' => 'str', 'category' => 'key', 'destination' => 'key',
				'route_badge' => 'str', 'specs' => 'text', 'supplier_name' => 'str', 'supplier_ref' => 'key', 'base_cents' => 'int',
				'tax_cents' => 'int', 'supplier_commission_pct' => 'real', 'available' => 'int DEFAULT 1', 'travel_date' => 'key NULL',
				'baggage' => "str DEFAULT ''", 'image_mime' => 'str NULL', 'image_data' => 'text NULL', 'is_published' => 'int DEFAULT 1',
				'image_updated_at' => 'key NULL', 'created_at' => 'date NULL',
			),
			'pk'    => 'id',
			'unique' => array( 'supplier_ref' ),
			'index' => array( 'agency_id' ),
		),
		'bookings'              => array(
			'cols'  => array(
				'id' => 'id', 'reference' => 'key', 'pnr' => 'key', 'agency_id' => 'id', 'customer_id' => 'id NULL',
				'traveler_name' => 'str', 'traveler_email' => 'str NULL', 'phone' => 'str', 'offer_title' => 'str', 'category' => 'key',
				'payment_provider' => 'key', 'state' => 'key', 'financials_json' => 'text', 'seat_count' => 'int DEFAULT 1',
				'travel_date' => 'key NULL', 'offer_id' => 'id NULL', 'cancellation_reason' => 'text NULL',
				'refund_status' => 'key NULL', 'refund_reference' => 'str NULL', 'refund_note' => 'text NULL', 'refunded_at' => 'date NULL',
				'created_at' => 'date', 'updated_at' => 'date',
			),
			'pk'    => 'id',
			'unique' => array( 'reference' ),
			'index' => array( 'agency_id', 'customer_id', 'state' ),
		),
		'phone_payments'        => array(
			'cols' => array(
				'id' => 'id', 'booking_id' => 'id', 'provider' => 'key', 'account_number' => 'key', 'amount_cents' => 'int',
				'currency' => "key DEFAULT 'USD'", 'status' => "key DEFAULT 'PENDING'", 'transaction_id' => 'str NULL',
				'error_message' => 'text NULL', 'started_at' => 'date NULL', 'created_at' => 'date', 'updated_at' => 'date',
			),
			'pk'     => 'id',
			'unique' => array( 'booking_id' ),
		),
		'agency_clients'        => array(
			'cols'  => array( 'id' => 'id', 'agency_id' => 'id', 'name' => 'str', 'phone' => 'str', 'email' => 'str NULL', 'created_at' => 'date' ),
			'pk'    => 'id',
			'index' => array( 'agency_id' ),
		),
		'agency_reviews'        => array(
			'cols'   => array(
				'id' => 'id', 'booking_id' => 'id', 'agency_id' => 'id', 'customer_id' => 'id', 'rating' => 'int', 'comment' => 'text NULL',
				'agency_reply' => 'text NULL', 'agency_reply_at' => 'date NULL', 'created_at' => 'date', 'updated_at' => 'date',
			),
			'pk'     => 'id',
			'unique' => array( 'booking_id' ),
			'index'  => array( 'agency_id' ),
		),
		'saved_offers'          => array(
			'cols' => array( 'user_id' => 'id', 'offer_id' => 'id', 'created_at' => 'date' ),
			'pk'   => 'user_id, offer_id',
		),
		'trip_waitlist'         => array(
			'cols' => array( 'offer_id' => 'id', 'user_id' => 'id', 'seat_count' => 'int DEFAULT 1', 'created_at' => 'date', 'notified_at' => 'date NULL' ),
			'pk'   => 'offer_id, user_id',
		),
		'conversations'         => array(
			'cols'  => array(
				'id' => 'id', 'agency_id' => 'id NULL', 'customer_id' => 'id NULL', 'booking_id' => 'id NULL', 'subject' => 'str',
				'created_by' => 'id', 'created_at' => 'date', 'last_message_at' => 'date',
			),
			'pk'    => 'id',
			'index' => array( 'agency_id', 'customer_id' ),
		),
		'conversation_hidden'   => array(
			'cols' => array( 'conversation_id' => 'id', 'user_id' => 'id', 'hidden_at' => 'date' ),
			'pk'   => 'conversation_id, user_id',
		),
		'messages'              => array(
			'cols'  => array(
				'id' => 'id', 'conversation_id' => 'id', 'sender_id' => 'id', 'body' => 'text', 'message_type' => "key DEFAULT 'TEXT'",
				'attachment_mime' => 'str NULL', 'attachment_data' => 'text NULL', 'attachment_name' => 'str NULL', 'duration_ms' => 'int NULL',
				'edited_at' => 'date NULL', 'created_at' => 'date', 'read_at' => 'date NULL',
			),
			'pk'    => 'id',
			'index' => array( 'conversation_id' ),
		),
		'notifications'         => array(
			'cols'   => array(
				'id' => 'id', 'recipient_user_id' => 'id', 'agency_id' => 'id NULL', 'booking_id' => 'id NULL', 'conversation_id' => 'id NULL',
				'type' => 'key', 'title' => 'str', 'body' => 'text', 'href' => 'str NULL', 'dedupe_key' => 'key', 'created_at' => 'date', 'read_at' => 'date NULL',
			),
			'pk'     => 'id',
			'unique' => array( 'dedupe_key' ),
			'index'  => array( 'recipient_user_id' ),
		),
		'notification_prefs'    => array(
			'cols' => array( 'user_id' => 'id', 'prefs_json' => 'text', 'updated_at' => 'date' ),
			'pk'   => 'user_id',
		),
		'blocked_parties'       => array(
			'cols' => array( 'blocker_id' => 'id', 'blocked_key' => 'key', 'created_at' => 'date' ),
			'pk'   => 'blocker_id, blocked_key',
		),
		'chat_calls'            => array(
			'cols'  => array(
				'id' => 'id', 'conversation_id' => 'id', 'caller_id' => 'id', 'callee_id' => 'id', 'call_type' => 'key',
				'status' => 'key', 'created_at' => 'date', 'accepted_at' => 'date NULL', 'ended_at' => 'date NULL',
				'caller_seen_at' => 'date NULL', 'callee_seen_at' => 'date NULL', 'caller_device' => 'key NULL', 'callee_device' => 'key NULL',
			),
			'pk'    => 'id',
			'index' => array( 'caller_id', 'callee_id', 'status' ),
		),
		'chat_call_signals'     => array(
			'cols'  => array( 'id' => 'autoid', 'call_id' => 'id', 'sender_id' => 'id', 'signal_type' => 'key', 'payload_json' => 'text', 'created_at' => 'date' ),
			'pk'    => 'id',
			'index' => array( 'call_id' ),
		),
		'chat_statuses'         => array(
			'cols'  => array(
				'id' => 'id', 'user_id' => 'id', 'body' => 'text NULL', 'background' => 'str NULL', 'attachment_mime' => 'str NULL',
				'attachment_data' => 'text NULL', 'audience' => "key DEFAULT 'EVERYONE'", 'created_at' => 'date', 'expires_at' => 'date',
			),
			'pk'    => 'id',
			'index' => array( 'user_id', 'expires_at' ),
		),
		'chat_status_replies'   => array(
			'cols'  => array( 'id' => 'id', 'status_id' => 'id', 'user_id' => 'id', 'body' => 'text', 'created_at' => 'date' ),
			'pk'    => 'id',
			'index' => array( 'status_id' ),
		),
		'chat_status_reactions' => array(
			'cols' => array( 'status_id' => 'id', 'user_id' => 'id', 'emoji' => 'str', 'created_at' => 'date' ),
			'pk'   => 'status_id, user_id',
		),
		'chat_communities'      => array(
			'cols' => array( 'id' => 'id', 'name' => 'str', 'description' => 'text NULL', 'created_by' => 'id', 'created_at' => 'date' ),
			'pk'   => 'id',
		),
		'chat_community_members' => array(
			'cols' => array( 'community_id' => 'id', 'user_id' => 'id', 'joined_at' => 'date' ),
			'pk'   => 'community_id, user_id',
		),
		'chat_community_messages' => array(
			'cols'  => array( 'id' => 'id', 'community_id' => 'id', 'sender_id' => 'id', 'body' => 'text', 'created_at' => 'date', 'edited_at' => 'date NULL' ),
			'pk'    => 'id',
			'index' => array( 'community_id' ),
		),
		'login_challenges'      => array(
			'cols'  => array( 'id' => 'key', 'user_id' => 'id', 'code_hash' => 'str', 'expires_at' => 'int', 'attempts' => 'int DEFAULT 0', 'created_at' => 'int' ),
			'pk'    => 'id',
			'index' => array( 'user_id' ),
		),
		'chat_status_views'     => array(
			'cols' => array( 'status_id' => 'id', 'viewer_id' => 'id', 'viewed_at' => 'date', 'reaction' => 'str NULL' ),
			'pk'   => 'status_id, viewer_id',
		),
	);
}

/** CREATE TABLE statements for MySQL or SQLite. */
function skw_schema_sql( $mysql ) {
	$out = array();
	foreach ( skw_schema() as $name => $def ) {
		$table = SKW_DB::table( $name );
		$lines = array();
		foreach ( $def['cols'] as $col => $spec ) {
			$lines[] = $col . ' ' . skw_column_sql( $spec, $mysql );
		}
		if ( 'autoid' !== reset( $def['cols'] ) || $mysql ) {
			$lines[] = 'PRIMARY KEY (' . $def['pk'] . ')';
		}
		$sql = 'CREATE TABLE IF NOT EXISTS ' . $table . " (\n  " . implode( ",\n  ", $lines ) . "\n)";
		if ( $mysql ) {
			$sql .= ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
		}
		$out[] = $sql;
		foreach ( isset( $def['unique'] ) ? $def['unique'] : array() as $col ) {
			$out[] = array( 'index', $table, 'ux_' . $col, $col, true );
		}
		foreach ( isset( $def['index'] ) ? $def['index'] : array() as $col ) {
			$out[] = array( 'index', $table, 'ix_' . $col, $col, false );
		}
	}
	return $out;
}

function skw_column_sql( $spec, $mysql ) {
	$parts = explode( ' ', $spec, 2 );
	$type  = $parts[0];
	$rest  = isset( $parts[1] ) ? ' ' . $parts[1] : '';
	$null  = false !== strpos( $rest, 'NULL' );
	$map   = array(
		'id'     => $mysql ? 'VARCHAR(64)' : 'TEXT',
		'key'    => $mysql ? 'VARCHAR(191)' : 'TEXT',
		'str'    => $mysql ? 'VARCHAR(255)' : 'TEXT',
		'date'   => $mysql ? 'VARCHAR(40)' : 'TEXT',
		'text'   => $mysql ? 'LONGTEXT' : 'TEXT',
		'int'    => $mysql ? 'BIGINT' : 'INTEGER',
		'real'   => $mysql ? 'DOUBLE' : 'REAL',
		'autoid' => $mysql ? 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT' : 'INTEGER PRIMARY KEY AUTOINCREMENT',
	);
	if ( 'autoid' === $type ) {
		return $map['autoid'];
	}
	$sql = $map[ $type ] . ( $null ? ' NULL' : ' NOT NULL' );
	if ( preg_match( "/DEFAULT\\s+('[^']*'|[0-9.]+)/", $rest, $m ) ) {
		// MySQL cannot give TEXT columns a default; those are always VARCHAR here.
		$sql .= ' DEFAULT ' . $m[1];
	}
	return $sql;
}

/** Creates missing tables, columns and indexes. Safe to run again. */
function skw_install_schema() {
	$mysql = SKW_DB::is_mysql();
	foreach ( skw_schema_sql( $mysql ) as $statement ) {
		if ( is_string( $statement ) ) {
			SKW_DB::exec_raw( $statement );
			continue;
		}
		list( , $table, $index, $col, $unique ) = $statement;
		if ( $mysql ) {
			$exists = SKW_DB::get_var( 'SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', array( $table, $index ) );
			if ( ! (int) $exists ) {
				SKW_DB::exec_raw( 'CREATE ' . ( $unique ? 'UNIQUE ' : '' ) . 'INDEX ' . $index . ' ON ' . $table . ' (' . $col . ')' );
			}
		} else {
			SKW_DB::exec_raw( 'CREATE ' . ( $unique ? 'UNIQUE ' : '' ) . 'INDEX IF NOT EXISTS ' . $table . '_' . $index . ' ON ' . $table . ' (' . $col . ')' );
		}
	}
	// Add columns that newer versions introduced to tables created by older versions.
	foreach ( skw_schema() as $name => $def ) {
		$table = SKW_DB::table( $name );
		if ( $mysql ) {
			$have = array_map( 'strtolower', array_column( SKW_DB::get_results( 'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?', array( $table ) ), 'c' ) );
		} else {
			$have = array_map( 'strtolower', array_column( SKW_DB::get_results( 'PRAGMA table_info(' . $table . ')' ), 'name' ) );
		}
		foreach ( $def['cols'] as $col => $spec ) {
			if ( ! in_array( strtolower( $col ), $have, true ) && 'autoid' !== $spec ) {
				$sql = skw_column_sql( $spec, $mysql );
				if ( false === strpos( $spec, 'NULL' ) && false === strpos( $spec, 'DEFAULT' ) ) {
					$sql = str_replace( ' NOT NULL', ' NULL', $sql );
				}
				SKW_DB::exec_raw( 'ALTER TABLE ' . $table . ' ADD COLUMN ' . $col . ' ' . $sql );
			}
		}
	}
}
