<?php
/**
 * Bookings: create (seat hold), lists, agency actions, cancel, refunds, reviews, agency clients and staff.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

const SKW_BOOKING_SELECT = "SELECT b.*, a.name AS agency_name, a.logo_mime AS agency_logo_mime, a.logo_data AS agency_logo_data,
	c.route_badge, c.destination, c.supplier_name, c.supplier_ref, c.baggage, c.specs,
	r.id AS review_id, r.rating AS review_rating, r.comment AS review_comment, r.agency_reply AS review_reply, r.agency_reply_at AS review_reply_at, r.updated_at AS review_updated_at,
	pp.status AS pp_status, pp.provider AS pp_provider, pp.account_number AS pp_account, pp.amount_cents AS pp_amount, pp.transaction_id AS pp_txn, pp.error_message AS pp_message, pp.started_at AS pp_started
	FROM {bookings} b
	JOIN {agencies} a ON a.id = b.agency_id
	LEFT JOIN {catalog_products} c ON c.id = b.offer_id
	LEFT JOIN {agency_reviews} r ON r.booking_id = b.id
	LEFT JOIN {phone_payments} pp ON pp.booking_id = b.id";

function skw_can_review( $b ) {
	return 'ACCEPTED' === $b['state'] && ( ! $b['travel_date'] || $b['travel_date'] <= skw_today() );
}

function skw_booking_view( $b, $user = null ) {
	static $contacts = array();
	if ( ! isset( $contacts[ $b['agency_id'] ] ) ) {
		$contacts[ $b['agency_id'] ] = SKW_DB::get_row( "SELECT email, phone FROM {users} WHERE agency_id = ? AND role = 'AGENCY' ORDER BY created_at LIMIT 1", array( $b['agency_id'] ) );
	}
	$contact = $contacts[ $b['agency_id'] ];
	$fin     = json_decode( (string) $b['financials_json'], true );
	return array(
		'id' => $b['id'], 'ref' => $b['reference'], 'pnr' => $b['pnr'], 'agencyId' => $b['agency_id'], 'offerId' => $b['offer_id'],
		'cancellationReason' => $b['cancellation_reason'], 'customerId' => $b['customer_id'], 'travelerName' => $b['traveler_name'],
		'travelerEmail' => $b['traveler_email'], 'phone' => $b['phone'], 'offerTitle' => $b['offer_title'], 'category' => $b['category'],
		'paymentProvider' => $b['payment_provider'], 'state' => $b['state'], 'seatCount' => (int) $b['seat_count'], 'travelDate' => $b['travel_date'],
		'createdAtUtc' => $b['created_at'], 'updatedAtUtc' => $b['updated_at'],
		'refundStatus' => $b['refund_status'], 'refundReference' => $b['refund_reference'], 'refundNote' => $b['refund_note'], 'refundedAt' => $b['refunded_at'],
		'paymentStatus' => null, 'paymentTransactionId' => null, 'paymentReference' => null,
		'phonePaymentStatus' => isset( $b['pp_status'] ) ? $b['pp_status'] : null, 'phonePaymentProvider' => isset( $b['pp_provider'] ) ? $b['pp_provider'] : null,
		'phonePaymentAccount' => isset( $b['pp_account'] ) ? $b['pp_account'] : null, 'phonePaymentAmountCents' => isset( $b['pp_amount'] ) ? (int) $b['pp_amount'] : null,
		'phonePaymentTransactionId' => isset( $b['pp_txn'] ) ? $b['pp_txn'] : null, 'phonePaymentMessage' => isset( $b['pp_message'] ) ? $b['pp_message'] : null,
		'phonePaymentStartedAt' => isset( $b['pp_started'] ) ? $b['pp_started'] : null, 'phonePaymentVerified' => ! empty( $b['pp_txn'] ) && 'APPROVED' === ( isset( $b['pp_status'] ) ? $b['pp_status'] : '' ) ? 1 : 0,
		'agencyName' => isset( $b['agency_name'] ) ? $b['agency_name'] : null, 'agencyLogoMime' => isset( $b['agency_logo_mime'] ) ? $b['agency_logo_mime'] : null,
		'agencyLogoData' => isset( $b['agency_logo_data'] ) ? $b['agency_logo_data'] : null,
		'agencyEmail' => $contact ? $contact['email'] : null, 'agencyPhone' => $contact ? $contact['phone'] : null,
		'routeBadge' => isset( $b['route_badge'] ) ? $b['route_badge'] : null, 'destination' => isset( $b['destination'] ) ? $b['destination'] : null,
		'supplierName' => isset( $b['supplier_name'] ) ? $b['supplier_name'] : null, 'supplierRef' => isset( $b['supplier_ref'] ) ? $b['supplier_ref'] : null,
		'baggage' => isset( $b['baggage'] ) ? $b['baggage'] : null, 'specs' => isset( $b['specs'] ) ? $b['specs'] : null,
		'ticketDocumentId' => null, 'ticketDocumentReference' => null, 'ticketDocumentVersion' => null, 'ticketDocumentType' => null, 'ticketStatus' => null,
		'ticketFileName' => null, 'ticketJpgFileName' => null, 'ticketIssuedAt' => null, 'ticketRetryAvailable' => 0, 'ticketEmailStatus' => null, 'ticketEmailSentAt' => null,
		'reviewId' => isset( $b['review_id'] ) ? $b['review_id'] : null, 'reviewRating' => isset( $b['review_rating'] ) && null !== $b['review_rating'] ? (int) $b['review_rating'] : null,
		'reviewComment' => isset( $b['review_comment'] ) ? $b['review_comment'] : null, 'reviewReply' => isset( $b['review_reply'] ) ? $b['review_reply'] : null,
		'reviewReplyAt' => isset( $b['review_reply_at'] ) ? $b['review_reply_at'] : null, 'reviewUpdatedAt' => isset( $b['review_updated_at'] ) ? $b['review_updated_at'] : null,
		'reviewEligible' => $user && 'CLIENT' === $user['role'] && $b['customer_id'] === $user['id'] && skw_can_review( $b ),
		'financials' => is_array( $fin ) ? $fin : new stdClass(),
	);
}

function skw_load_booking( $id ) {
	return SKW_DB::get_row( SKW_BOOKING_SELECT . ' WHERE b.id = ?', array( $id ) );
}

/** Booking the user may act on, or 404. */
function skw_owned_booking( $id, $user ) {
	$b = skw_load_booking( $id );
	if ( ! $b || ( 'AGENCY' === $user['role'] && $b['agency_id'] !== $user['agency_id'] ) || ( 'CLIENT' === $user['role'] && $b['customer_id'] !== $user['id'] ) ) {
		throw new SKW_Http_Error( 404, 'Booking request not found.' );
	}
	return $b;
}

