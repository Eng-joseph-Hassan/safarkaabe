<?php
/**
 * Trips (catalog), trip photos, travel agencies, portal summary, saved trips and waitlist.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

const SKW_CATEGORIES = array( 'HOTEL', 'CAR', 'TOUR', 'TRANSFER', 'FLIGHT', 'PACKAGE' );

/** Average rating and review count per agency. */
function skw_agency_ratings() {
	static $cache = null;
	if ( null === $cache ) {
		$cache = array();
		foreach ( SKW_DB::get_results( 'SELECT agency_id, AVG(rating) AS avg_rating, COUNT(*) AS n FROM {agency_reviews} GROUP BY agency_id' ) as $r ) {
			$cache[ $r['agency_id'] ] = array( round( (float) $r['avg_rating'], 1 ), (int) $r['n'] );
		}
	}
	return $cache;
}

function skw_product_public( $p, $markup ) {
	$ratings = skw_agency_ratings();
	$rating  = isset( $ratings[ $p['agency_id'] ] ) ? $ratings[ $p['agency_id'] ] : array( null, 0 );
	$base    = (int) $p['base_cents'];
	return array(
		'id'                     => $p['id'],
		'category'               => $p['category'],
		'titleEn'                => $p['title'],
		'titleSo'                => $p['title_so'],
		'destination'            => $p['destination'],
		'routeBadge'             => $p['route_badge'],
		'specs'                  => $p['specs'],
		'supplierName'           => $p['supplier_name'],
		'supplierRef'            => $p['supplier_ref'],
		'agencyId'               => $p['agency_id'],
		'baseUsdCents'           => $base,
		'taxUsdCents'            => (int) $p['tax_cents'],
		'supplierCommPct'        => (float) $p['supplier_commission_pct'],
		'available'              => (int) $p['available'],
		'travelDate'             => $p['travel_date'] ? $p['travel_date'] : null,
		'baggage'                => (string) $p['baggage'],
		'published'              => (int) $p['is_published'],
		'imageUrl'               => ! empty( $p['has_image'] ) ? skw_base() . 'api/catalog/' . $p['id'] . '/image?v=' . ( $p['image_updated_at'] ? $p['image_updated_at'] : '0' ) : null,
		'estimatedTotalUsdCents' => $base + (int) $p['tax_cents'] + (int) round( $base * (float) $markup / 100 ) + 1200,
		'agencyRating'           => $rating[1] ? $rating[0] : null,
		'agencyReviewCount'      => $rating[1],
	);
}

const SKW_PRODUCT_COLS = 'p.id, p.agency_id, p.title, p.title_so, p.category, p.destination, p.route_badge, p.specs, p.supplier_name, p.supplier_ref, p.base_cents, p.tax_cents, p.supplier_commission_pct, p.available, p.travel_date, p.baggage, p.is_published, p.image_updated_at, CASE WHEN p.image_data IS NULL THEN 0 ELSE 1 END AS has_image, a.markup_pct';

/** Published, bookable trips (what travelers and guests see). */
function skw_public_catalog_where() {
	return "p.is_published = 1 AND p.available > 0 AND a.status = 'ACTIVE' AND a.is_approved = 1 AND (p.travel_date IS NULL OR p.travel_date >= ?)";
}

SKW_Router::add( 'GET', '#^/api/catalog$#', function () {
	if ( function_exists( 'skw_bookings_sweep' ) ) {
		skw_bookings_sweep();
	}
	$user = skw_current_user();
	$sql  = 'SELECT ' . SKW_PRODUCT_COLS . ' FROM {catalog_products} p JOIN {agencies} a ON a.id = p.agency_id';
	if ( $user && 'AGENCY' === $user['role'] ) {
		$rows = SKW_DB::get_results( $sql . ' WHERE p.agency_id = ? ORDER BY p.title', array( $user['agency_id'] ) );
	} elseif ( $user && 'SUPER_ADMIN' === $user['role'] ) {
		$rows = SKW_DB::get_results( $sql . ' ORDER BY p.title' );
	} else {
		$rows = SKW_DB::get_results( $sql . ' WHERE ' . skw_public_catalog_where() . ' ORDER BY p.title', array( skw_today() ) );
	}
	$catalog = array();
	foreach ( $rows as $row ) {
		$catalog[] = skw_product_public( $row, $row['markup_pct'] );
	}
	return array( 'catalog' => $catalog );
} );

