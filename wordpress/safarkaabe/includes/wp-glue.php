<?php
/**
 * WordPress connection: serves /safarkaabe/, creates the tables, admin page with settings and the setup token.
 */

if ( ! defined( 'ABSPATH' ) || ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

function skw_wp_setup_globals() {
	global $skw_config_loader, $skw_base_path, $skw_site_origin, $skw_mailer;
	SKW_DB::use_wpdb();
	$home_path         = (string) wp_parse_url( home_url( '/' ), PHP_URL_PATH );
	$skw_base_path     = rtrim( $home_path, '/' ) . '/' . trim( (string) get_option( 'skw_slug', 'safarkaabe' ), '/' ) . '/';
	$parts             = wp_parse_url( home_url() );
	$skw_site_origin   = $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' );
	$skw_config_loader = function () {
		$settings = get_option( 'skw_settings', array() );
		$settings = is_array( $settings ) ? $settings : array();
		$settings['setup_token'] = (string) get_option( 'skw_setup_token', '' );
		if ( empty( $settings['notification_email'] ) ) {
			$settings['notification_email'] = get_option( 'admin_email' );
		}
		return $settings;
	};
	$skw_mailer = function ( $to, $subject, $text ) {
		return wp_mail( $to, $subject, $text );
	};
}
add_action( 'plugins_loaded', 'skw_wp_setup_globals', 1 );

function skw_wp_activate() {
	skw_wp_setup_globals();
	skw_install_schema();
	update_option( 'skw_db_version', SKW_VERSION, false );
	if ( ! get_option( 'skw_setup_token' ) && ! SKW_DB::get_var( "SELECT 1 FROM {users} WHERE role = 'SUPER_ADMIN' LIMIT 1" ) ) {
		update_option( 'skw_setup_token', wp_generate_password( 24, false, false ), false );
	}
}

add_action( 'plugins_loaded', function () {
	if ( get_option( 'skw_db_version' ) !== SKW_VERSION ) {
		skw_wp_activate();
	}
}, 5 );

/**
 * Handles /safarkaabe/... before WordPress looks for a page, so it works with any permalink setting
 * and is never redirected or cached by WordPress.
 */
function skw_wp_route() {
	$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : '/';
	$path = (string) wp_parse_url( $uri, PHP_URL_PATH );
	$base = skw_base();
	if ( rtrim( $base, '/' ) === $path ) {
		$query = (string) wp_parse_url( $uri, PHP_URL_QUERY );
		wp_safe_redirect( $base . ( $query ? '?' . $query : '' ), 301 );
		exit;
	}
	if ( 0 !== strpos( $path, $base ) ) {
		return;
	}
	if ( ! defined( 'DONOTCACHEPAGE' ) ) {
		define( 'DONOTCACHEPAGE', true );
	}
	nocache_headers();
	$req = skw_request_from_globals();
	skw_handle( $req['method'], substr( $path, strlen( $base ) ), $req );
	exit;
}
add_action( 'init', 'skw_wp_route', 1 );

/** Never let WordPress "correct" the app address to another page. */
add_filter( 'redirect_canonical', function ( $redirect ) {
	$path = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ), PHP_URL_PATH ) : '';
	return 0 === strpos( $path, rtrim( skw_base(), '/' ) ) ? false : $redirect;
} );

/* ---------- Admin page ---------- */

add_action( 'admin_menu', function () {
	add_menu_page( 'SAFAR KAABE', 'SAFAR KAABE', 'manage_options', 'safarkaabe', 'skw_wp_admin_page', 'dashicons-airplane', 27 );
} );

