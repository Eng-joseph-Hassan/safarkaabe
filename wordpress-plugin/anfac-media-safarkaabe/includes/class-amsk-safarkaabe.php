<?php
/**
 * Live SAFAR KAABE content: [safarkaabe_trips] and [safarkaabe_app_products].
 * Data is fetched on the server from the app's public API and cached for 60 seconds.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AMSK_SafarKaabe {
	const CACHE_SECONDS = 60;

	public static function register() {
		add_shortcode( 'safarkaabe_trips', array( __CLASS__, 'trips' ) );
		add_shortcode( 'safarkaabe_app_products', array( __CLASS__, 'app_products' ) );
	}

	private static function app_url() {
		return untrailingslashit( AMSK_Settings::get( 'app_url' ) );
	}

	/**
	 * GETs JSON from the app, cached. Returns the decoded array, or null when unreachable.
	 * A short "failed" cache stops every page view waiting on an app that is down.
	 */
	private static function fetch( $path, $cache_key ) {
		$cached = get_transient( $cache_key );
		if ( is_array( $cached ) ) {
			return isset( $cached['__failed'] ) ? null : $cached;
		}
		$response = wp_remote_get( self::app_url() . $path, array(
			'timeout'     => 8,
			'redirection' => 2,
			'headers'     => array( 'Accept' => 'application/json' ),
		) );
		$code = is_wp_error( $response ) ? 0 : (int) wp_remote_retrieve_response_code( $response );
		$data = 200 === $code ? json_decode( wp_remote_retrieve_body( $response ), true ) : null;
		if ( ! is_array( $data ) ) {
			set_transient( $cache_key, array( '__failed' => true, 'code' => $code ), 30 );
			return null;
		}
		set_transient( $cache_key, $data, self::CACHE_SECONDS );
		return $data;
	}

	/** Turns an app path such as /api/catalog/x/image into a full https address on the app. */
	private static function absolute( $path ) {
		if ( ! is_string( $path ) || '' === $path ) {
			return '';
		}
		if ( 0 === strpos( $path, 'https://' ) || 0 === strpos( $path, 'http://' ) ) {
			return $path;
		}
		return self::app_url() . '/' . ltrim( $path, '/' );
	}

	private static function categories() {
		return array(
			'FLIGHT'   => __( 'Flight', 'anfac-media-safarkaabe' ),
			'HOTEL'    => __( 'Hotel', 'anfac-media-safarkaabe' ),
			'CAR'      => __( 'Car rental', 'anfac-media-safarkaabe' ),
			'TOUR'     => __( 'Tour', 'anfac-media-safarkaabe' ),
			'TRANSFER' => __( 'Transfer', 'anfac-media-safarkaabe' ),
			'PACKAGE'  => __( 'Package', 'anfac-media-safarkaabe' ),
		);
	}

	public static function trips( $atts ) {
		AMSK_Shortcodes::enqueue();
		$atts    = shortcode_atts( array( 'limit' => 12, 'category' => '', 'agency' => '', 'columns' => 3 ), $atts, 'safarkaabe_trips' );
		$catalog = self::fetch( '/api/catalog', 'amsk_sk_catalog' );
		if ( null === $catalog || ! isset( $catalog['catalog'] ) || ! is_array( $catalog['catalog'] ) ) {
			return '<p class="amsk-empty">' . esc_html__( 'Trips cannot be shown right now. Please try again in a few minutes.', 'anfac-media-safarkaabe' ) . '</p>';
		}
		$agencies = self::fetch( '/api/agencies/active', 'amsk_sk_agencies' );
		$names    = array();
		if ( is_array( $agencies ) && isset( $agencies['agencies'] ) && is_array( $agencies['agencies'] ) ) {
			foreach ( $agencies['agencies'] as $agency ) {
				if ( isset( $agency['id'], $agency['name'] ) ) {
					$names[ (string) $agency['id'] ] = (string) $agency['name'];
				}
			}
		}
		$category = strtoupper( sanitize_key( $atts['category'] ) );
		$agency   = strtolower( sanitize_text_field( $atts['agency'] ) );
		$limit    = max( 1, min( 60, (int) $atts['limit'] ) );
		$cats     = self::categories();
		$app      = self::app_url();
		$cards    = array();
		foreach ( $catalog['catalog'] as $trip ) {
			if ( ! is_array( $trip ) || empty( $trip['id'] ) ) {
				continue;
			}
			$trip_agency = isset( $names[ (string) ( isset( $trip['agencyId'] ) ? $trip['agencyId'] : '' ) ] ) ? $names[ (string) $trip['agencyId'] ] : '';
			if ( $category && ( ! isset( $trip['category'] ) || strtoupper( $trip['category'] ) !== $category ) ) {
				continue;
			}
			if ( $agency && false === strpos( strtolower( $trip_agency ), $agency ) && ( ! isset( $trip['agencyId'] ) || strtolower( (string) $trip['agencyId'] ) !== $agency ) ) {
				continue;
			}
			$price = isset( $trip['estimatedTotalUsdCents'] ) ? (int) $trip['estimatedTotalUsdCents'] : 0;
			$seats = isset( $trip['available'] ) ? (int) $trip['available'] : 0;
			$image = self::absolute( isset( $trip['imageUrl'] ) ? $trip['imageUrl'] : '' );
			$title = isset( $trip['titleEn'] ) ? (string) $trip['titleEn'] : '';
			ob_start();
			?>
			<article class="amsk-card amsk-card--trip">
				<?php if ( $image ) : ?>
					<img class="amsk-card__image" src="<?php echo esc_url( $image ); ?>" alt="<?php echo esc_attr( $title ); ?>" loading="lazy" />
				<?php else : ?>
					<div class="amsk-card__image amsk-card__image--empty" aria-hidden="true"></div>
				<?php endif; ?>
				<div class="amsk-card__body">
					<span class="amsk-card__tag"><?php echo esc_html( isset( $trip['category'], $cats[ $trip['category'] ] ) ? $cats[ $trip['category'] ] : __( 'Trip', 'anfac-media-safarkaabe' ) ); ?></span>
					<?php if ( ! empty( $trip['routeBadge'] ) ) : ?>
						<span class="amsk-card__route"><?php echo esc_html( $trip['routeBadge'] ); ?></span>
					<?php endif; ?>
					<h3 class="amsk-card__title"><?php echo esc_html( $title ); ?></h3>
					<p class="amsk-card__meta">
						<?php echo esc_html( ! empty( $trip['travelDate'] ) ? sprintf( /* translators: %s: date */ __( 'Departure %s', 'anfac-media-safarkaabe' ), $trip['travelDate'] ) : __( 'Flexible date', 'anfac-media-safarkaabe' ) ); ?>
						&middot; <?php echo esc_html( sprintf( /* translators: %d: seats */ _n( '%d seat left', '%d seats left', $seats, 'anfac-media-safarkaabe' ), $seats ) ); ?>
					</p>
					<?php if ( $trip_agency ) : ?>
						<p class="amsk-card__meta">
							<?php echo esc_html( $trip_agency ); ?>
							<?php if ( isset( $trip['agencyRating'] ) && null !== $trip['agencyRating'] && ! empty( $trip['agencyReviewCount'] ) ) : ?>
								&middot; <span aria-label="<?php echo esc_attr( sprintf( /* translators: %s: rating */ __( 'Rated %s out of 5', 'anfac-media-safarkaabe' ), number_format_i18n( (float) $trip['agencyRating'], 1 ) ) ); ?>">★ <?php echo esc_html( number_format_i18n( (float) $trip['agencyRating'], 1 ) ); ?> (<?php echo (int) $trip['agencyReviewCount']; ?>)</span>
							<?php endif; ?>
						</p>
					<?php endif; ?>
					<div class="amsk-card__footer">
						<strong class="amsk-card__price"><?php echo esc_html( sprintf( /* translators: %s: price */ __( 'From %s', 'anfac-media-safarkaabe' ), amsk_money( $price ) ) ); ?></strong>
					</div>
					<a class="amsk-button amsk-button--wide" href="<?php echo esc_url( $app . '/?trip=' . rawurlencode( (string) $trip['id'] ) ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Book on SAFAR KAABE', 'anfac-media-safarkaabe' ); ?></a>
				</div>
			</article>
			<?php
			$cards[] = ob_get_clean();
			if ( count( $cards ) >= $limit ) {
				break;
			}
		}
		if ( ! $cards ) {
			return '<p class="amsk-empty">' . esc_html__( 'No trips are available right now. New trips are added often – check back soon.', 'anfac-media-safarkaabe' ) . '</p>';
		}
		$columns = max( 1, min( 4, (int) $atts['columns'] ) );
		return '<div class="amsk-grid amsk-grid--' . esc_attr( $columns ) . '">' . implode( '', $cards ) . '</div>';
	}

	public static function app_products( $atts ) {
		AMSK_Shortcodes::enqueue();
		$atts = shortcode_atts( array( 'limit' => 12, 'columns' => 3 ), $atts, 'safarkaabe_app_products' );
		$data = self::fetch( '/api/store/products', 'amsk_sk_products' );
		if ( ! is_array( $data ) || ! isset( $data['products'] ) || ! is_array( $data['products'] ) || ! $data['products'] ) {
			return ''; // Quietly hidden when the app shop is not available.
		}
		$app   = self::app_url();
		$cards = array();
		foreach ( array_slice( $data['products'], 0, max( 1, min( 60, (int) $atts['limit'] ) ) ) as $product ) {
			if ( ! is_array( $product ) || empty( $product['title'] ) ) {
				continue;
			}
			$cents = isset( $product['priceCents'] ) ? (int) $product['priceCents'] : ( isset( $product['price_cents'] ) ? (int) $product['price_cents'] : 0 );
			$image = self::absolute( isset( $product['imageUrl'] ) ? $product['imageUrl'] : '' );
			ob_start();
			?>
			<article class="amsk-card">
				<?php if ( $image ) : ?>
					<img class="amsk-card__image" src="<?php echo esc_url( $image ); ?>" alt="<?php echo esc_attr( $product['title'] ); ?>" loading="lazy" />
				<?php endif; ?>
				<div class="amsk-card__body">
					<h3 class="amsk-card__title"><?php echo esc_html( $product['title'] ); ?></h3>
					<?php if ( ! empty( $product['description'] ) ) : ?>
						<p class="amsk-card__text"><?php echo esc_html( wp_trim_words( (string) $product['description'], 24 ) ); ?></p>
					<?php endif; ?>
					<div class="amsk-card__footer"><strong class="amsk-card__price"><?php echo esc_html( amsk_money( $cents ) ); ?></strong></div>
					<a class="amsk-button amsk-button--wide" href="<?php echo esc_url( $app . '/' ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Order in the SAFAR KAABE app', 'anfac-media-safarkaabe' ); ?></a>
				</div>
			</article>
			<?php
			$cards[] = ob_get_clean();
		}
		$columns = max( 1, min( 4, (int) $atts['columns'] ) );
		return $cards ? '<div class="amsk-grid amsk-grid--' . esc_attr( $columns ) . '">' . implode( '', $cards ) . '</div>' : '';
	}
}