SKW_Router::add( 'GET', '#^/api/catalog/([0-9a-z-]+)/image$#i', function ( $p ) {
	$user  = skw_current_user();
	$image = SKW_DB::get_row(
		'SELECT p.agency_id, p.image_mime, p.image_data, p.is_published, p.available, p.travel_date, a.status, a.is_approved FROM {catalog_products} p JOIN {agencies} a ON a.id = p.agency_id WHERE p.id = ?',
		array( $p[0] )
	);
	$owner  = $user && 'AGENCY' === $user['role'] && $image && $image['agency_id'] === $user['agency_id'];
	$admin  = $user && 'SUPER_ADMIN' === $user['role'];
	$public = $image && 1 === (int) $image['is_published'] && (int) $image['available'] > 0 && 'ACTIVE' === $image['status'] && 1 === (int) $image['is_approved']
		&& ( ! $image['travel_date'] || $image['travel_date'] >= skw_today() );
	if ( ! $image || ! $image['image_data'] || ( ! $owner && ! $admin && ! $public ) ) {
		throw new SKW_Http_Error( 404, 'Listing image not found.' );
	}
	skw_send_raw( 200, $image['image_mime'], base64_decode( $image['image_data'] ), array( 'Cache-Control' => 'private, max-age=86400' ) );
} );

/** Reads and validates trip fields. $existing = current row when editing. */
function skw_read_product( $body, $existing = null ) {
	$get   = function ( $key, $default ) use ( $body ) {
		return array_key_exists( $key, $body ) ? $body[ $key ] : $default;
	};
	$title       = null === $existing || isset( $body['title'] ) ? skw_require_string( $get( 'title', null ), 'Product name' ) : $existing['title'];
	$destination = null === $existing || isset( $body['destination'] ) ? strtoupper( skw_require_string( $get( 'destination', null ), 'Destination', 12 ) ) : $existing['destination'];
	$category    = null === $existing || isset( $body['category'] ) ? skw_require_string( $get( 'category', null ), 'Category', 20 ) : $existing['category'];
	$old_origin  = $existing && preg_match( '/^([A-Z]{3})\s*(?:→|─)/u', $existing['route_badge'], $m ) ? $m[1] : '';
	$origin      = 'FLIGHT' === $category ? strtoupper( trim( (string) $get( 'origin', $old_origin ) ) ) : '';
	$price       = $get( 'price', $existing ? $existing['base_cents'] / 100 : null );
	$available   = $get( 'available', $existing ? (int) $existing['available'] : 1 );
	$travel_date = $get( 'travelDate', $existing ? $existing['travel_date'] : null );
	$travel_date = '' === $travel_date || null === $travel_date ? null : skw_require_string( $travel_date, 'Travel date', 10 );
	$baggage     = $get( 'baggage', $existing ? $existing['baggage'] : '' );
	$specs       = $get( 'specs', $existing ? $existing['specs'] : '' );
	$published   = $get( 'published', $existing ? (bool) (int) $existing['is_published'] : true );
	$valid = in_array( $category, SKW_CATEGORIES, true ) && ( 'FLIGHT' !== $category || preg_match( '/^[A-Z]{3}$/', $origin ) )
		&& is_numeric( $price ) && $price > 0 && $price <= 1000000
		&& null !== skw_int( $available ) && skw_int( $available ) >= 0 && skw_int( $available ) <= 100000
		&& is_string( $baggage ) && mb_strlen( $baggage ) <= 120 && is_string( $specs ) && is_bool( $published )
		&& ( ! $travel_date || skw_is_iso_date( $travel_date ) );
	if ( ! $valid ) {
		throw new SKW_Http_Error( 400, 'Choose an active agency and enter valid listing details, flight origin, price, availability and travel date.' );
	}
	$specs = trim( $specs ) ? mb_substr( trim( $specs ), 0, 500 ) : 'Agency managed inventory';
	return array(
		'title'       => $title,
		'title_so'    => $title,
		'category'    => $category,
		'destination' => $destination,
		'route_badge' => 'FLIGHT' === $category ? $origin . ' ── ✈ ── ' . $destination : $destination . ' • DIRECT',
		'specs'       => $specs,
		'base_cents'  => (int) round( $price * 100 ),
		'tax_cents'   => (int) round( $price * 12 ),
		'available'   => skw_int( $available ),
		'travel_date' => $travel_date,
		'baggage'     => trim( $baggage ),
		'is_published' => $published ? 1 : 0,
	);
}