function skw_wp_admin_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$secret_keys = array( 'waafi_api_key', 'edahab_api_key', 'edahab_secret_key' );
	if ( isset( $_POST['skw_save'] ) && check_admin_referer( 'skw_settings' ) ) {
		$current = get_option( 'skw_settings', array() );
		$current = is_array( $current ) ? $current : array();
		$fields  = array( 'notification_email', 'waafi_merchant_uid', 'waafi_api_user_id', 'waafi_api_key', 'waafi_base_url', 'edahab_agent_code', 'edahab_api_key', 'edahab_secret_key', 'edahab_base_url', 'pay_direct_text' );
		foreach ( $fields as $f ) {
			$v = isset( $_POST[ $f ] ) ? trim( sanitize_text_field( wp_unslash( $_POST[ $f ] ) ) ) : '';
			if ( in_array( $f, $secret_keys, true ) && '' === $v ) {
				continue; // Keep the saved secret.
			}
			$current[ $f ] = $v;
		}
		$current['waafi_enabled']  = empty( $_POST['waafi_enabled'] ) ? 0 : 1;
		$current['edahab_enabled'] = empty( $_POST['edahab_enabled'] ) ? 0 : 1;
		update_option( 'skw_settings', $current, false );
		echo '<div class="notice notice-success"><p>Saved.</p></div>';
	}
	if ( isset( $_POST['skw_new_token'] ) && check_admin_referer( 'skw_settings' ) ) {
		update_option( 'skw_setup_token', wp_generate_password( 24, false, false ), false );
	}
	$s       = get_option( 'skw_settings', array() );
	$s       = is_array( $s ) ? $s : array();
	$v       = function ( $k ) use ( $s ) {
		return isset( $s[ $k ] ) ? $s[ $k ] : '';
	};
	$app     = skw_app_url( '' );
	$counts  = array(
		'Agencies'   => (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {agencies}' ),
		'Travelers'  => (int) SKW_DB::get_var( "SELECT COUNT(*) FROM {users} WHERE role = 'CLIENT'" ),
		'Live trips' => (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {catalog_products} WHERE is_published = 1' ),
		'Bookings'   => (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {bookings}' ),
	);
	$has_admin = (bool) SKW_DB::get_var( "SELECT 1 FROM {users} WHERE role = 'SUPER_ADMIN' LIMIT 1" );
	echo '<div class="wrap"><h1>SAFAR KAABE</h1><p><a class="button button-primary" target="_blank" href="' . esc_url( $app ) . '">Open the app ↗</a> <code>' . esc_html( $app ) . '</code></p>';
	echo '<p>';
	foreach ( $counts as $label => $n ) {
		echo '<strong>' . esc_html( $n ) . '</strong> ' . esc_html( $label ) . ' &nbsp; ';
	}
	echo '</p>';
	echo '<form method="post">';
	wp_nonce_field( 'skw_settings' );
	if ( ! $has_admin ) {
		echo '<div class="notice notice-warning inline"><p><strong>First step:</strong> open the app, choose "Create Super Admin" and enter this one-time setup token:</p><p><code style="font-size:16px">' . esc_html( get_option( 'skw_setup_token' ) ) . '</code> <button class="button" name="skw_new_token" value="1">Make a new token</button></p></div>';
	}
	$field = function ( $k, $label, $type = 'text' ) use ( $v, $secret_keys ) {
		$secret = in_array( $k, $secret_keys, true );
		echo '<tr><th><label for="' . esc_attr( $k ) . '">' . esc_html( $label ) . '</label></th><td><input class="regular-text" type="' . esc_attr( $secret ? 'password' : $type ) . '" id="' . esc_attr( $k ) . '" name="' . esc_attr( $k ) . '" value="' . esc_attr( $secret ? '' : $v( $k ) ) . '" autocomplete="off" />'
			. ( $secret ? '<p class="description">' . esc_html( $v( $k ) ? 'Saved. Leave empty to keep it.' : 'Not set.' ) . '</p>' : '' ) . '</td></tr>';
	};
	echo '<h2>Settings</h2><table class="form-table">';
	$field( 'notification_email', 'Email for new bookings', 'email' );
	echo '<tr><th>Pay by phone – WaafiPay (EVC Plus, Zaad, Sahal)</th><td><label><input type="checkbox" name="waafi_enabled" value="1" ' . checked( 1, (int) $v( 'waafi_enabled' ), false ) . ' /> On</label></td></tr>';
	$field( 'waafi_merchant_uid', 'WaafiPay merchant UID' );
	$field( 'waafi_api_user_id', 'WaafiPay API user ID' );
	$field( 'waafi_api_key', 'WaafiPay API key' );
	$field( 'waafi_base_url', 'WaafiPay API address (empty = live)', 'url' );
	echo '<tr><th>Pay by phone – eDahab</th><td><label><input type="checkbox" name="edahab_enabled" value="1" ' . checked( 1, (int) $v( 'edahab_enabled' ), false ) . ' /> On</label></td></tr>';
	$field( 'edahab_agent_code', 'eDahab agent code' );
	$field( 'edahab_api_key', 'eDahab API key' );
	$field( 'edahab_secret_key', 'eDahab secret key' );
	echo '</table><p><button class="button button-primary" name="skw_save" value="1">Save</button></p></form>';
	echo '<p>Data is stored in your WordPress database (tables ' . esc_html( SKW_DB::table( '*' ) ) . '). If the app page shows another page, go to Settings → Permalinks → Save, then clear your site cache.</p></div>';
}
