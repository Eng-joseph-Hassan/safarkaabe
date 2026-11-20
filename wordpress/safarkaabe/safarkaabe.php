<?php
/**
 * Plugin Name:       SAFAR KAABE
 * Plugin URI:        https://anfacmedia.com/safarkaabe/
 * Description:       The SAFAR KAABE travel marketplace running inside WordPress at /safarkaabe/ – travel agencies, trips, bookings, chat and payments. Data is kept in your own WordPress database. No outside server.
 * Version:           1.4.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            ANFAC Media
 * License:           GPL-2.0-or-later
 * Text Domain:       safarkaabe
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SKW_RUNNING', true );
define( 'SKW_VERSION', '1.4.0' );
define( 'SKW_FILE', __FILE__ );
define( 'SKW_DIR', plugin_dir_path( __FILE__ ) );

require_once SKW_DIR . 'includes/db.php';
require_once SKW_DIR . 'includes/schema.php';
require_once SKW_DIR . 'includes/http.php';
require_once SKW_DIR . 'includes/helpers.php';
require_once SKW_DIR . 'includes/auth.php';
require_once SKW_DIR . 'includes/webpush.php';
require_once SKW_DIR . 'includes/app.php';
require_once SKW_DIR . 'includes/wp-glue.php';
require_once SKW_DIR . 'includes/wp-showcase.php';

register_activation_hook( __FILE__, 'skw_wp_activate' );