SKW_Router::add( 'POST', '#^/api/catalog$#', function () {
	$user      = skw_mutation( array( 'SUPER_ADMIN', 'AGENCY' ) );
	$body      = skw_body( 400000 );
	$agency_id = 'AGENCY' === $user['role'] ? $user['agency_id'] : skw_require_string( isset( $body['agencyId'] ) ? $body['agencyId'] : null, 'Agency' );
	$agency    = SKW_DB::get_row( "SELECT id, name, markup_pct FROM {agencies} WHERE id = ? AND status = 'ACTIVE'", array( $agency_id ) );
	if ( ! $agency ) {
		throw new SKW_Http_Error( 400, 'Choose an active agency and enter valid listing details, flight origin, price, availability and travel date.' );
	}
	$fields = skw_read_product( $body );
	$image  = null;
	if ( isset( $body['imageData'] ) && null !== $body['imageData'] ) {
		$mime  = skw_require_string( isset( $body['imageMime'] ) ? $body['imageMime'] : null, 'Image type', 32 );
		$image = array( $mime, skw_validate_image( $body['imageData'], $mime ) );
	}
	$id  = skw_uuid();
	$ref = 'SUP-' . skw_code() . '-' . $fields['destination'];
	SKW_DB::insert( 'catalog_products', array_merge( $fields, array(
		'id' => $id, 'agency_id' => $agency_id, 'supplier_name' => $agency['name'], 'supplier_ref' => $ref, 'supplier_commission_pct' => 10,
		'image_mime' => $image ? $image[0] : null, 'image_data' => $image ? $image[1] : null, 'image_updated_at' => $image ? (string) round( microtime( true ) * 1000 ) : null,
		'created_at' => skw_now(),
	) ) );
	skw_audit( $user['id'], $fields['is_published'] ? 'AGENCY_PRODUCT_PUBLISHED' : 'AGENCY_PRODUCT_DRAFTED', $fields['title'] . ' (' . $ref . ')' );
	$row = SKW_DB::get_row( 'SELECT ' . SKW_PRODUCT_COLS . ' FROM {catalog_products} p JOIN {agencies} a ON a.id = p.agency_id WHERE p.id = ?', array( $id ) );
	$product              = skw_product_public( $row, $row['markup_pct'] );
	$product['published'] = (bool) $fields['is_published'];
	skw_json( 201, array( 'product' => $product ) );
} );

SKW_Router::add( '*', '#^/api/catalog/([0-9a-z-]+)$#i', function ( $p, $req ) {
	if ( ! in_array( $req['method'], array( 'PATCH', 'DELETE' ), true ) ) {
		throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
	}
	$user     = skw_mutation( array( 'SUPER_ADMIN', 'AGENCY' ) );
	$existing = SKW_DB::get_row( 'SELECT * FROM {catalog_products} WHERE id = ?', array( $p[0] ) );
	if ( ! $existing || ( 'AGENCY' === $user['role'] && $existing['agency_id'] !== $user['agency_id'] ) ) {
		throw new SKW_Http_Error( 404, 'Inventory listing not found.' );
	}
	if ( 'DELETE' === $req['method'] ) {
		SKW_DB::transaction( function () use ( $existing ) {
			SKW_DB::query( 'UPDATE {bookings} SET offer_id = NULL WHERE offer_id = ?', array( $existing['id'] ) );
			SKW_DB::query( 'DELETE FROM {saved_offers} WHERE offer_id = ?', array( $existing['id'] ) );
			SKW_DB::query( 'DELETE FROM {trip_waitlist} WHERE offer_id = ?', array( $existing['id'] ) );
			SKW_DB::query( 'DELETE FROM {catalog_products} WHERE id = ?', array( $existing['id'] ) );
		} );
		skw_audit( $user['id'], 'AGENCY_PRODUCT_REMOVED', $existing['title'] . ' (' . $existing['supplier_ref'] . ')' );
		return array( 'ok' => true );
	}
	$body   = skw_body( 400000 );
	$fields = skw_read_product( $body, $existing );
	if ( array_key_exists( 'imageData', $body ) ) {
		if ( null === $body['imageData'] ) {
			$fields['image_mime'] = null;
			$fields['image_data'] = null;
		} else {
			$mime                 = skw_require_string( isset( $body['imageMime'] ) ? $body['imageMime'] : null, 'Image type', 32 );
			$fields['image_mime'] = $mime;
			$fields['image_data'] = skw_validate_image( $body['imageData'], $mime );
		}
		$fields['image_updated_at'] = (string) round( microtime( true ) * 1000 );
	}
	SKW_DB::update( 'catalog_products', $fields, array( 'id' => $existing['id'] ) );
	skw_audit( $user['id'], $fields['is_published'] ? 'AGENCY_PRODUCT_UPDATED' : 'AGENCY_PRODUCT_UNPUBLISHED', $fields['title'] . ' (' . $existing['supplier_ref'] . ')' );
	if ( (int) $fields['available'] > (int) $existing['available'] && function_exists( 'skw_notify_waitlist' ) ) {
		skw_notify_waitlist( $existing['id'] );
	}
	return array( 'ok' => true );
} );

