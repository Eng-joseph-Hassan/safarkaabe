<?php
/**
 * Test server without WordPress: php -S 127.0.0.1:8890 tests/router.php
 * Env: SKW_TEST_DB (SQLite file), SKW_SETUP_TOKEN, SKW_MAIL_LOG (file that receives emails as JSON lines),
 *      SKW_TEST_CONFIG (JSON settings, e.g. pay-by-phone test addresses).
 */

define( 'SKW_RUNNING', true );
define( 'SKW_DIR', dirname( __DIR__ ) . DIRECTORY_SEPARATOR );
require SKW_DIR . 'includes/db.php';
require SKW_DIR . 'includes/schema.php';
require SKW_DIR . 'includes/http.php';
require SKW_DIR . 'includes/helpers.php';
require SKW_DIR . 'includes/auth.php';
require SKW_DIR . 'includes/app.php';

if ( getenv( 'SKW_TEST_MYSQL' ) ) {
	// "host:port:user:database" – tests the WordPress ($wpdb, MySQL/MariaDB) database code.
	require __DIR__ . '/fake-wpdb.php';
	list( $mh, $mp, $mu, $mn ) = explode( ':', getenv( 'SKW_TEST_MYSQL' ) );
	$GLOBALS['wpdb'] = new SKW_Fake_WPDB( $mh, $mp, $mu, '', $mn );
	SKW_DB::use_wpdb();
	if ( ! SKW_DB::get_var( 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', array( SKW_DB::table( 'users' ) ) ) ) {
		skw_install_schema();
	}
} else {
	$db_file = getenv( 'SKW_TEST_DB' ) ? getenv( 'SKW_TEST_DB' ) : sys_get_temp_dir() . '/skw-test.sqlite';
	$fresh   = ! file_exists( $db_file );
	SKW_DB::use_pdo( new PDO( 'sqlite:' . $db_file ) );
	if ( $fresh || ! SKW_DB::get_var( "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sk_users'" ) ) {
		skw_install_schema();
	}
}

$GLOBALS['skw_base_path']     = '/safarkaabe/';
$GLOBALS['skw_site_origin']   = 'http://' . ( isset( $_SERVER['HTTP_HOST'] ) ? $_SERVER['HTTP_HOST'] : '127.0.0.1' );
$GLOBALS['skw_config_loader'] = function () {
	$config = json_decode( (string) getenv( 'SKW_TEST_CONFIG' ), true );
	$config = is_array( $config ) ? $config : array();
	$config['setup_token']        = (string) getenv( 'SKW_SETUP_TOKEN' );
	$config['notification_email'] = 'owner@example.test';
	return $config;
};
$GLOBALS['skw_mailer'] = function ( $to, $subject, $text ) {
	$log = getenv( 'SKW_MAIL_LOG' );
	if ( $log ) {
		file_put_contents( $log, json_encode( array( 'to' => $to, 'subject' => $subject, 'text' => $text ) ) . "\n", FILE_APPEND );
	}
	return true;
};

$path = (string) parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
if ( '/safarkaabe' === $path ) {
	header( 'Location: /safarkaabe/', true, 301 );
	return true;
}
if ( 0 !== strpos( $path, '/safarkaabe/' ) ) {
	http_response_code( 404 );
	echo 'Not the app';
	return true;
}
$req = skw_request_from_globals();
skw_handle( $req['method'], substr( $path, strlen( '/safarkaabe/' ) ), $req );
return true;
