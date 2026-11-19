<?php
/**
 * Database layer. Uses WordPress ($wpdb, MySQL) on the website and PDO SQLite in tests.
 * Module code writes portable SQL with "?" placeholders and never uses MySQL- or SQLite-only syntax.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

class SKW_DB {
	/** @var string 'wpdb' or 'pdo' */
	private static $driver = 'wpdb';
	/** @var PDO|null */
	private static $pdo = null;
	private static $prefix = 'wp_sk_';
	private static $depth = 0;

	public static function use_wpdb() {
		global $wpdb;
		self::$driver = 'wpdb';
		self::$prefix = $wpdb->prefix . 'sk_';
	}

	public static function use_pdo( PDO $pdo, $prefix = 'sk_' ) {
		self::$driver = 'pdo';
		self::$pdo    = $pdo;
		self::$prefix = $prefix;
		$pdo->setAttribute( PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION );
		$pdo->setAttribute( PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC );
		$pdo->exec( 'PRAGMA foreign_keys = OFF' );
		$pdo->exec( 'PRAGMA busy_timeout = 5000' );
	}

	public static function is_mysql() {
		return 'wpdb' === self::$driver;
	}

	public static function table( $name ) {
		return self::$prefix . $name;
	}

	/** Replaces {table} markers with full table names, e.g. "SELECT * FROM {users}". */
	private static function tables( $sql ) {
		return preg_replace_callback( '/\{([a-z_]+)\}/', function ( $m ) {
			return SKW_DB::table( $m[1] );
		}, $sql );
	}

	/** Inlines "?" placeholders (outside quotes) as safely escaped values, for $wpdb. */
	private static function bind_wpdb( $sql, $args ) {
		global $wpdb;
		$out    = '';
		$quote  = '';
		$i      = 0;
		$length = strlen( $sql );
		for ( $p = 0; $p < $length; $p++ ) {
			$c = $sql[ $p ];
			if ( $quote ) {
				$out .= $c;
				if ( $c === $quote ) {
					$quote = '';
				}
				continue;
			}
			if ( "'" === $c || '"' === $c ) {
				$quote = $c;
				$out  .= $c;
				continue;
			}
			if ( '?' === $c ) {
				if ( ! array_key_exists( $i, $args ) ) {
					throw new RuntimeException( 'Missing SQL argument ' . $i );
				}
				$v = $args[ $i++ ];
				if ( null === $v ) {
					$out .= 'NULL';
				} elseif ( is_bool( $v ) ) {
					$out .= $v ? '1' : '0';
				} elseif ( is_int( $v ) || is_float( $v ) ) {
					$out .= is_float( $v ) ? sprintf( '%.10F', $v ) : (string) $v;
				} else {
					$out .= "'" . $wpdb->_real_escape( (string) $v ) . "'";
				}
				continue;
			}
			$out .= $c;
		}
		return $out;
	}

	private static function run( $sql, $args, $mode ) {
		$sql = self::tables( $sql );
		$args = array_values( $args );
		if ( 'pdo' === self::$driver ) {
			$stmt = self::$pdo->prepare( $sql );
			foreach ( $args as $n => $v ) {
				$type = null === $v ? PDO::PARAM_NULL : ( is_int( $v ) || is_bool( $v ) ? PDO::PARAM_INT : PDO::PARAM_STR );
				$stmt->bindValue( $n + 1, is_bool( $v ) ? (int) $v : $v, $type );
			}
			$stmt->execute();
			if ( 'row' === $mode ) {
				$row = $stmt->fetch();
				return false === $row ? null : $row;
			}
			if ( 'all' === $mode ) {
				return $stmt->fetchAll();
			}
			if ( 'var' === $mode ) {
				$value = $stmt->fetchColumn();
				return false === $value ? null : $value;
			}
			return $stmt->rowCount();
		}
		global $wpdb;
		$query = self::bind_wpdb( $sql, $args );
		if ( 'row' === $mode ) {
			$row = $wpdb->get_row( $query, ARRAY_A );
			self::check_wpdb();
			return $row ? $row : null;
		}
		if ( 'all' === $mode ) {
			$rows = $wpdb->get_results( $query, ARRAY_A );
			self::check_wpdb();
			return $rows ? $rows : array();
		}
		if ( 'var' === $mode ) {
			$value = $wpdb->get_var( $query );
			self::check_wpdb();
			return $value;
		}
		$result = $wpdb->query( $query );
		self::check_wpdb();
		return false === $result ? 0 : (int) $result;
	}

	private static function check_wpdb() {
		global $wpdb;
		if ( $wpdb->last_error ) {
			$error = $wpdb->last_error;
			throw new RuntimeException( 'Database error: ' . $error );
		}
	}

	public static function get_row( $sql, $args = array() ) {
		return self::run( $sql, $args, 'row' );
	}

	public static function get_results( $sql, $args = array() ) {
		return self::run( $sql, $args, 'all' );
	}

	public static function get_var( $sql, $args = array() ) {
		return self::run( $sql, $args, 'var' );
	}

	/** Runs a statement and returns the number of affected rows. */
	public static function query( $sql, $args = array() ) {
		return self::run( $sql, $args, 'exec' );
	}

	public static function exec_raw( $sql ) {
		if ( 'pdo' === self::$driver ) {
			self::$pdo->exec( $sql );
			return;
		}
		global $wpdb;
		$wpdb->query( $sql ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared -- schema statements only.
		self::check_wpdb();
	}

	public static function insert( $table, $data ) {
		$cols = array_keys( $data );
		$sql  = 'INSERT INTO {' . $table . '} (' . implode( ', ', $cols ) . ') VALUES (' . implode( ', ', array_fill( 0, count( $cols ), '?' ) ) . ')';
		return self::query( $sql, array_values( $data ) );
	}

	/** UPDATE ... WHERE all $where columns match. Returns affected rows. */
	public static function update( $table, $data, $where ) {
		$set  = array();
		$args = array();
		foreach ( $data as $k => $v ) {
			$set[]  = $k . ' = ?';
			$args[] = $v;
		}
		$cond = array();
		foreach ( $where as $k => $v ) {
			$cond[] = $k . ' = ?';
			$args[] = $v;
		}
		return self::query( 'UPDATE {' . $table . '} SET ' . implode( ', ', $set ) . ' WHERE ' . implode( ' AND ', $cond ), $args );
	}

	/** Insert, or update the row with the same key columns. */
	public static function upsert( $table, $data, $keys ) {
		$where = array();
		foreach ( $keys as $k ) {
			$where[ $k ] = $data[ $k ];
		}
		$cond = array();
		$args = array();
		foreach ( $where as $k => $v ) {
			$cond[] = $k . ' = ?';
			$args[] = $v;
		}
		$exists = self::get_var( 'SELECT 1 FROM {' . $table . '} WHERE ' . implode( ' AND ', $cond ) . ' LIMIT 1', $args );
		if ( $exists ) {
			$rest = array_diff_key( $data, $where );
			return $rest ? self::update( $table, $rest, $where ) : 0;
		}
		return self::insert( $table, $data );
	}

	/** Runs $fn inside one transaction (nested calls join the outer one). */
	public static function transaction( $fn ) {
		if ( self::$depth > 0 ) {
			self::$depth++;
			try {
				return $fn();
			} finally {
				self::$depth--;
			}
		}
		self::$depth = 1;
		self::exec_raw( 'pdo' === self::$driver ? 'BEGIN IMMEDIATE' : 'START TRANSACTION' );
		try {
			$result = $fn();
			self::exec_raw( 'COMMIT' );
			return $result;
		} catch ( Exception $error ) {
			self::exec_raw( 'ROLLBACK' );
			throw $error;
		} finally {
			self::$depth = 0;
		}
	}

	/** Builds "?, ?, ?" for IN (...) lists. */
	public static function marks( $count ) {
		return implode( ', ', array_fill( 0, max( 1, (int) $count ), '?' ) );
	}

	/** True when the error came from a UNIQUE / duplicate key constraint. */
	public static function is_duplicate( Exception $error ) {
		$m = $error->getMessage();
		return false !== stripos( $m, 'UNIQUE constraint' ) || false !== stripos( $m, 'Duplicate entry' );
	}
}