/* ---------- Agencies ---------- */

SKW_Router::add( 'GET', '#^/api/agencies/active$#', function () {
	$rows = SKW_DB::get_results( "SELECT a.id, a.name FROM {agencies} a WHERE a.status = 'ACTIVE' AND a.is_approved = 1 ORDER BY a.name, a.id" );
	$user = skw_current_user();
	foreach ( $rows as &$row ) {
		$email = SKW_DB::get_var( "SELECT email FROM {users} WHERE agency_id = ? AND role = 'AGENCY' ORDER BY created_at, email LIMIT 1", array( $row['id'] ) );
		if ( $email && $user ) {
			$row['contactEmail'] = $email;
		}
	}
	return array( 'agencies' => $rows );
} );

SKW_Router::add( 'POST', '#^/api/agencies$#', function () {
	$user     = skw_mutation( array( 'SUPER_ADMIN' ) );
	$body     = skw_body();
	$name     = skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Agency name' );
	$tier     = skw_require_string( isset( $body['tier'] ) ? $body['tier'] : null, 'Plan' );
	$markup   = isset( $body['markupPct'] ) && is_numeric( $body['markupPct'] ) ? (float) $body['markupPct'] : -1;
	$owner    = skw_require_string( isset( $body['ownerName'] ) ? $body['ownerName'] : null, 'Agency owner name' );
	$email    = skw_normalize_email( isset( $body['ownerEmail'] ) ? $body['ownerEmail'] : null );
	$password = skw_validate_password( isset( $body['ownerPassword'] ) ? $body['ownerPassword'] : null );
	if ( ! in_array( $tier, array( 'BASIC', 'PROFESSIONAL', 'ENTERPRISE' ), true ) || $markup < 0 || $markup > 100 ) {
		throw new SKW_Http_Error( 400, 'Choose a valid plan and markup from 0 to 100%.' );
	}
	if ( SKW_DB::get_var( 'SELECT 1 FROM {users} WHERE email = ?', array( $email ) ) ) {
		throw new SKW_Http_Error( 409, 'An account with the agency owner email already exists.' );
	}
	$id       = skw_uuid();
	$owner_id = skw_uuid();
	SKW_DB::transaction( function () use ( $id, $owner_id, $name, $tier, $markup, $owner, $email, $password, $user ) {
		SKW_DB::insert( 'agencies', array( 'id' => $id, 'name' => $name, 'tier' => $tier, 'markup_pct' => $markup, 'status' => 'SUSPENDED', 'is_approved' => 0, 'created_at' => skw_now() ) );
		SKW_DB::insert( 'users', array( 'id' => $owner_id, 'email' => $email, 'name' => $owner, 'phone' => '', 'password_hash' => skw_hash_password( $password ), 'role' => 'AGENCY', 'agency_id' => $id, 'created_at' => skw_now() ) );
		skw_audit( $user['id'], 'AGENCY_REGISTERED', $name . ' (' . $email . ')' );
	} );
	skw_json( 201, array(
		'agency' => array( 'id' => $id, 'name' => $name, 'tier' => $tier, 'markupPct' => $markup, 'status' => 'PENDING' ),
		'owner'  => array( 'id' => $owner_id, 'name' => $owner, 'email' => $email, 'role' => 'AGENCY' ),
	) );
} );

