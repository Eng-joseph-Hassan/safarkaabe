<?php
/**
 * Showcase on any page of the website: [safarkaabe_trips limit="6" category="FLIGHT"] and [safarkaabe_button].
 * Uses this website's own SAFAR KAABE data. Also adds "SAFAR KAABE" to the site menu when turned on.
 */

if ( ! defined( 'ABSPATH' ) || ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

function skw_showcase_css() {
	return '.skw-show{--m:#C909E6;--n:#0b0f1f;font-family:inherit;margin:24px 0}.skw-show *{box-sizing:border-box}'
		. '.skw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:18px}'
		. '.skw-card{display:flex;flex-direction:column;overflow:hidden;border-radius:20px;background:#fff;border:1px solid #e6e7ef;box-shadow:0 10px 30px -22px #0b0f1f;transition:.2s;text-decoration:none;color:#0f172a}'
		. '.skw-card:hover{transform:translateY(-4px);box-shadow:0 24px 40px -24px #0b0f1f}'
		. '.skw-img{position:relative;aspect-ratio:16/10;background:linear-gradient(135deg,#082dbf,#C909E6);overflow:hidden}.skw-img img{width:100%;height:100%;object-fit:cover;display:block}'
		. '.skw-tag{position:absolute;left:12px;top:12px;background:#0b0f1fcc;color:#fff;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:5px 10px;border-radius:999px}'
		. '.skw-left{position:absolute;right:12px;top:12px;background:#C909E6;color:#fff;font-size:11px;font-weight:800;padding:5px 10px;border-radius:999px}'
		. '.skw-body{display:flex;flex:1;flex-direction:column;gap:6px;padding:16px}.skw-route{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#64748b}'
		. '.skw-title{margin:0;font-size:17px;line-height:1.3;font-weight:800}.skw-meta{font-size:13px;color:#475569}'
		. '.skw-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto;padding-top:10px}.skw-price{font-size:20px;font-weight:900}.skw-price small{display:block;font-size:11px;font-weight:600;color:#64748b}'
		. '.skw-btn{display:inline-flex;align-items:center;gap:8px;background:#C909E6;color:#fff!important;text-decoration:none!important;font-weight:800;font-size:14px;padding:11px 18px;border-radius:999px;box-shadow:0 10px 22px -10px #C909E6;border:0;cursor:pointer}'
		. '.skw-btn:hover{background:#a000c4}.skw-empty{padding:30px;border-radius:20px;background:#f5f5f8;text-align:center;color:#475569}'
		. '.skw-hero{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px;padding:22px;border-radius:22px;color:#fff;background:linear-gradient(135deg,#0b0f1f,#1d2a6b 55%,#6b0480)}'
		. '.skw-hero b{display:block;font-size:22px}.skw-hero span{color:#d9daea}';
}

function skw_showcase_trips( $atts ) {
	$atts  = shortcode_atts( array( 'limit' => 6, 'category' => '', 'title' => '' ), $atts, 'safarkaabe_trips' );
	$args  = array( skw_today() );
	$where = "p.is_published = 1 AND p.available > 0 AND a.status = 'ACTIVE' AND a.is_approved = 1 AND (p.travel_date IS NULL OR p.travel_date >= ?)";
	$cat   = strtoupper( sanitize_key( $atts['category'] ) );
	if ( $cat ) {
		$where .= ' AND p.category = ?';
		$args[] = $cat;
	}
	$rows  = SKW_DB::get_results( "SELECT p.id, p.title, p.category, p.route_badge, p.travel_date, p.available, p.base_cents, p.tax_cents, p.image_updated_at, CASE WHEN p.image_data IS NULL THEN 0 ELSE 1 END AS has_image, a.name AS agency, a.markup_pct
		FROM {catalog_products} p JOIN {agencies} a ON a.id = p.agency_id WHERE $where ORDER BY CASE WHEN p.travel_date IS NULL THEN 1 ELSE 0 END, p.travel_date, p.title LIMIT " . max( 1, min( 48, (int) $atts['limit'] ) ), $args );
	$app   = skw_app_link( '' );
	$names = array( 'FLIGHT' => 'Flight', 'HOTEL' => 'Hotel', 'TOUR' => 'Tour', 'CAR' => 'Car', 'TRANSFER' => 'Transfer', 'PACKAGE' => 'Package' );
	$html  = '<style>' . skw_showcase_css() . '</style><div class="skw-show">';
	if ( $atts['title'] ) {
		$html .= '<div class="skw-hero"><div><b>' . esc_html( $atts['title'] ) . '</b><span>' . esc_html__( 'Book flights, hotels and tours with trusted travel agencies.', 'safarkaabe' ) . '</span></div><a class="skw-btn" href="' . esc_url( $app ) . '">' . esc_html__( 'Open SAFAR KAABE', 'safarkaabe' ) . ' &rarr;</a></div>';
	}
	if ( ! $rows ) {
		return $html . '<div class="skw-empty"><b>' . esc_html__( 'New trips are coming soon.', 'safarkaabe' ) . '</b><br>' . esc_html__( 'Travel agencies add flights, hotels and tours here. Check back soon.', 'safarkaabe' ) . '<br><br><a class="skw-btn" href="' . esc_url( $app ) . '">' . esc_html__( 'Open SAFAR KAABE', 'safarkaabe' ) . '</a></div></div>';
	}
	$html .= '<div class="skw-grid">';
	foreach ( $rows as $r ) {
		$base  = (int) $r['base_cents'];
		$total = $base + (int) $r['tax_cents'] + (int) round( $base * (float) $r['markup_pct'] / 100 ) + 1200;
		$img   = (int) $r['has_image'] ? skw_app_link( 'api/catalog/' . rawurlencode( $r['id'] ) . '/image?v=' . rawurlencode( (string) $r['image_updated_at'] ) ) : '';
		$seats = (int) $r['available'];
		$html .= '<a class="skw-card" href="' . esc_url( $app . '?trip=' . rawurlencode( $r['id'] ) ) . '">'
			. '<div class="skw-img">' . ( $img ? '<img loading="lazy" src="' . esc_url( $img ) . '" alt="' . esc_attr( $r['title'] ) . '">' : '' )
			. '<span class="skw-tag">' . esc_html( isset( $names[ $r['category'] ] ) ? $names[ $r['category'] ] : 'Trip' ) . '</span>'
			. ( $seats <= 5 ? '<span class="skw-left">' . esc_html( sprintf( _n( 'Only %d seat left', 'Only %d seats left', $seats, 'safarkaabe' ), $seats ) ) . '</span>' : '' ) . '</div>'
			. '<div class="skw-body"><div class="skw-route">' . esc_html( str_replace( '──', '—', (string) $r['route_badge'] ) ) . '</div><h3 class="skw-title">' . esc_html( $r['title'] ) . '</h3>'
			. '<div class="skw-meta">' . esc_html( $r['agency'] ) . ' · ' . esc_html( $r['travel_date'] ? wp_date( 'j M Y', strtotime( $r['travel_date'] . 'T12:00:00Z' ) ) : __( 'Flexible date', 'safarkaabe' ) ) . '</div>'
			. '<div class="skw-foot"><div class="skw-price"><small>' . esc_html__( 'From', 'safarkaabe' ) . '</small>$' . esc_html( number_format( $total / 100, 2 ) ) . '</div><span class="skw-btn">' . esc_html__( 'Book now', 'safarkaabe' ) . '</span></div></div></a>';
	}
	return $html . '</div></div>';
}

add_action( 'init', function () {
	// Registered late so it replaces older plugins' [safarkaabe_trips] that loaded trips from another server.
	add_shortcode( 'safarkaabe_trips', 'skw_showcase_trips' );
	add_shortcode( 'safarkaabe_button', function ( $atts ) {
		$atts = shortcode_atts( array( 'text' => __( 'Book your trip on SAFAR KAABE', 'safarkaabe' ) ), $atts, 'safarkaabe_button' );
		return '<style>' . skw_showcase_css() . '</style><a class="skw-btn" href="' . esc_url( skw_app_link( '' ) ) . '">' . esc_html( $atts['text'] ) . ' &rarr;</a>';
	} );
}, 99 );

/* Adds "SAFAR KAABE" to the main site menu when turned on in WordPress → SAFAR KAABE. */
add_filter( 'wp_nav_menu_items', function ( $items, $args ) {
	$settings = get_option( 'skw_settings', array() );
	if ( empty( $settings['menu_link'] ) || ( isset( $args->depth ) && 1 === (int) $args->depth ) ) {
		return $items;
	}
	static $added = false;
	if ( $added ) {
		return $items;
	}
	$added = true;
	return $items . '<li class="menu-item menu-item-safarkaabe"><a href="' . esc_url( skw_app_link( '' ) ) . '">' . esc_html__( 'SAFAR KAABE', 'safarkaabe' ) . '</a></li>';
}, 20, 2 );
