<?php
/**
 * ANFAC MEDIA products: a custom post type with price, stock and SKU.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AMSK_Products {
	const STOCK_KEY = '_amsk_stock';
	const PRICE_KEY = '_amsk_price_cents';

	public static function register() {
		register_post_type( 'amsk_product', array(
			'labels'       => array(
				'name'          => __( 'ANFAC MEDIA products', 'anfac-media-safarkaabe' ),
				'singular_name' => __( 'Product', 'anfac-media-safarkaabe' ),
				'add_new_item'  => __( 'Add product', 'anfac-media-safarkaabe' ),
				'edit_item'     => __( 'Edit product', 'anfac-media-safarkaabe' ),
				'menu_name'     => __( 'Products', 'anfac-media-safarkaabe' ),
			),
			'public'       => true,
			'show_in_menu' => false,
			'show_in_rest' => true,
			'has_archive'  => false,
			'rewrite'      => array( 'slug' => 'anfac-product' ),
			'supports'     => array( 'title', 'editor', 'thumbnail', 'excerpt' ),
		) );
		register_taxonomy( 'amsk_product_cat', 'amsk_product', array(
			'labels'       => array(
				'name'          => __( 'Product categories', 'anfac-media-safarkaabe' ),
				'singular_name' => __( 'Product category', 'anfac-media-safarkaabe' ),
			),
			'hierarchical' => true,
			'show_in_rest' => true,
			'rewrite'      => array( 'slug' => 'anfac-product-category' ),
		) );
	}

	public static function meta_boxes() {
		add_meta_box( 'amsk_product_details', __( 'Price and stock', 'anfac-media-safarkaabe' ), array( __CLASS__, 'render_meta_box' ), 'amsk_product', 'side', 'high' );
	}

	public static function render_meta_box( $post ) {
		wp_nonce_field( 'amsk_save_product', 'amsk_product_nonce' );
		$price = get_post_meta( $post->ID, self::PRICE_KEY, true );
		$stock = get_post_meta( $post->ID, self::STOCK_KEY, true );
		$sku   = get_post_meta( $post->ID, '_amsk_sku', true );
		?>
		<p><label for="amsk_price"><strong><?php esc_html_e( 'Price (US dollars)', 'anfac-media-safarkaabe' ); ?></strong></label><br />
			<input type="number" id="amsk_price" name="amsk_price" min="0.01" max="100000" step="0.01" value="<?php echo esc_attr( '' === $price ? '' : number_format( ( (int) $price ) / 100, 2, '.', '' ) ); ?>" required /></p>
		<p><label for="amsk_stock"><strong><?php esc_html_e( 'How many are available', 'anfac-media-safarkaabe' ); ?></strong></label><br />
			<input type="number" id="amsk_stock" name="amsk_stock" min="0" max="100000" step="1" value="<?php echo esc_attr( $stock ); ?>" /><br />
			<span class="description"><?php esc_html_e( 'Leave empty for no limit (for example a service).', 'anfac-media-safarkaabe' ); ?></span></p>
		<p><label for="amsk_sku"><strong><?php esc_html_e( 'Product code (optional)', 'anfac-media-safarkaabe' ); ?></strong></label><br />
			<input type="text" id="amsk_sku" name="amsk_sku" maxlength="40" value="<?php echo esc_attr( $sku ); ?>" /></p>
		<?php
	}

	public static function save( $post_id, $post ) {
		if ( ! isset( $_POST['amsk_product_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['amsk_product_nonce'] ) ), 'amsk_save_product' ) ) {
			return;
		}
		if ( ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) || wp_is_post_revision( $post_id ) || ! current_user_can( 'edit_post', $post_id ) ) {
			return;
		}
		if ( isset( $_POST['amsk_price'] ) ) {
			$price = (float) sanitize_text_field( wp_unslash( $_POST['amsk_price'] ) );
			if ( $price > 0 && $price <= 100000 ) {
				update_post_meta( $post_id, self::PRICE_KEY, (int) round( $price * 100 ) );
			}
		}
		if ( isset( $_POST['amsk_stock'] ) ) {
			$stock = trim( sanitize_text_field( wp_unslash( $_POST['amsk_stock'] ) ) );
			if ( '' === $stock ) {
				update_post_meta( $post_id, self::STOCK_KEY, '' );
			} elseif ( ctype_digit( $stock ) && (int) $stock <= 100000 ) {
				update_post_meta( $post_id, self::STOCK_KEY, (string) (int) $stock );
			}
		}
		if ( isset( $_POST['amsk_sku'] ) ) {
			update_post_meta( $post_id, '_amsk_sku', substr( sanitize_text_field( wp_unslash( $_POST['amsk_sku'] ) ), 0, 40 ) );
		}
	}

	/** Returns sale info for a published product, or null. */
	public static function get_sellable( $product_id ) {
		$post = get_post( (int) $product_id );
		if ( ! $post || 'amsk_product' !== $post->post_type || 'publish' !== $post->post_status ) {
			return null;
		}
		$price = get_post_meta( $post->ID, self::PRICE_KEY, true );
		if ( '' === $price || (int) $price <= 0 ) {
			return null;
		}
		$stock = get_post_meta( $post->ID, self::STOCK_KEY, true );
		return array(
			'id'          => $post->ID,
			'title'       => get_the_title( $post ),
			'price_cents' => (int) $price,
			'stock'       => '' === $stock ? null : (int) $stock,
		);
	}

	/**
	 * Takes stock atomically. Returns true when there was enough (or no limit).
	 * The single UPDATE with "stock >= qty" stops two buyers taking the last item at the same time.
	 */
	public static function take_stock( $product_id, $qty ) {
		global $wpdb;
		$stock = get_post_meta( $product_id, self::STOCK_KEY, true );
		if ( '' === $stock ) {
			return true;
		}
		$updated = $wpdb->query( $wpdb->prepare(
			"UPDATE {$wpdb->postmeta} SET meta_value = CAST(meta_value AS SIGNED) - %d
			WHERE post_id = %d AND meta_key = %s AND meta_value <> '' AND CAST(meta_value AS SIGNED) >= %d",
			$qty, $product_id, self::STOCK_KEY, $qty
		) );
		wp_cache_delete( $product_id, 'post_meta' );
		return 1 === (int) $updated;
	}

	public static function return_stock( $product_id, $qty ) {
		global $wpdb;
		$wpdb->query( $wpdb->prepare(
			"UPDATE {$wpdb->postmeta} SET meta_value = CAST(meta_value AS SIGNED) + %d
			WHERE post_id = %d AND meta_key = %s AND meta_value <> ''",
			$qty, $product_id, self::STOCK_KEY
		) );
		wp_cache_delete( $product_id, 'post_meta' );
	}
}