SKW_Router::add( 'PATCH', '#^/api/agencies/([0-9a-z-]+)/status$#i', function ( $p ) {
	$user   = skw_mutation( array( 'SUPER_ADMIN' ) );
	$body   = skw_body();
	$action = isset( $body['action'] ) ? $body['action'] : '';
	if ( ! in_array( $action, array( 'APPROVE', 'SUSPEND', 'ACTIVATE' ), true ) ) {
		throw new SKW_Http_Error( 400, 'Choose approve, suspend, or activate.' );
	}
	$agency = SKW_DB::get_row( 'SELECT id, name, status, is_approved FROM {agencies} WHERE id = ?', array( $p[0] ) );
	if ( ! $agency ) {
		throw new SKW_Http_Error( 404, 'Agency not found.' );
	}
	$approved = (int) $agency['is_approved'];
	if ( 'APPROVE' === $action && 0 === $approved ) {
		$status   = 'ACTIVE';
		$approved = 1;
	} elseif ( 'SUSPEND' === $action && 1 === $approved && 'ACTIVE' === $agency['status'] ) {
		$status = 'SUSPENDED';
	} elseif ( 'ACTIVATE' === $action && 1 === $approved && 'SUSPENDED' === $agency['status'] ) {
		$status = 'ACTIVE';
	} else {
		throw new SKW_Http_Error( 409, 'That agency status action is not valid for its current state.' );
	}
	SKW_DB::transaction( function () use ( $agency, $status, $approved, $user, $action ) {
		SKW_DB::update( 'agencies', array( 'status' => $status, 'is_approved' => $approved ), array( 'id' => $agency['id'] ) );
		if ( 'SUSPENDED' === $status ) {
			SKW_DB::query( "DELETE FROM {sessions} WHERE user_id IN (SELECT id FROM {users} WHERE agency_id = ? AND role = 'AGENCY')", array( $agency['id'] ) );
		}
		skw_audit( $user['id'], 'AGENCY_' . $action, $agency['name'] . ' (' . $agency['id'] . ')' );
	} );
	return array( 'agency' => array( 'id' => $agency['id'], 'name' => $agency['name'], 'status' => $status ) );
} );

SKW_Router::add( '*', '#^/api/agencies/([0-9a-z-]+)$#i', function ( $p, $req ) {
	$user   = skw_mutation( array( 'SUPER_ADMIN' ) );
	$agency = SKW_DB::get_row( 'SELECT id, name FROM {agencies} WHERE id = ?', array( $p[0] ) );
	if ( ! $agency ) {
		throw new SKW_Http_Error( 404, 'Agency not found.' );
	}
	if ( 'PATCH' === $req['method'] ) {
		$body   = skw_body();
		$name   = skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Agency name' );
		$tier   = skw_require_string( isset( $body['tier'] ) ? $body['tier'] : null, 'Plan' );
		$markup = isset( $body['markupPct'] ) && is_numeric( $body['markupPct'] ) ? (float) $body['markupPct'] : -1;
		if ( ! in_array( $tier, array( 'BASIC', 'PROFESSIONAL', 'ENTERPRISE' ), true ) || $markup < 0 || $markup > 100 ) {
			throw new SKW_Http_Error( 400, 'Choose a valid plan and markup from 0 to 100%.' );
		}
		SKW_DB::update( 'agencies', array( 'name' => $name, 'tier' => $tier, 'markup_pct' => $markup ), array( 'id' => $agency['id'] ) );
		skw_audit( $user['id'], 'AGENCY_UPDATED', $agency['name'] . ' -> ' . $name . ' (' . $agency['id'] . ')' );
		return array( 'agency' => array( 'id' => $agency['id'], 'name' => $name, 'tier' => $tier, 'markupPct' => $markup ) );
	}
	if ( 'DELETE' !== $req['method'] ) {
		throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
	}
	if ( (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {bookings} WHERE agency_id = ?', array( $agency['id'] ) ) || (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {catalog_products} WHERE agency_id = ?', array( $agency['id'] ) ) ) {
		throw new SKW_Http_Error( 409, 'This agency has bookings or travel listings. Remove its listings and retain booking history before deleting it.' );
	}
	SKW_DB::transaction( function () use ( $agency, $user ) {
		skw_audit( $user['id'], 'AGENCY_DELETED', $agency['name'] . ' (' . $agency['id'] . ')' );
		SKW_DB::query( 'DELETE FROM {conversations} WHERE agency_id = ?', array( $agency['id'] ) );
		SKW_DB::query( 'DELETE FROM {sessions} WHERE user_id IN (SELECT id FROM {users} WHERE agency_id = ?)', array( $agency['id'] ) );
		SKW_DB::query( 'DELETE FROM {users} WHERE agency_id = ?', array( $agency['id'] ) );
		SKW_DB::query( 'DELETE FROM {agency_clients} WHERE agency_id = ?', array( $agency['id'] ) );
		SKW_DB::query( 'DELETE FROM {agencies} WHERE id = ?', array( $agency['id'] ) );
	} );
	return array( 'deleted' => true, 'agencyId' => $agency['id'] );
} );

