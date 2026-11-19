<?php
/**
 * Plugin Name:       ANFAC MEDIA Shop & SAFAR KAABE
 * Plugin URI:        https://travel-agancey-app.vercel.app
 * Description:       Sell ANFAC MEDIA products on your WordPress site (pay by phone with EVC Plus, Zaad, Sahal or eDahab) and show live SAFAR KAABE trips and app products.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            ANFAC MEDIA
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       anfac-media-safarkaabe
 * Domain Path:       /languages
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AMSK_VERSION', '1.0.0' );
define( 'AMSK_FILE', __FILE__ );
define( 'AMSK_DIR', plugin_dir_path( __FILE__ ) );
define( 'AMSK_URL', plugin_dir_url( __FILE__ ) );

require_once AMSK_DIR . 'includes/class-amsk-settings.php';
require_once AMSK_DIR . 'includes/class-amsk-products.php';
require_once AMSK_DIR . 'includes/class-amsk-payments.php';
require_once AMSK_DIR . 'includes/class-amsk-orders.php';
require_once AMSK_DIR . 'includes/class-amsk-cart.php';
require_once AMSK_DIR . 'includes/class-amsk-shortcodes.php';
require_once AMSK_DIR . 'includes/class-amsk-safarkaabe.php';

/**
 * Formats a price stored in cents, e.g. 1250 -> "$12.50".
 */
function amsk_money( $cents ) {
	return '$' . number_format_i18n( ( (int) $cents ) / 100, 2 );
}

add_action( 'plugins_loaded', function () {
	load_plugin_textdomain( 'anfac-media-safarkaabe', false, dirname( plugin_basename( AMSK_FILE ) ) . '/languages' );
} );

add_action( 'init', array( 'AMSK_Products', 'register' ) );
add_action( 'init', array( 'AMSK_Orders', 'register' ) );
add_action( 'init', array( 'AMSK_Shortcodes', 'register' ) );
add_action( 'init', array( 'AMSK_SafarKaabe', 'register' ) );
add_action( 'init', array( 'AMSK_Cart', 'register' ) );
add_action( 'admin_menu', array( 'AMSK_Settings', 'menu' ) );
add_action( 'admin_init', array( 'AMSK_Settings', 'register' ) );
add_action( 'add_meta_boxes', array( 'AMSK_Products', 'meta_boxes' ) );
add_action( 'add_meta_boxes', array( 'AMSK_Orders', 'meta_boxes' ) );
add_action( 'save_post_amsk_product', array( 'AMSK_Products', 'save' ), 10, 2 );
add_action( 'wp_enqueue_scripts', array( 'AMSK_Shortcodes', 'register_assets' ) );

register_activation_hook( __FILE__, function () {
	AMSK_Products::register();
	AMSK_Orders::register();
	$role = get_role( 'administrator' );
	if ( $role ) {
		$role->add_cap( 'amsk_manage_orders' );
	}
	flush_rewrite_rules();
} );

register_deactivation_hook( __FILE__, function () {
	flush_rewrite_rules();
} );
