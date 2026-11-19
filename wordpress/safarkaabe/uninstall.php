<?php
/**
 * Runs when the plugin is deleted in WordPress. Removes the settings only.
 * Your travel data (agencies, trips, bookings, chats) stays in the wp_sk_* tables, so nothing is lost by mistake.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'skw_settings' );
delete_option( 'skw_setup_token' );
delete_option( 'skw_db_version' );
delete_option( 'skw_slug' );