/* ---------- Portal summary (dashboards) ---------- */

SKW_Router::add( 'GET', '#^/api/portal/summary$#', function () {
	$user = skw_require_role();
	if ( 'SUPER_ADMIN' === $user['role'] ) {
		$agencies = SKW_DB::get_results( "SELECT id, name, tier, markup_pct AS markupPct, CASE WHEN is_approved = 0 THEN 'PENDING' ELSE status END AS status, logo_mime AS logoMime, logo_data AS logoData, created_at AS createdAt FROM {agencies} ORDER BY name" );
		foreach ( $agencies as &$a ) {
			$a['markupPct']   = (float) $a['markupPct'];
			$a['staffCount']  = (int) SKW_DB::get_var( "SELECT COUNT(*) FROM {users} WHERE agency_id = ? AND role = 'AGENCY'", array( $a['id'] ) );
			$a['clientCount'] = (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {agency_clients} WHERE agency_id = ?', array( $a['id'] ) );
		}
		unset( $a );
		$customers = SKW_DB::get_results( "SELECT id, name, email, phone, avatar_mime AS avatarMime, avatar_data AS avatarData, created_at AS createdAt FROM {users} WHERE role = 'CLIENT' ORDER BY created_at DESC" );
		$staff     = SKW_DB::get_results( "SELECT u.id, u.name, u.email, u.role, u.avatar_mime AS avatarMime, u.avatar_data AS avatarData, u.agency_id AS agencyId, a.name AS agencyName, u.created_at AS createdAt FROM {users} u JOIN {agencies} a ON a.id = u.agency_id WHERE u.role = 'AGENCY' ORDER BY u.created_at DESC" );
		$logs      = SKW_DB::get_results( 'SELECT l.action, l.target, l.created_at AS time, u.email AS actor FROM {audit_logs} l LEFT JOIN {users} u ON u.id = l.actor_id ORDER BY l.created_at DESC LIMIT 100' );
		return array( 'user' => skw_public_user( $user ), 'agencies' => $agencies, 'customers' => $customers, 'agencyStaff' => $staff, 'auditLogs' => $logs );
	}
	if ( 'AGENCY' === $user['role'] ) {
		$agency = SKW_DB::get_row( 'SELECT id, name, tier, markup_pct AS markupPct, status, logo_mime AS logoMime, logo_data AS logoData FROM {agencies} WHERE id = ?', array( $user['agency_id'] ) );
		if ( ! $agency ) {
			throw new SKW_Http_Error( 403, 'Your agency account is no longer active.' );
		}
		$agency['markupPct'] = (float) $agency['markupPct'];
		$staff   = SKW_DB::get_results( "SELECT id, name, email, role, avatar_mime AS avatarMime, avatar_data AS avatarData, created_at AS createdAt FROM {users} WHERE agency_id = ? AND role = 'AGENCY' ORDER BY created_at", array( $user['agency_id'] ) );
		$clients = SKW_DB::get_results( 'SELECT id, name, phone, email, created_at AS createdAt FROM {agency_clients} WHERE agency_id = ? ORDER BY created_at DESC', array( $user['agency_id'] ) );
		return array( 'user' => skw_public_user( $user ), 'agency' => $agency, 'staff' => $staff, 'clients' => $clients );
	}
	return array( 'user' => skw_public_user( $user ), 'customer' => array( 'id' => $user['id'], 'name' => $user['name'], 'email' => $user['email'], 'phone' => $user['phone'] ) );
} );

/* ---------- Saved trips and waitlist ---------- */

SKW_Router::add( 'GET', '#^/api/saved-offers$#', function () {
	$user = skw_require_role( array( 'CLIENT' ) );
	$rows = SKW_DB::get_results(
		'SELECT s.offer_id, s.created_at AS saved_at, ' . SKW_PRODUCT_COLS . ', a.name AS agency_name, a.status AS agency_status, a.is_approved AS agency_ok FROM {saved_offers} s JOIN {catalog_products} p ON p.id = s.offer_id JOIN {agencies} a ON a.id = p.agency_id WHERE s.user_id = ? ORDER BY s.created_at DESC',
		array( $user['id'] )
	);
	$waiting = array_column( SKW_DB::get_results( 'SELECT offer_id FROM {trip_waitlist} WHERE user_id = ?', array( $user['id'] ) ), 'offer_id' );
	$out     = array();
	foreach ( $rows as $r ) {
		$live     = 1 === (int) $r['is_published'] && 'ACTIVE' === $r['agency_status'] && 1 === (int) $r['agency_ok'] && ( ! $r['travel_date'] || $r['travel_date'] >= skw_today() );
		$bookable = $live && (int) $r['available'] > 0;
		if ( $bookable ) {
			$item = array_merge( skw_product_public( $r, $r['markup_pct'] ), array( 'offerId' => $r['offer_id'], 'savedAt' => $r['saved_at'], 'agencyName' => $r['agency_name'], 'bookable' => true ) );
		} else {
			$item = array( 'offerId' => $r['offer_id'], 'savedAt' => $r['saved_at'], 'id' => $r['id'], 'titleEn' => $r['title'], 'titleSo' => $r['title_so'], 'agencyId' => $r['agency_id'], 'agencyName' => $r['agency_name'], 'bookable' => false, 'soldOut' => $live && (int) $r['available'] <= 0 );
			if ( $item['soldOut'] ) {
				$item['travelDate'] = $r['travel_date'];
			}
		}
		$item['waitlisted'] = in_array( $r['id'], $waiting, true );
		$out[]              = $item;
	}
	return array( 'savedOffers' => $out );
} );

SKW_Router::add( '*', '#^/api/saved-offers/([0-9a-z_-]+)$#i', function ( $p, $req ) {
	$user = skw_mutation( array( 'CLIENT' ) );
	if ( 'DELETE' === $req['method'] ) {
		$removed = SKW_DB::query( 'DELETE FROM {saved_offers} WHERE user_id = ? AND offer_id = ?', array( $user['id'], $p[0] ) );
		return array( 'ok' => true, 'saved' => false, 'removed' => 1 === $removed );
	}
	if ( 'PUT' !== $req['method'] ) {
		throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
	}
	$offer = SKW_DB::get_var( 'SELECT p.id FROM {catalog_products} p JOIN {agencies} a ON a.id = p.agency_id WHERE p.id = ? AND ' . skw_public_catalog_where(), array( $p[0], skw_today() ) );
	if ( ! $offer ) {
		throw new SKW_Http_Error( 404, 'This trip is no longer available to save.' );
	}
	$already = SKW_DB::get_var( 'SELECT 1 FROM {saved_offers} WHERE user_id = ? AND offer_id = ?', array( $user['id'], $offer ) );
	if ( ! $already && (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {saved_offers} WHERE user_id = ?', array( $user['id'] ) ) >= 200 ) {
		throw new SKW_Http_Error( 409, 'You can save up to 200 trips. Remove some saved trips first.' );
	}
	if ( ! $already ) {
		SKW_DB::insert( 'saved_offers', array( 'user_id' => $user['id'], 'offer_id' => $offer, 'created_at' => skw_now() ) );
	}
	return array( 'ok' => true, 'saved' => true );
} );

SKW_Router::add( 'GET', '#^/api/waitlist$#', function () {
	$user = skw_require_role( array( 'CLIENT' ) );
	$rows = SKW_DB::get_results( 'SELECT w.offer_id AS offerId, w.seat_count AS seatCount, w.created_at AS joinedAt, w.notified_at AS notifiedAt, p.title, p.travel_date AS travelDate, p.available, a.name AS agencyName FROM {trip_waitlist} w JOIN {catalog_products} p ON p.id = w.offer_id JOIN {agencies} a ON a.id = p.agency_id WHERE w.user_id = ? ORDER BY w.created_at DESC', array( $user['id'] ) );
	foreach ( $rows as &$r ) {
		$r['seatCount'] = (int) $r['seatCount'];
		$r['available'] = (int) $r['available'];
	}
	return array( 'waitlist' => $rows );
} );

SKW_Router::add( '*', '#^/api/offers/([0-9a-z_-]+)/waitlist$#i', function ( $p, $req ) {
	$user = skw_mutation( array( 'CLIENT' ) );
	if ( 'DELETE' === $req['method'] ) {
		SKW_DB::query( 'DELETE FROM {trip_waitlist} WHERE offer_id = ? AND user_id = ?', array( $p[0], $user['id'] ) );
		return array( 'ok' => true, 'waitlisted' => false, 'message' => 'You left the waitlist for this trip.' );
	}
	$body  = skw_body();
	$seats = isset( $body['seatCount'] ) ? skw_int( $body['seatCount'] ) : 1;
	if ( null === $seats || $seats < 1 || $seats > 50 ) {
		throw new SKW_Http_Error( 400, 'Choose between 1 and 50 seats.' );
	}
	$offer = SKW_DB::get_row( "SELECT p.id, p.title, p.available FROM {catalog_products} p JOIN {agencies} a ON a.id = p.agency_id WHERE p.id = ? AND p.is_published = 1 AND a.status = 'ACTIVE' AND a.is_approved = 1 AND (p.travel_date IS NULL OR p.travel_date >= ?)", array( $p[0], skw_today() ) );
	if ( ! $offer ) {
		throw new SKW_Http_Error( 404, 'This trip is no longer offered, so you cannot join its waitlist.' );
	}
	if ( (int) $offer['available'] >= $seats ) {
		throw new SKW_Http_Error( 409, $offer['available'] . ( 1 === (int) $offer['available'] ? ' seat is' : ' seats are' ) . ' available now. Book the trip instead of joining the waitlist.', array( 'available' => (int) $offer['available'] ) );
	}
	SKW_DB::upsert( 'trip_waitlist', array( 'offer_id' => $offer['id'], 'user_id' => $user['id'], 'seat_count' => $seats, 'created_at' => skw_now(), 'notified_at' => null ), array( 'offer_id', 'user_id' ) );
	return array( 'ok' => true, 'waitlisted' => true, 'message' => 'You are on the waitlist for ' . $offer['title'] . '. We will notify you when ' . ( 1 === $seats ? 'a seat opens' : $seats . ' seats open' ) . '.' );
} );

/** Tells waitlisted travelers that seats opened on a trip. */
function skw_notify_waitlist( $offer_id ) {
	$offer = SKW_DB::get_row( 'SELECT id, title, available, agency_id, travel_date FROM {catalog_products} WHERE id = ? AND is_published = 1', array( $offer_id ) );
	if ( ! $offer ) {
		return;
	}
	$rows = SKW_DB::get_results( 'SELECT user_id, seat_count, created_at FROM {trip_waitlist} WHERE offer_id = ? AND notified_at IS NULL AND seat_count <= ?', array( $offer_id, (int) $offer['available'] ) );
	foreach ( $rows as $w ) {
		if ( 1 !== SKW_DB::query( 'UPDATE {trip_waitlist} SET notified_at = ? WHERE offer_id = ? AND user_id = ? AND notified_at IS NULL', array( skw_now(), $offer_id, $w['user_id'] ) ) ) {
			continue;
		}
		$seats = (int) $offer['available'];
		skw_notify( array( array(
			'recipientUserId' => $w['user_id'], 'agencyId' => $offer['agency_id'], 'type' => 'WAITLIST_SEATS_OPEN',
			'title' => 'Seats are available again',
			'body' => $offer['title'] . ( $offer['travel_date'] ? ' (' . $offer['travel_date'] . ')' : '' ) . ' has ' . $seats . ( 1 === $seats ? ' seat' : ' seats' ) . ' free now. Book soon – seats go to whoever books first.',
			'href' => skw_app_link( '?trip=' . rawurlencode( $offer_id ) ), 'dedupeKey' => 'WAITLIST_SEATS_OPEN:' . $offer_id . ':' . $w['user_id'] . ':' . $w['created_at'],
		) ) );
	}
}