function skw_return_seats( $offer_id, $agency_id, $seats ) {
	if ( $offer_id ) {
		SKW_DB::query( 'UPDATE {catalog_products} SET available = available + ? WHERE id = ? AND agency_id = ?', array( (int) $seats, $offer_id, $agency_id ) );
	}
}

/** Releases unpaid phone-payment holds after 2 hours (never while a charge may still be running). */
function skw_bookings_sweep() {
	static $ran = false;
	if ( $ran ) {
		return;
	}
	$ran    = true;
	$cutoff = gmdate( 'Y-m-d\TH:i:s', time() - 7200 );
	$stale  = SKW_DB::get_results( "SELECT b.id, b.offer_id, b.agency_id, b.seat_count, b.customer_id, b.reference, b.offer_title FROM {bookings} b LEFT JOIN {phone_payments} pp ON pp.booking_id = b.id
		WHERE b.state = 'PAYMENT_PENDING' AND b.created_at < ? AND (pp.id IS NULL OR (pp.status = 'PENDING' AND pp.started_at IS NULL))", array( $cutoff ) );
	foreach ( $stale as $b ) {
		$done = SKW_DB::transaction( function () use ( $b ) {
			$n = SKW_DB::query( "UPDATE {bookings} SET state = 'CANCELLED', cancellation_reason = ?, updated_at = ? WHERE id = ? AND state = 'PAYMENT_PENDING'", array( 'Payment was not completed within 2 hours', skw_now(), $b['id'] ) );
			if ( 1 === $n ) {
				skw_return_seats( $b['offer_id'], $b['agency_id'], $b['seat_count'] );
			}
			return 1 === $n;
		} );
		if ( $done ) {
			skw_notify( array( array(
				'recipientUserId' => $b['customer_id'], 'agencyId' => $b['agency_id'], 'bookingId' => $b['id'], 'type' => 'BOOKING_CANCELLED',
				'title' => 'Booking request cancelled', 'body' => 'Your booking ' . $b['reference'] . ' (' . $b['offer_title'] . ') was cancelled because the payment was not completed within 2 hours. No payment was taken. You can book again.',
				'href' => skw_app_link( '?booking=' . rawurlencode( $b['id'] ) ), 'dedupeKey' => 'BOOKING_CANCELLED:' . $b['id'] . ':' . $b['customer_id'],
			) ) );
			if ( function_exists( 'skw_notify_waitlist' ) && $b['offer_id'] ) {
				skw_notify_waitlist( $b['offer_id'] );
			}
		}
	}
	skw_trip_reminders();
}

/** Reminders the day before and the morning of departure (sent once each). */
function skw_trip_reminders() {
	$today    = skw_today();
	$tomorrow = skw_today( 1 );
	$trips    = SKW_DB::get_results( "SELECT b.id, b.reference, b.customer_id, b.agency_id, b.offer_title, b.travel_date, b.seat_count, a.name AS agency_name FROM {bookings} b JOIN {agencies} a ON a.id = b.agency_id
		WHERE b.state = 'ACCEPTED' AND b.customer_id IS NOT NULL AND b.travel_date IN (?, ?)", array( $today, $tomorrow ) );
	foreach ( $trips as $t ) {
		$when = $t['travel_date'] === $today ? 'today' : 'tomorrow';
		skw_notify( array( array(
			'recipientUserId' => $t['customer_id'], 'agencyId' => $t['agency_id'], 'bookingId' => $t['id'], 'type' => 'TRIP_REMINDER',
			'title' => 'today' === $when ? 'Your trip is today' : 'Your trip is tomorrow',
			'body' => $t['offer_title'] . ' with ' . $t['agency_name'] . ' is ' . $when . ' (' . $t['travel_date'] . '). Booking ' . $t['reference'] . ', ' . $t['seat_count'] . ( 1 === (int) $t['seat_count'] ? ' seat' : ' seats' ) . '. Bring your ID or passport and your booking confirmation.',
			'href' => skw_app_link( '?booking=' . rawurlencode( $t['id'] ) ), 'dedupeKey' => 'TRIP_REMINDER:' . $t['id'] . ':' . $t['travel_date'] . ':' . $when,
		) ) );
	}
}

SKW_Router::add( 'GET', '#^/api/bookings$#', function () {
	$user = skw_require_role();
	if ( 'SUPER_ADMIN' === $user['role'] ) {
		$rows = SKW_DB::get_results( SKW_BOOKING_SELECT . ' ORDER BY b.created_at DESC' );
	} elseif ( 'AGENCY' === $user['role'] ) {
		$rows = SKW_DB::get_results( SKW_BOOKING_SELECT . ' WHERE b.agency_id = ? ORDER BY b.created_at DESC', array( $user['agency_id'] ) );
	} else {
		$rows = SKW_DB::get_results( SKW_BOOKING_SELECT . ' WHERE b.customer_id = ? ORDER BY b.created_at DESC', array( $user['id'] ) );
	}
	$out = array();
	foreach ( $rows as $row ) {
		$out[] = skw_booking_view( $row, $user );
	}
	return array( 'bookings' => $out );
} );

SKW_Router::add( 'POST', '#^/api/bookings$#', function ( $p, $req ) {
	$user = skw_current_user();
	if ( $user ) {
		skw_require_csrf();
	} else {
		$origin = isset( $req['headers']['origin'] ) ? $req['headers']['origin'] : '';
		if ( ! $origin || ( $origin !== 'http://' . $req['host'] && $origin !== 'https://' . $req['host'] ) ) {
			throw new SKW_Http_Error( 403, 'A same-origin request is required to submit a guest booking.' );
		}
		if ( ! skw_rate_limit( 'guest-booking:' . $req['ip'], 5, 900 ) ) {
			throw new SKW_Http_Error( 429, 'Too many booking requests. Please wait 15 minutes before trying again.' );
		}
	}
	$body     = skw_body();
	$customer = null;
	if ( $user && 'SUPER_ADMIN' === $user['role'] ) {
		$customer = SKW_DB::get_row( "SELECT id, name, email, phone FROM {users} WHERE id = ? AND role = 'CLIENT'", array( skw_require_string( isset( $body['customerId'] ) ? $body['customerId'] : null, 'Traveler' ) ) );
		if ( ! $customer ) {
			throw new SKW_Http_Error( 404, 'Choose an existing traveler account for this booking.' );
		}
	}
	$offer_id = skw_require_string( isset( $body['offerId'] ) ? $body['offerId'] : null, 'Travel offer', 80 );
	$seats    = isset( $body['seatCount'] ) ? skw_int( $body['seatCount'] ) : 1;
	if ( null === $seats || $seats < 1 || $seats > 100000 ) {
		throw new SKW_Http_Error( 400, 'Enter a number of seats from 1 to 100,000.' );
	}
	$offer = SKW_DB::get_row( "SELECT p.*, a.markup_pct FROM {catalog_products} p JOIN {agencies} a ON a.id = p.agency_id WHERE p.id = ? AND a.status = 'ACTIVE' AND a.is_approved = 1 AND p.is_published = 1 AND (p.travel_date IS NULL OR p.travel_date >= ?)", array( $offer_id, skw_today() ) );
	if ( ! $offer || ( $user && 'AGENCY' === $user['role'] && $offer['agency_id'] !== $user['agency_id'] ) ) {
		throw new SKW_Http_Error( 404, 'This trip is no longer available. Refresh the trip list and choose another.' );
	}
	$left = (int) $offer['available'];
	if ( $left < $seats ) {
		throw new SKW_Http_Error( 409, 'Only ' . $left . ( 1 === $left ? ' seat is' : ' seats are' ) . ' left for this trip. Choose fewer seats or another trip.', array( 'availableSeats' => $left, 'waitlistAvailable' => $user && 'CLIENT' === $user['role'] ) );
	}
	$method = isset( $body['paymentMethod'] ) && is_string( $body['paymentMethod'] ) ? $body['paymentMethod'] : 'REQUEST_ONLY';
	$method = 'EVC_PLUS' === $method ? 'REQUEST_ONLY' : $method;
	$date   = ! isset( $body['travelDate'] ) || '' === $body['travelDate'] ? $offer['travel_date'] : skw_require_string( $body['travelDate'], 'Travel date', 10 );
	if ( ( $date && ( ! skw_is_iso_date( $date ) || $date < skw_today() ) ) || ( $offer['travel_date'] && $date !== $offer['travel_date'] ) ) {
		throw new SKW_Http_Error( 400, 'Choose a valid travel date available for this listing.' );
	}
	if ( ! in_array( $method, array( 'REQUEST_ONLY', 'PHONE' ), true ) ) {
		throw new SKW_Http_Error( 400, 'Choose a valid booking request option.' );
	}
	$wallet  = null;
	$account = null;
	if ( 'PHONE' === $method ) {
		$raw    = strtoupper( (string) ( isset( $body['wallet'] ) ? $body['wallet'] : 'WAAFI' ) );
		$wallet = 'EDAHAB' === $raw ? 'EDAHAB' : ( in_array( $raw, array( 'WAAFI', 'EVC', 'EVC_PLUS', 'ZAAD', 'SAHAL' ), true ) ? 'WAAFI' : null );
		if ( ! $wallet ) {
			throw new SKW_Http_Error( 400, 'Choose EVC Plus, Zaad, Sahal or eDahab.' );
		}
		$avail = skw_phone_pay_available();
		if ( ! $user || 'CLIENT' !== $user['role'] || ! $avail[ 'EDAHAB' === $wallet ? 'phoneEdahab' : 'phoneWaafi' ] ) {
			throw new SKW_Http_Error( 503, 'Paying with ' . ( 'EDAHAB' === $wallet ? 'eDahab' : 'EVC Plus, Zaad or Sahal' ) . ' is not available right now. Choose another option.' );
		}
		$account = skw_normalize_somali_phone( isset( $body['paymentPhone'] ) ? $body['paymentPhone'] : ( isset( $body['phone'] ) ? $body['phone'] : '' ) );
		if ( ! $account ) {
			throw new SKW_Http_Error( 400, 'Enter the mobile money number that will pay, for example 61 234 5678 or +252 61 234 5678.' );
		}
		if ( ! skw_rate_limit( 'phone-booking:' . $user['id'], 12, 3600 ) ) {
			throw new SKW_Http_Error( 429, 'Too many pay-by-phone bookings were started. Wait an hour, or finish or cancel an earlier booking first.' );
		}
	}
	$name  = skw_require_string( ! empty( $body['travelerName'] ) ? $body['travelerName'] : ( $customer ? $customer['name'] : null ), 'Traveler name' );
	$email = $user && 'CLIENT' === $user['role']
		? skw_normalize_email( ! empty( $body['travelerEmail'] ) ? $body['travelerEmail'] : $user['email'] )
		: skw_normalize_email( ! empty( $body['travelerEmail'] ) ? $body['travelerEmail'] : ( $customer ? $customer['email'] : '' ) );
	$phone = skw_require_string( ! empty( $body['phone'] ) ? $body['phone'] : ( $customer ? $customer['phone'] : null ), 'Phone', 40 );
	$base  = (int) $offer['base_cents'];
	$tax   = (int) $offer['tax_cents'];
	$supc  = (int) round( $base * (float) $offer['supplier_commission_pct'] / 100 );
	$agc   = (int) round( $base * (float) $offer['markup_pct'] / 100 );
	$fee   = 1200;
	$fin   = array(
		'supplierBaseCents' => $base * $seats, 'supplierTaxesCents' => $tax * $seats, 'supplierCommissionCents' => $supc * $seats,
		'agencyCommissionCents' => $agc * $seats, 'safarKaabeFeeCents' => $fee * $seats, 'paymentFeeCents' => 0,
		'customerGrandTotalCents' => ( $base + $tax + $agc + $fee ) * $seats, 'netPayableToSupplierCents' => ( $base + $tax - $supc ) * $seats,
		'recognizedPlatformRevenueCents' => ( $fee + $supc ) * $seats, 'agencyMarkupPct' => (float) $offer['markup_pct'],
	);
	$now     = skw_now();
	$booking = array(
		'id' => skw_uuid(), 'reference' => 'SK-' . skw_code(), 'pnr' => 'REQ-SK-' . skw_code(), 'agency_id' => $offer['agency_id'], 'offer_id' => $offer['id'],
		'customer_id' => $user && 'CLIENT' === $user['role'] ? $user['id'] : ( $customer ? $customer['id'] : null ),
		'traveler_name' => $name, 'traveler_email' => $email, 'phone' => $phone, 'offer_title' => $offer['title'], 'category' => $offer['category'],
		'payment_provider' => 'PHONE' === $method ? 'PHONE' : 'REQUEST_ONLY', 'state' => 'PHONE' === $method ? 'PAYMENT_PENDING' : 'REQUESTED',
		'financials_json' => json_encode( $fin ), 'seat_count' => $seats, 'travel_date' => $date, 'created_at' => $now, 'updated_at' => $now,
	);
	$conversation_id = null;
	SKW_DB::transaction( function () use ( $offer, $seats, $booking, $wallet, $account, $fin, $now, &$conversation_id ) {
		$taken = SKW_DB::query( 'UPDATE {catalog_products} SET available = available - ? WHERE id = ? AND is_published = 1 AND available >= ?', array( $seats, $offer['id'], $seats ) );
		if ( 1 !== $taken ) {
			$left = (int) SKW_DB::get_var( 'SELECT available FROM {catalog_products} WHERE id = ?', array( $offer['id'] ) );
			throw new SKW_Http_Error( 409, 'Only ' . $left . ( 1 === $left ? ' seat is' : ' seats are' ) . ' left for this trip. Choose fewer seats or another trip.', array( 'availableSeats' => $left, 'waitlistAvailable' => (bool) $booking['customer_id'] ) );
		}
		SKW_DB::insert( 'bookings', $booking );
		if ( $booking['customer_id'] ) {
			$conversation_id = SKW_DB::get_var( 'SELECT id FROM {conversations} WHERE agency_id = ? AND customer_id = ? ORDER BY last_message_at DESC LIMIT 1', array( $booking['agency_id'], $booking['customer_id'] ) );
			if ( ! $conversation_id ) {
				$conversation_id = skw_uuid();
				SKW_DB::insert( 'conversations', array( 'id' => $conversation_id, 'agency_id' => $booking['agency_id'], 'customer_id' => $booking['customer_id'], 'subject' => 'Booking ' . $booking['reference'], 'created_by' => $booking['customer_id'], 'created_at' => $now, 'last_message_at' => $now ) );
			}
			SKW_DB::insert( 'messages', array( 'id' => skw_uuid(), 'conversation_id' => $conversation_id, 'sender_id' => $booking['customer_id'], 'message_type' => 'TEXT',
				'body' => 'Booking request ' . $booking['reference'] . ' submitted for ' . $booking['offer_title'] . '. ' . $seats . ( 1 === $seats ? ' seat' : ' seats' ) . ' requested' . ( $booking['travel_date'] ? ' for ' . $booking['travel_date'] : '' ) . '.', 'created_at' => $now ) );
			SKW_DB::update( 'conversations', array( 'last_message_at' => $now ), array( 'id' => $conversation_id ) );
		}
		if ( $wallet ) {
			SKW_DB::insert( 'phone_payments', array( 'id' => skw_uuid(), 'booking_id' => $booking['id'], 'provider' => $wallet, 'account_number' => $account, 'amount_cents' => $fin['customerGrandTotalCents'], 'currency' => 'USD', 'status' => 'PENDING', 'created_at' => $now, 'updated_at' => $now ) );
		}
	} );
	$items = array();
	foreach ( skw_agency_staff_ids( $booking['agency_id'] ) as $staff_id ) {
		$items[] = array( 'recipientUserId' => $staff_id, 'agencyId' => $booking['agency_id'], 'bookingId' => $booking['id'], 'type' => 'BOOKING_REQUEST',
			'title' => 'New Booking Request', 'body' => $name . ' requested ' . $booking['offer_title'] . ( $date ? ' on ' . $date : '' ) . '. Booking ID: ' . $booking['reference'] . '.',
			'href' => skw_app_link( '?booking=' . rawurlencode( $booking['id'] ) ), 'dedupeKey' => 'BOOKING_REQUEST:' . $booking['id'] . ':' . $staff_id );
	}
	skw_notify( $items );
	$admin_email = skw_config( 'notification_email' );
	if ( $admin_email ) {
		skw_mail( $admin_email, 'New SAFAR KAABE booking ' . $booking['reference'], $name . ' requested ' . $booking['offer_title'] . ' (' . $seats . ' seat' . ( 1 === $seats ? '' : 's' ) . ').' );
	}
	skw_audit( $user ? $user['id'] : null, 'BOOKING_REQUESTED', $booking['reference'] . ' (' . $booking['agency_id'] . ')' );
	if ( $booking['customer_id'] ) {
		SKW_DB::query( 'DELETE FROM {trip_waitlist} WHERE offer_id = ? AND user_id = ?', array( $offer['id'], $booking['customer_id'] ) );
	}
	$view                   = skw_booking_view( skw_load_booking( $booking['id'] ), $user );
	$view['conversationId'] = $conversation_id;
	skw_json( 201, array( 'booking' => $view, 'conversationId' => $conversation_id, 'paymentUrl' => null ) );
} );

SKW_Router::add( '*', '#^/api/bookings/([0-9a-z-]+)$#i', function ( $p, $req ) {
	$user = skw_mutation();
	$b    = skw_owned_booking( $p[0], $user );
	if ( 'PATCH' === $req['method'] ) {
		return skw_booking_patch( $b, $user );
	}
	if ( 'DELETE' === $req['method'] ) {
		return skw_booking_cancel( $b, $user );
	}
	throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
} );

function skw_booking_patch( $b, $user ) {
	$body   = skw_body();
	$action = isset( $body['action'] ) ? $body['action'] : '';
	if ( 'CLIENT' === $user['role'] && 'EDIT' !== $action ) {
		throw new SKW_Http_Error( 403, 'Travelers can only edit their own pending booking details.' );
	}
	$now = skw_now();
	if ( 'ACCEPT' === $action ) {
		if ( ! in_array( $b['state'], array( 'REQUESTED', 'PAYMENT_RECEIVED' ), true ) ) {
			throw new SKW_Http_Error( 409, 'Only a new request or a paid request can be accepted.' );
		}
		if ( 1 !== SKW_DB::query( "UPDATE {bookings} SET state = 'ACCEPTED', updated_at = ? WHERE id = ? AND state = ?", array( $now, $b['id'], $b['state'] ) ) ) {
			throw new SKW_Http_Error( 409, 'This request has changed. Refresh the bookings list and try again.' );
		}
		skw_audit( $user['id'], 'BOOKING_REQUEST_ACCEPTED', $b['reference'] . ' (' . $b['agency_id'] . ')' );
		skw_notify( array( array( 'recipientUserId' => $b['customer_id'], 'agencyId' => $b['agency_id'], 'bookingId' => $b['id'], 'type' => 'BOOKING_ACCEPTED',
			'title' => 'Booking confirmed', 'body' => $b['agency_name'] . ' confirmed your booking ' . $b['reference'] . ' for ' . $b['offer_title'] . '.',
			'href' => skw_app_link( '?booking=' . rawurlencode( $b['id'] ) ), 'dedupeKey' => 'BOOKING_ACCEPTED:' . $b['id'] ) ) );
	} elseif ( 'UNDO_ACCEPTANCE' === $action ) {
		if ( 'ACCEPTED' !== $b['state'] || 'REQUEST_ONLY' !== $b['payment_provider'] ) {
			throw new SKW_Http_Error( 409, 'Only an unpaid accepted request can be returned to the pending list. Use booking cancellation for paid bookings.' );
		}
		SKW_DB::query( "UPDATE {bookings} SET state = 'REQUESTED', updated_at = ? WHERE id = ? AND state = 'ACCEPTED'", array( $now, $b['id'] ) );
		skw_audit( $user['id'], 'BOOKING_ACCEPTANCE_UNDONE', $b['reference'] );
	} elseif ( 'EDIT' === $action ) {
		if ( 'REQUESTED' !== $b['state'] || 'REQUEST_ONLY' !== $b['payment_provider'] ) {
			throw new SKW_Http_Error( 409, 'Booking details can only be edited before the request is accepted or paid.' );
		}
		$name  = skw_require_string( isset( $body['travelerName'] ) ? $body['travelerName'] : null, 'Traveler name' );
		$email = isset( $body['travelerEmail'] ) && is_string( $body['travelerEmail'] ) && trim( $body['travelerEmail'] ) ? skw_normalize_email( $body['travelerEmail'] ) : null;
		$phone = skw_require_string( isset( $body['phone'] ) ? $body['phone'] : null, 'Phone', 40 );
		$seats = isset( $body['seatCount'] ) ? skw_int( $body['seatCount'] ) : (int) $b['seat_count'];
		if ( null === $seats || $seats < 1 || $seats > 100000 ) {
			throw new SKW_Http_Error( 400, 'Enter a number of seats from 1 to 100,000.' );
		}
		SKW_DB::transaction( function () use ( $b, $seats, $name, $email, $phone, $now ) {
			$diff = $seats - (int) $b['seat_count'];
			if ( $diff ) {
				if ( ! $b['offer_id'] ) {
					throw new SKW_Http_Error( 409, 'Passenger count cannot be changed because this booking is not linked to an active trip listing.' );
				}
				if ( $diff > 0 && 1 !== SKW_DB::query( 'UPDATE {catalog_products} SET available = available - ? WHERE id = ? AND available >= ?', array( $diff, $b['offer_id'], $diff ) ) ) {
					throw new SKW_Http_Error( 409, 'There are not enough seats left for that many passengers.' );
				}
				if ( $diff < 0 ) {
					skw_return_seats( $b['offer_id'], $b['agency_id'], -$diff );
				}
				$fin = json_decode( $b['financials_json'], true );
				if ( is_array( $fin ) ) {
					foreach ( $fin as $k => $v ) {
						if ( 'agencyMarkupPct' !== $k && is_numeric( $v ) ) {
							$fin[ $k ] = (int) round( $v / max( 1, (int) $b['seat_count'] ) * $seats );
						}
					}
				}
				SKW_DB::update( 'bookings', array( 'financials_json' => json_encode( $fin ) ), array( 'id' => $b['id'] ) );
			}
			SKW_DB::update( 'bookings', array( 'traveler_name' => $name, 'traveler_email' => $email, 'phone' => $phone, 'seat_count' => $seats, 'updated_at' => $now ), array( 'id' => $b['id'] ) );
		} );
		skw_audit( $user['id'], 'BOOKING_REQUEST_EDITED', $b['reference'] );
	} elseif ( 'REJECT' === $action ) {
		if ( 'REQUESTED' !== $b['state'] || 'REQUEST_ONLY' !== $b['payment_provider'] ) {
			throw new SKW_Http_Error( 409, 'Only a new unpaid request can be rejected.' );
		}
		$reason = isset( $body['reason'] ) && is_string( $body['reason'] ) ? mb_substr( trim( preg_replace( '/\s+/', ' ', $body['reason'] ) ), 0, 500 ) : '';
		SKW_DB::transaction( function () use ( $b, $reason, $now ) {
			if ( 1 !== SKW_DB::query( "UPDATE {bookings} SET state = 'REJECTED', cancellation_reason = ?, updated_at = ? WHERE id = ? AND state = 'REQUESTED'", array( $reason ? $reason : 'Rejected by agency', $now, $b['id'] ) ) ) {
				throw new SKW_Http_Error( 409, 'This request has changed. Refresh the bookings list and try again.' );
			}
			skw_return_seats( $b['offer_id'], $b['agency_id'], $b['seat_count'] );
		} );
		skw_audit( $user['id'], 'BOOKING_REQUEST_REJECTED', $b['reference'] );
		skw_notify( array( array( 'recipientUserId' => $b['customer_id'], 'agencyId' => $b['agency_id'], 'bookingId' => $b['id'], 'type' => 'BOOKING_REJECTED',
			'title' => 'Booking not accepted', 'body' => $b['agency_name'] . ' could not accept booking ' . $b['reference'] . '.' . ( $reason ? ' Reason: ' . $reason : '' ),
			'href' => skw_app_link( '?booking=' . rawurlencode( $b['id'] ) ), 'dedupeKey' => 'BOOKING_REJECTED:' . $b['id'] ) ) );
		if ( $b['offer_id'] ) {
			skw_notify_waitlist( $b['offer_id'] );
		}
	} elseif ( 'RESTORE_REQUESTED' === $action ) {
		if ( 'REJECTED' !== $b['state'] || 'REQUEST_ONLY' !== $b['payment_provider'] ) {
			throw new SKW_Http_Error( 409, 'Only a rejected unpaid request can be restored.' );
		}
		SKW_DB::transaction( function () use ( $b, $now ) {
			if ( $b['offer_id'] && 1 !== SKW_DB::query( 'UPDATE {catalog_products} SET available = available - ? WHERE id = ? AND available >= ?', array( (int) $b['seat_count'], $b['offer_id'], (int) $b['seat_count'] ) ) ) {
				throw new SKW_Http_Error( 409, 'The request could not be restored because inventory changed. Refresh and try again.' );
			}
			SKW_DB::query( "UPDATE {bookings} SET state = 'REQUESTED', cancellation_reason = NULL, updated_at = ? WHERE id = ? AND state = 'REJECTED'", array( $now, $b['id'] ) );
		} );
		skw_audit( $user['id'], 'BOOKING_REQUEST_RESTORED', $b['reference'] );
	} elseif ( 'MARK_REFUNDED' === $action ) {
		if ( ! in_array( $b['refund_status'], array( 'NEEDED', 'UNCONFIRMED' ), true ) ) {
			throw new SKW_Http_Error( 409, 'This booking has no refund waiting to be sent.' );
		}
		$ref  = skw_require_string( isset( $body['refundReference'] ) ? $body['refundReference'] : null, 'Refund reference', 80 );
		$note = isset( $body['refundNote'] ) && is_string( $body['refundNote'] ) ? mb_substr( trim( preg_replace( '/\s+/', ' ', $body['refundNote'] ) ), 0, 300 ) : '';
		if ( 1 !== SKW_DB::query( "UPDATE {bookings} SET refund_status = 'REFUNDED', refund_reference = ?, refund_note = ?, refunded_at = ?, updated_at = ? WHERE id = ? AND refund_status IN ('NEEDED', 'UNCONFIRMED')", array( $ref, $note ? $note : null, $now, $now, $b['id'] ) ) ) {
			throw new SKW_Http_Error( 409, 'This refund was already recorded. Refresh the bookings list.' );
		}
		skw_audit( $user['id'], 'BOOKING_REFUND_RECORDED', $b['reference'] . ': ' . $ref );
		$fin = json_decode( $b['financials_json'], true );
		$amt = null !== $b['pp_amount'] ? (int) $b['pp_amount'] : ( isset( $fin['customerGrandTotalCents'] ) ? (int) $fin['customerGrandTotalCents'] : 0 );
		skw_notify( array( array( 'recipientUserId' => $b['customer_id'], 'agencyId' => $b['agency_id'], 'bookingId' => $b['id'], 'type' => 'PAYMENT_REFUNDED',
			'title' => 'Your refund was sent', 'body' => 'The agency sent back ' . skw_money( $amt ) . ' USD for booking ' . $b['reference'] . ' (' . $b['offer_title'] . '). Refund reference: ' . $ref . '.' . ( $note ? ' Note: ' . $note : '' ),
			'href' => skw_app_link( '?booking=' . rawurlencode( $b['id'] ) ), 'dedupeKey' => 'PAYMENT_REFUNDED:' . $b['id'] ) ) );
	} elseif ( function_exists( 'skw_phone_booking_action' ) && in_array( $action, array( 'CONFIRM_PHONE_PAYMENT', 'REJECT_PHONE_PAYMENT', 'SEND_REFUND' ), true ) ) {
		skw_phone_booking_action( $b, $user, $action, $body );
	} else {
		throw new SKW_Http_Error( 400, 'Choose accept, undo acceptance, edit, reject, restore, or record a refund for this booking.' );
	}
	return array( 'booking' => skw_booking_view( skw_load_booking( $b['id'] ), $user ), 'ticket' => null, 'ticketError' => null );
}

function skw_booking_cancel( $b, $user ) {
	$paid       = 'APPROVED' === $b['pp_status'] || 'PAYMENT_RECEIVED' === $b['state'];
	$unpaid_new = ( 'REQUESTED' === $b['state'] && 'REQUEST_ONLY' === $b['payment_provider'] ) || ( 'PAYMENT_PENDING' === $b['state'] && ! $paid && in_array( $b['pp_status'], array( null, 'PENDING' ), true ) && ! $b['pp_started'] );
	if ( 'CLIENT' === $user['role'] && ! $unpaid_new ) {
		throw new SKW_Http_Error( 409, 'Only a pending unpaid booking request can be deleted. Contact the agency to cancel an approved or paid trip.' );
	}
	if ( ! $unpaid_new && ! in_array( $b['state'], array( 'ACCEPTED', 'PAYMENT_RECEIVED' ), true ) ) {
		throw new SKW_Http_Error( 409, 'Only an open request or an accepted booking can be canceled here.' );
	}
	$body   = skw_body();
	$reason = preg_replace( '/\s+/', ' ', skw_require_string( isset( $body['reason'] ) ? $body['reason'] : null, 'Cancellation reason', 500 ) );
	if ( isset( $body['returnSeats'] ) && ! is_bool( $body['returnSeats'] ) ) {
		throw new SKW_Http_Error( 400, 'Choose whether the seats can return to inventory.' );
	}
	if ( $paid && ! isset( $body['returnSeats'] ) ) {
		throw new SKW_Http_Error( 400, 'Choose whether the paid seats are safe to return to inventory.' );
	}
	$return = ! $paid || true === $body['returnSeats'];
	if ( $paid && $return && ( ! isset( $body['confirmTicketNotIssued'] ) || true !== $body['confirmTicketNotIssued'] ) ) {
		throw new SKW_Http_Error( 400, 'Confirm that the travel ticket was not issued before returning its seats.' );
	}
	if ( $return && ! $b['offer_id'] ) {
		throw new SKW_Http_Error( 409, 'This older booking has no linked trip, so its seats cannot be safely returned.' );
	}
	$available = SKW_DB::transaction( function () use ( $b, $reason, $paid, $return, $user ) {
		$n = SKW_DB::query( "UPDATE {bookings} SET state = 'CANCELLED', cancellation_reason = ?, updated_at = ?, refund_status = ? WHERE id = ? AND state = ?",
			array( $reason, skw_now(), $paid ? 'NEEDED' : $b['refund_status'], $b['id'], $b['state'] ) );
		if ( 1 !== $n ) {
			throw new SKW_Http_Error( 409, 'This request has changed. Refresh the bookings list and try again.' );
		}
		if ( $return ) {
			skw_return_seats( $b['offer_id'], $b['agency_id'], $b['seat_count'] );
		}
		skw_audit( $user['id'], 'BOOKING_CANCELLED', $b['reference'] . ' (' . $b['agency_id'] . '): ' . $reason );
		return $return ? (int) SKW_DB::get_var( 'SELECT available FROM {catalog_products} WHERE id = ?', array( $b['offer_id'] ) ) : null;
	} );
	if ( $return && $b['offer_id'] ) {
		skw_notify_waitlist( $b['offer_id'] );
	}
	if ( 'CLIENT' !== $user['role'] ) {
		skw_notify( array( array( 'recipientUserId' => $b['customer_id'], 'agencyId' => $b['agency_id'], 'bookingId' => $b['id'], 'type' => 'BOOKING_CANCELLED',
			'title' => 'Booking cancelled', 'body' => 'Booking ' . $b['reference'] . ' (' . $b['offer_title'] . ') was cancelled. Reason: ' . $reason,
			'href' => skw_app_link( '?booking=' . rawurlencode( $b['id'] ) ), 'dedupeKey' => 'BOOKING_CANCELLED:' . $b['id'] . ':' . $b['customer_id'] ) ) );
	}
	$message = $paid
		? ( $return ? 'Booking canceled and seats returned. Send the refund to the traveler, then tap "Record refund" on this booking.' : 'Booking canceled and the seats stay reserved. Send the refund to the traveler, then tap "Record refund" on this booking.' )
		: 'Request canceled. Its seats are available again.';
	return array( 'ok' => true, 'message' => $message, 'offerId' => $return ? $b['offer_id'] : null, 'available' => $available, 'seatsReturned' => $return, 'paymentNeedsRefund' => $paid );
}

/* ---------- Booking confirmation (simple printable page instead of a PDF) ---------- */

SKW_Router::add( '*', '#^/api/bookings/([0-9a-z-]+)/ticket(\.pdf|\.jpg|/generate|/email)?$#i', function () {
	throw new SKW_Http_Error( 404, 'The booking document is not ready yet. Your booking details are shown in My Trips.' );
} );

/* ---------- Reviews ---------- */

SKW_Router::add( 'GET', '#^/api/agencies/([0-9a-z_-]+)/reviews$#i', function ( $p ) {
	$agency = SKW_DB::get_row( "SELECT id, name FROM {agencies} WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1", array( $p[0] ) );
	if ( ! $agency ) {
		throw new SKW_Http_Error( 404, 'Agency not found.' );
	}
	$rows  = SKW_DB::get_results( 'SELECT r.id, r.rating, r.comment, r.agency_reply, r.agency_reply_at, r.created_at, r.updated_at, u.name FROM {agency_reviews} r JOIN {users} u ON u.id = r.customer_id WHERE r.agency_id = ? ORDER BY r.updated_at DESC LIMIT 100', array( $agency['id'] ) );
	$dist  = array( 1 => 0, 2 => 0, 3 => 0, 4 => 0, 5 => 0 );
	$sum   = 0;
	$out   = array();
	foreach ( $rows as $r ) {
		$dist[ (int) $r['rating'] ]++;
		$sum  += (int) $r['rating'];
		$parts = preg_split( '/\s+/', trim( $r['name'] ) );
		$label = $parts[0] . ( count( $parts ) > 1 ? ' ' . mb_strtoupper( mb_substr( end( $parts ), 0, 1 ) ) . '.' : '' );
		$out[] = array( 'id' => $r['id'], 'rating' => (int) $r['rating'], 'comment' => $r['comment'], 'agencyReply' => $r['agency_reply'], 'agencyReplyAt' => $r['agency_reply_at'], 'createdAt' => $r['created_at'], 'updatedAt' => $r['updated_at'], 'reviewerName' => $label );
	}
	$count = count( $rows );
	return array( 'agency' => $agency, 'summary' => array( 'reviewCount' => $count, 'averageRating' => $count ? round( $sum / $count, 1 ) : null, 'distribution' => $dist ), 'reviews' => $out );
} );

SKW_Router::add( 'PUT', '#^/api/bookings/([0-9a-z-]+)/review$#i', function ( $p ) {
	$user = skw_mutation();
	if ( 'CLIENT' !== $user['role'] ) {
		throw new SKW_Http_Error( 403, 'Only the traveler who booked can review this trip.' );
	}
	$b = SKW_DB::get_row( 'SELECT * FROM {bookings} WHERE id = ? AND customer_id = ?', array( $p[0], $user['id'] ) );
	if ( ! $b ) {
		throw new SKW_Http_Error( 404, 'Booking not found.' );
	}
	if ( 'ACCEPTED' !== $b['state'] ) {
		throw new SKW_Http_Error( 409, 'You can review a trip after the agency confirms it.' );
	}
	if ( ! skw_can_review( $b ) ) {
		throw new SKW_Http_Error( 409, 'You can review this trip after your trip date.' );
	}
	$body    = skw_body();
	$rating  = isset( $body['rating'] ) ? skw_int( $body['rating'] ) : null;
	$comment = isset( $body['comment'] ) && is_string( $body['comment'] ) ? mb_substr( trim( $body['comment'] ), 0, 1000 ) : '';
	if ( null === $rating || $rating < 1 || $rating > 5 ) {
		throw new SKW_Http_Error( 400, 'Choose a rating from 1 to 5 stars.' );
	}
	$existing = SKW_DB::get_row( 'SELECT id FROM {agency_reviews} WHERE booking_id = ?', array( $b['id'] ) );
	$now      = skw_now();
	if ( $existing ) {
		SKW_DB::update( 'agency_reviews', array( 'rating' => $rating, 'comment' => $comment ? $comment : null, 'updated_at' => $now ), array( 'id' => $existing['id'] ) );
		$id = $existing['id'];
	} else {
		$id = skw_uuid();
		SKW_DB::insert( 'agency_reviews', array( 'id' => $id, 'booking_id' => $b['id'], 'agency_id' => $b['agency_id'], 'customer_id' => $user['id'], 'rating' => $rating, 'comment' => $comment ? $comment : null, 'created_at' => $now, 'updated_at' => $now ) );
		$items = array();
		foreach ( skw_agency_staff_ids( $b['agency_id'] ) as $sid ) {
			$items[] = array( 'recipientUserId' => $sid, 'agencyId' => $b['agency_id'], 'bookingId' => $b['id'], 'type' => 'REVIEW_RECEIVED', 'title' => 'New review', 'body' => 'A traveler rated your agency ' . $rating . ' out of 5.', 'href' => skw_app_link( '?agencyTab=REVIEWS' ), 'dedupeKey' => 'REVIEW_RECEIVED:' . $b['id'] . ':' . $sid );
		}
		skw_notify( $items );
	}
	skw_json( $existing ? 200 : 201, array( 'review' => array( 'id' => $id, 'rating' => $rating, 'comment' => $comment ) ) );
} );

SKW_Router::add( 'PUT', '#^/api/reviews/([0-9a-z-]+)/reply$#i', function ( $p ) {
	$user   = skw_mutation( array( 'AGENCY' ) );
	$review = SKW_DB::get_row( 'SELECT * FROM {agency_reviews} WHERE id = ? AND agency_id = ?', array( $p[0], $user['agency_id'] ) );
	if ( ! $review ) {
		throw new SKW_Http_Error( 404, 'Review not found.' );
	}
	$body  = skw_body();
	$reply = isset( $body['reply'] ) && is_string( $body['reply'] ) ? mb_substr( trim( $body['reply'] ), 0, 1000 ) : '';
	SKW_DB::update( 'agency_reviews', array( 'agency_reply' => $reply ? $reply : null, 'agency_reply_at' => $reply ? skw_now() : null ), array( 'id' => $review['id'] ) );
	if ( $reply ) {
		skw_notify( array( array( 'recipientUserId' => $review['customer_id'], 'agencyId' => $review['agency_id'], 'bookingId' => $review['booking_id'], 'type' => 'REVIEW_REPLY', 'title' => 'The agency replied to your review', 'body' => mb_substr( $reply, 0, 200 ), 'href' => skw_app_link( '?booking=' . rawurlencode( $review['booking_id'] ) ), 'dedupeKey' => 'REVIEW_REPLY:' . $review['id'] . ':' . md5( $reply ) ) ) );
	}
	return array( 'ok' => true, 'reply' => $reply );
} );

/* ---------- Agency clients and staff, admin travelers ---------- */

SKW_Router::add( '*', '#^/api/agency/clients(?:/([0-9a-z-]+))?$#i', function ( $p, $req ) {
	$id = isset( $p[0] ) ? $p[0] : '';
	if ( 'GET' === $req['method'] && ! $id ) {
		$user = skw_require_role( array( 'AGENCY' ) );
		return array( 'clients' => SKW_DB::get_results( 'SELECT id, name, phone, email, created_at AS createdAt FROM {agency_clients} WHERE agency_id = ? ORDER BY created_at DESC', array( $user['agency_id'] ) ) );
	}
	$user = skw_mutation( array( 'AGENCY' ) );
	if ( 'POST' === $req['method'] && ! $id ) {
		$body   = skw_body();
		$client = array( 'id' => skw_uuid(), 'agency_id' => $user['agency_id'], 'name' => skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Client name' ), 'phone' => skw_require_string( isset( $body['phone'] ) ? $body['phone'] : null, 'Phone', 40 ), 'email' => ! empty( $body['email'] ) ? skw_normalize_email( $body['email'] ) : null, 'created_at' => skw_now() );
		SKW_DB::insert( 'agency_clients', $client );
		skw_json( 201, array( 'client' => array( 'id' => $client['id'], 'name' => $client['name'], 'phone' => $client['phone'], 'email' => $client['email'], 'createdAt' => $client['created_at'] ) ) );
	}
	if ( 'DELETE' === $req['method'] && $id ) {
		SKW_DB::query( 'DELETE FROM {agency_clients} WHERE id = ? AND agency_id = ?', array( $id, $user['agency_id'] ) );
		return array( 'ok' => true );
	}
	throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
} );

SKW_Router::add( '*', '#^/api/agency/staff(?:/([0-9a-z-]+))?$#i', function ( $p, $req ) {
	$user = skw_mutation( array( 'AGENCY', 'SUPER_ADMIN' ) );
	$id   = isset( $p[0] ) ? $p[0] : '';
	if ( 'POST' === $req['method'] && ! $id ) {
		$body      = skw_body();
		$agency_id = 'AGENCY' === $user['role'] ? $user['agency_id'] : skw_require_string( isset( $body['agencyId'] ) ? $body['agencyId'] : null, 'Agency' );
		if ( ! SKW_DB::get_var( 'SELECT 1 FROM {agencies} WHERE id = ?', array( $agency_id ) ) ) {
			throw new SKW_Http_Error( 404, 'Agency not found.' );
		}
		$name  = skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Staff name' );
		$email = skw_normalize_email( isset( $body['email'] ) ? $body['email'] : null );
		$pass  = skw_validate_password( isset( $body['password'] ) ? $body['password'] : null );
		if ( SKW_DB::get_var( 'SELECT 1 FROM {users} WHERE email = ?', array( $email ) ) ) {
			throw new SKW_Http_Error( 409, 'An account with that email already exists.' );
		}
		$sid = skw_uuid();
		SKW_DB::insert( 'users', array( 'id' => $sid, 'email' => $email, 'name' => $name, 'phone' => '', 'password_hash' => skw_hash_password( $pass ), 'role' => 'AGENCY', 'agency_id' => $agency_id, 'created_at' => skw_now() ) );
		skw_audit( $user['id'], 'AGENCY_STAFF_CREATED', $email );
		skw_json( 201, array( 'staff' => array( 'id' => $sid, 'name' => $name, 'email' => $email, 'role' => 'AGENCY', 'agencyId' => $agency_id ) ) );
	}
	if ( 'DELETE' === $req['method'] && $id ) {
		if ( $id === $user['id'] ) {
			throw new SKW_Http_Error( 409, 'You cannot remove your own account.' );
		}
		$where = 'AGENCY' === $user['role'] ? ' AND agency_id = ?' : '';
		$args  = 'AGENCY' === $user['role'] ? array( $id, $user['agency_id'] ) : array( $id );
		$n     = SKW_DB::query( "DELETE FROM {users} WHERE id = ? AND role = 'AGENCY'" . $where, $args );
		SKW_DB::query( 'DELETE FROM {sessions} WHERE user_id = ?', array( $id ) );
		if ( ! $n ) {
			throw new SKW_Http_Error( 404, 'Staff account not found.' );
		}
		return array( 'ok' => true );
	}
	throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
} );

SKW_Router::add( '*', '#^/api/admin/customers(?:/([0-9a-z-]+))?$#i', function ( $p, $req ) {
	$user = skw_mutation( array( 'SUPER_ADMIN' ) );
	$id   = isset( $p[0] ) ? $p[0] : '';
	if ( 'POST' === $req['method'] && ! $id ) {
		$body  = skw_body();
		$name  = skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Name' );
		$email = skw_normalize_email( isset( $body['email'] ) ? $body['email'] : null );
		$phone = skw_require_string( isset( $body['phone'] ) ? $body['phone'] : null, 'Phone', 40 );
		$pass  = skw_validate_password( isset( $body['password'] ) ? $body['password'] : null );
		if ( SKW_DB::get_var( 'SELECT 1 FROM {users} WHERE email = ?', array( $email ) ) ) {
			throw new SKW_Http_Error( 409, 'An account with that email already exists.' );
		}
		$cid = skw_uuid();
		SKW_DB::insert( 'users', array( 'id' => $cid, 'email' => $email, 'name' => $name, 'phone' => $phone, 'password_hash' => skw_hash_password( $pass ), 'role' => 'CLIENT', 'agency_id' => null, 'created_at' => skw_now() ) );
		skw_json( 201, array( 'customer' => array( 'id' => $cid, 'name' => $name, 'email' => $email, 'phone' => $phone, 'createdAt' => skw_now() ) ) );
	}
	if ( $id && 'PATCH' === $req['method'] ) {
		$body = skw_body();
		SKW_DB::query( "UPDATE {users} SET name = ?, phone = ? WHERE id = ? AND role = 'CLIENT'", array( skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Name' ), skw_require_string( isset( $body['phone'] ) ? $body['phone'] : null, 'Phone', 40 ), $id ) );
		return array( 'ok' => true );
	}
	if ( $id && 'DELETE' === $req['method'] ) {
		if ( (int) SKW_DB::get_var( 'SELECT COUNT(*) FROM {bookings} WHERE customer_id = ?', array( $id ) ) ) {
			throw new SKW_Http_Error( 409, 'This traveler has bookings, so the account cannot be deleted.' );
		}
		SKW_DB::query( 'DELETE FROM {sessions} WHERE user_id = ?', array( $id ) );
		SKW_DB::query( "DELETE FROM {users} WHERE id = ? AND role = 'CLIENT'", array( $id ) );
		return array( 'ok' => true );
	}
	throw new SKW_Http_Error( 405, 'That action is not allowed here.' );
} );

/** Somali mobile number -> "+2526XXXXXXXX", or null. */
function skw_normalize_somali_phone( $raw ) {
	$d = preg_replace( '/[\s\-().]/', '', (string) $raw );
	$d = 0 === strpos( $d, '+' ) ? substr( $d, 1 ) : $d;
	$d = 0 === strpos( $d, '00252' ) ? substr( $d, 2 ) : $d;
	if ( ! ctype_digit( $d ) ) {
		return null;
	}
	$local = 0 === strpos( $d, '252' ) ? substr( $d, 3 ) : ( 0 === strpos( $d, '0' ) ? substr( $d, 1 ) : $d );
	return preg_match( '/^[679]\d{8}$/', $local ) ? '+252' . $local : null;
}
