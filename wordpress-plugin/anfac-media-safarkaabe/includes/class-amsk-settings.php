<?php
/**
 * Settings page: ANFAC MEDIA -> Settings.
 * Payment secrets are stored as options and are never printed back into pages or the REST API.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AMSK_Settings {
	const OPTION = 'amsk_settings';

	/** Secret fields: shown as empty password boxes; left empty = keep the saved value. */
	const SECRETS = array( 'waafi_api_key', 'edahab_api_key', 'edahab_secret_key' );

	public static function defaults() {
		return array(
			'notification_email'   => get_option( 'admin_email' ),
			'pay_seller_enabled'   => 1,
			'pay_seller_text'      => __( 'Pay ANFAC MEDIA by EVC Plus, Zaad or cash. We will contact you to confirm your order.', 'anfac-media-safarkaabe' ),
			'waafi_enabled'        => 0,
			'waafi_merchant_uid'   => '',
			'waafi_api_user_id'    => '',
			'waafi_api_key'        => '',
			'waafi_base_url'       => 'https://api.waafipay.net/asm',
			'edahab_enabled'       => 0,
			'edahab_agent_code'    => '',
			'edahab_api_key'       => '',
			'edahab_secret_key'    => '',
			'edahab_base_url'      => 'https://edahab.net/api',
			'app_url'              => 'https://travel-agancey-app.vercel.app',
			'delete_data'          => 0,
		);
	}

	public static function get( $key = null ) {
		$saved    = get_option( self::OPTION, array() );
		$settings = wp_parse_args( is_array( $saved ) ? $saved : array(), self::defaults() );
		if ( null === $key ) {
			return $settings;
		}
		return isset( $settings[ $key ] ) ? $settings[ $key ] : null;
	}

	public static function menu() {
		add_menu_page(
			__( 'ANFAC MEDIA', 'anfac-media-safarkaabe' ),
			__( 'ANFAC MEDIA', 'anfac-media-safarkaabe' ),
			'amsk_manage_orders',
			'edit.php?post_type=amsk_order',
			'',
			'dashicons-cart',
			26
		);
		add_submenu_page( 'edit.php?post_type=amsk_order', __( 'Orders', 'anfac-media-safarkaabe' ), __( 'Orders', 'anfac-media-safarkaabe' ), 'amsk_manage_orders', 'edit.php?post_type=amsk_order' );
		add_submenu_page( 'edit.php?post_type=amsk_order', __( 'Products', 'anfac-media-safarkaabe' ), __( 'Products', 'anfac-media-safarkaabe' ), 'edit_posts', 'edit.php?post_type=amsk_product' );
		add_submenu_page( 'edit.php?post_type=amsk_order', __( 'Settings', 'anfac-media-safarkaabe' ), __( 'Settings', 'anfac-media-safarkaabe' ), 'manage_options', 'amsk-settings', array( __CLASS__, 'render' ) );
	}

	public static function register() {
		register_setting( 'amsk_settings_group', self::OPTION, array(
			'type'              => 'array',
			'sanitize_callback' => array( __CLASS__, 'sanitize' ),
			'show_in_rest'      => false,
		) );
	}

	public static function sanitize( $input ) {
		$current = self::get();
		$input   = is_array( $input ) ? $input : array();
		$clean   = array();
		$clean['notification_email'] = sanitize_email( isset( $input['notification_email'] ) ? $input['notification_email'] : '' );
		$clean['pay_seller_enabled'] = empty( $input['pay_seller_enabled'] ) ? 0 : 1;
		$clean['pay_seller_text']    = sanitize_textarea_field( isset( $input['pay_seller_text'] ) ? $input['pay_seller_text'] : '' );
		$clean['waafi_enabled']      = empty( $input['waafi_enabled'] ) ? 0 : 1;
		$clean['edahab_enabled']     = empty( $input['edahab_enabled'] ) ? 0 : 1;
		$clean['delete_data']        = empty( $input['delete_data'] ) ? 0 : 1;
		foreach ( array( 'waafi_merchant_uid', 'waafi_api_user_id', 'edahab_agent_code' ) as $field ) {
			$clean[ $field ] = sanitize_text_field( isset( $input[ $field ] ) ? $input[ $field ] : '' );
		}
		foreach ( array( 'waafi_base_url', 'edahab_base_url', 'app_url' ) as $field ) {
			$url             = esc_url_raw( trim( isset( $input[ $field ] ) ? $input[ $field ] : '' ), array( 'https', 'http' ) );
			$clean[ $field ] = $url ? untrailingslashit( $url ) : self::defaults()[ $field ];
		}
		foreach ( self::SECRETS as $field ) {
			$value           = isset( $input[ $field ] ) ? trim( sanitize_text_field( $input[ $field ] ) ) : '';
			$clean[ $field ] = '' === $value ? $current[ $field ] : $value;
		}
		// Changing the app address should show fresh trips right away.
		delete_transient( 'amsk_sk_catalog' );
		delete_transient( 'amsk_sk_agencies' );
		delete_transient( 'amsk_sk_products' );
		return $clean;
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$s = self::get();
		$text = function ( $key, $label, $help = '', $type = 'text' ) use ( $s ) {
			$is_secret = in_array( $key, AMSK_Settings::SECRETS, true );
			printf(
				'<tr><th scope="row"><label for="amsk_%1$s">%2$s</label></th><td><input type="%3$s" class="regular-text" id="amsk_%1$s" name="%4$s[%1$s]" value="%5$s" autocomplete="off" />%6$s</td></tr>',
				esc_attr( $key ),
				esc_html( $label ),
				esc_attr( $is_secret ? 'password' : $type ),
				esc_attr( AMSK_Settings::OPTION ),
				esc_attr( $is_secret ? '' : $s[ $key ] ),
				$is_secret
					? '<p class="description">' . esc_html( $s[ $key ] ? __( 'Saved. Leave empty to keep it.', 'anfac-media-safarkaabe' ) : __( 'Not set.', 'anfac-media-safarkaabe' ) ) . '</p>'
					: ( $help ? '<p class="description">' . esc_html( $help ) . '</p>' : '' )
			);
		};
		$check = function ( $key, $label ) use ( $s ) {
			printf(
				'<tr><th scope="row">%2$s</th><td><label><input type="checkbox" name="%3$s[%1$s]" value="1" %4$s /> %5$s</label></td></tr>',
				esc_attr( $key ),
				esc_html( $label ),
				esc_attr( AMSK_Settings::OPTION ),
				checked( 1, (int) $s[ $key ], false ),
				esc_html__( 'On', 'anfac-media-safarkaabe' )
			);
		};
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'ANFAC MEDIA Shop & SAFAR KAABE settings', 'anfac-media-safarkaabe' ); ?></h1>
			<form method="post" action="options.php">
				<?php settings_fields( 'amsk_settings_group' ); ?>
				<h2><?php esc_html_e( 'Orders', 'anfac-media-safarkaabe' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php $text( 'notification_email', __( 'Send new orders to this email', 'anfac-media-safarkaabe' ), '', 'email' ); ?>
				</table>
				<h2><?php esc_html_e( 'Pay the seller directly', 'anfac-media-safarkaabe' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php $check( 'pay_seller_enabled', __( 'Offer this option', 'anfac-media-safarkaabe' ) ); ?>
					<tr><th scope="row"><label for="amsk_pay_seller_text"><?php esc_html_e( 'Instructions for buyers', 'anfac-media-safarkaabe' ); ?></label></th>
						<td><textarea id="amsk_pay_seller_text" class="large-text" rows="3" name="<?php echo esc_attr( self::OPTION ); ?>[pay_seller_text]"><?php echo esc_textarea( $s['pay_seller_text'] ); ?></textarea></td></tr>
				</table>
				<h2><?php esc_html_e( 'Pay by phone – WaafiPay (EVC Plus, Zaad, Sahal)', 'anfac-media-safarkaabe' ); ?></h2>
				<p><?php esc_html_e( 'Ask WaafiPay for API access. These keys are different from the hosted payment page keys.', 'anfac-media-safarkaabe' ); ?></p>
				<table class="form-table" role="presentation">
					<?php
					$check( 'waafi_enabled', __( 'Offer WaafiPay', 'anfac-media-safarkaabe' ) );
					$text( 'waafi_merchant_uid', __( 'Merchant UID', 'anfac-media-safarkaabe' ) );
					$text( 'waafi_api_user_id', __( 'API user ID', 'anfac-media-safarkaabe' ) );
					$text( 'waafi_api_key', __( 'API key', 'anfac-media-safarkaabe' ) );
					$text( 'waafi_base_url', __( 'API address', 'anfac-media-safarkaabe' ), __( 'Live: https://api.waafipay.net/asm – Test: https://sandbox.waafipay.net/asm', 'anfac-media-safarkaabe' ), 'url' );
					?>
				</table>
				<h2><?php esc_html_e( 'Pay by phone – eDahab', 'anfac-media-safarkaabe' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					$check( 'edahab_enabled', __( 'Offer eDahab', 'anfac-media-safarkaabe' ) );
					$text( 'edahab_agent_code', __( 'Agent code', 'anfac-media-safarkaabe' ) );
					$text( 'edahab_api_key', __( 'API key', 'anfac-media-safarkaabe' ) );
					$text( 'edahab_secret_key', __( 'Secret key', 'anfac-media-safarkaabe' ) );
					$text( 'edahab_base_url', __( 'API address', 'anfac-media-safarkaabe' ), '', 'url' );
					?>
				</table>
				<h2><?php esc_html_e( 'SAFAR KAABE', 'anfac-media-safarkaabe' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php $text( 'app_url', __( 'SAFAR KAABE app address', 'anfac-media-safarkaabe' ), '', 'url' ); ?>
				</table>
				<h2><?php esc_html_e( 'Uninstall', 'anfac-media-safarkaabe' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php $check( 'delete_data', __( 'Delete all products and orders when the plugin is deleted', 'anfac-media-safarkaabe' ) ); ?>
				</table>
				<?php submit_button(); ?>
			</form>
			<h2><?php esc_html_e( 'Shortcodes', 'anfac-media-safarkaabe' ); ?></h2>
			<ul>
				<li><code>[amsk_shop columns="3" category=""]</code> – <?php esc_html_e( 'product grid', 'anfac-media-safarkaabe' ); ?></li>
				<li><code>[amsk_cart]</code> – <?php esc_html_e( 'cart and checkout', 'anfac-media-safarkaabe' ); ?></li>
				<li><code>[amsk_my_orders]</code> – <?php esc_html_e( 'order status for buyers', 'anfac-media-safarkaabe' ); ?></li>
				<li><code>[amsk_product id="123"]</code> – <?php esc_html_e( 'one product', 'anfac-media-safarkaabe' ); ?></li>
				<li><code>[safarkaabe_trips limit="12" category="" agency=""]</code> – <?php esc_html_e( 'live trips from SAFAR KAABE', 'anfac-media-safarkaabe' ); ?></li>
				<li><code>[safarkaabe_app_products limit="12"]</code> – <?php esc_html_e( 'ANFAC MEDIA products from the SAFAR KAABE app', 'anfac-media-safarkaabe' ); ?></li>
			</ul>
		</div>
		<?php
	}
}
