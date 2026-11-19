<?php
/**
 * Runs when the plugin is deleted in WP Admin. Settings are always removed.
 * Products and orders are only deleted when "Delete all products and orders" was turned on in Settings.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

$amsk_settings = get_option( 'amsk_settings', array() );
if ( is_array( $amsk_settings ) && ! empty( $amsk_settings['delete_data'] ) ) {
	foreach ( array( 'amsk_product', 'amsk_order' ) as $amsk_type ) {
		$amsk_ids = get_posts( array( 'post_type' => $amsk_type, 'post_status' => 'any', 'posts_per_page' => -1, 'fields' => 'ids' ) );
		foreach ( $amsk_ids as $amsk_id ) {
			wp_delete_post( $amsk_id, true );
		}
	}
	$amsk_terms = get_terms( array( 'taxonomy' => 'amsk_product_cat', 'hide_empty' => false, 'fields' => 'ids' ) );
	if ( is_array( $amsk_terms ) ) {
		foreach ( $amsk_terms as $amsk_term ) {
			wp_delete_term( $amsk_term, 'amsk_product_cat' );
		}
	}
}

delete_option( 'amsk_settings' );
delete_transient( 'amsk_sk_catalog' );
delete_transient( 'amsk_sk_agencies' );
delete_transient( 'amsk_sk_products' );

$amsk_role = get_role( 'administrator' );
if ( $amsk_role ) {
	$amsk_role->remove_cap( 'amsk_manage_orders' );
}
