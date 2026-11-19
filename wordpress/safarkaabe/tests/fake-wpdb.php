<?php
/**
 * A minimal stand-in for WordPress's $wpdb (MySQL/MariaDB through mysqli), so the plugin's real
 * WordPress database code can be tested without WordPress.
 */

if ( ! defined( 'ARRAY_A' ) ) {
	define( 'ARRAY_A', 'ARRAY_A' );
}

class SKW_Fake_WPDB {
	public $prefix     = 'wp_';
	public $last_error = '';
	private $db;

	public function __construct( $host, $port, $user, $pass, $name ) {
		mysqli_report( MYSQLI_REPORT_OFF );
		$this->db = new mysqli( $host, $user, $pass, $name, (int) $port );
		$this->db->set_charset( 'utf8mb4' );
	}

	public function _real_escape( $text ) {
		return $this->db->real_escape_string( $text );
	}

	private function run( $sql ) {
		$this->last_error = '';
		$result           = $this->db->query( $sql );
		if ( false === $result ) {
			$this->last_error = $this->db->error;
		}
		return $result;
	}

	public function get_results( $sql, $mode = ARRAY_A ) {
		$r = $this->run( $sql );
		return $r instanceof mysqli_result ? $r->fetch_all( MYSQLI_ASSOC ) : array();
	}

	public function get_row( $sql, $mode = ARRAY_A ) {
		$r = $this->run( $sql );
		return $r instanceof mysqli_result ? $r->fetch_assoc() : null;
	}

	public function get_var( $sql ) {
		$r = $this->run( $sql );
		if ( ! $r instanceof mysqli_result ) {
			return null;
		}
		$row = $r->fetch_row();
		return $row ? $row[0] : null;
	}

	public function query( $sql ) {
		$r = $this->run( $sql );
		return false === $r ? false : $this->db->affected_rows;
	}
}
