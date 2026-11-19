<?php
/**
 * Pay by phone (WaafiPay: EVC Plus, Zaad, Sahal – and eDahab), handling of unclear payments, and sales reports.
 * Same request format as the marupay package. Results: APPROVED, FAILED (clearly refused, no money taken)
 * or UNKNOWN (anything unclear – never treated as failed, the agency checks its merchant portal).
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

/** POSTs JSON. Returns array(status_code, body_string) or null when the network failed or timed out. */
function skw_http_post_json( $url, $json, $timeout = 45 ) {
	if ( function_exists( 'set_time_limit' ) ) {
		@set_time_limit( $timeout + 30 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	}
	if ( function_exists( 'curl_init' ) ) {
		$ch = curl_init( $url );
		curl_setopt_array( $ch, array( CURLOPT_POST => true, CURLOPT_POSTFIELDS => $json, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_HTTPHEADER => array( 'Content-Type: application/json' ), CURLOPT_FOLLOWLOCATION => false ) );
		$body = curl_exec( $ch );
		$code = (int) curl_getinfo( $ch, CURLINFO_HTTP_CODE );
		curl_close( $ch );
		return false === $body ? null : array( $code, (string) $body );
	}
	$context = stream_context_create( array( 'http' => array( 'method' => 'POST', 'header' => "Content-Type: application/json\r\n", 'content' => $json, 'timeout' => $timeout, 'ignore_errors' => true ) ) );
	$body    = @file_get_contents( $url, false, $context ); // phpcs:ignore
	if ( false === $body ) {
		return null;
	}
	$code = isset( $http_response_header[0] ) && preg_match( '/\s(\d{3})\s/', $http_response_header[0], $m ) ? (int) $m[1] : 0;
	return array( $code, $body );
}

/** Charges a phone. Returns array(status APPROVED|FAILED|UNKNOWN, transaction_id, message). */
function skw_phone_charge( $provider, $account, $amount_cents, $description ) {
	$unknown = array( 'UNKNOWN', null, 'We could not confirm the payment yet. Please do not pay again.' );
	$amount  = round( $amount_cents / 100, 2 );
	$digits  = ltrim( $account, '+' );
	if ( 'EDAHAB' === $provider ) {
		$body = array( 'apiKey' => skw_config( 'edahab_api_key' ), 'edahabNumber' => substr( $digits, 3 ), 'amount' => $amount, 'currency' => 'USD', 'agentCode' => skw_config( 'edahab_agent_code' ), 'description' => $description );
		$json = json_encode( $body, JSON_UNESCAPED_SLASHES );
		$res  = skw_http_post_json( rtrim( skw_config( 'edahab_base_url', 'https://edahab.net/api' ), '/' ) . '/api/issueinvoice?hash=' . hash( 'sha256', $json . skw_config( 'edahab_secret_key' ) ), $json );
		$data = $res && 200 === $res[0] ? json_decode( $res[1], true ) : null;
		if ( ! is_array( $data ) ) {
			return $unknown;
		}
		$status = isset( $data['InvoiceStatus'] ) ? (string) $data['InvoiceStatus'] : '';
		if ( 'Paid' === $status ) {
			return array( 'APPROVED', isset( $data['TransactionId'] ) ? (string) $data['TransactionId'] : null, 'Payment received.' );
		}
		if ( isset( $data['ValidationErrors'][0]['Property'] ) && 'EDahabNumber' === $data['ValidationErrors'][0]['Property'] ) {
			return array( 'FAILED', null, 'This number is not registered for eDahab.' );
		}
		if ( isset( $data['StatusCode'] ) && 5 === (int) $data['StatusCode'] ) {
			return array( 'FAILED', null, 'Not enough balance in your eDahab wallet.' );
		}
		if ( in_array( strtolower( $status ), array( 'rejected', 'declined', 'cancelled', 'canceled', 'failed' ), true ) ) {
			return array( 'FAILED', null, 'The payment was not approved.' );
		}
		return $unknown;
	}
	$body = array(
		'schemaVersion' => '1.0', 'requestId' => skw_uuid(), 'timestamp' => gmdate( 'Y-m-d H:i:s' ), 'channelName' => 'WEB', 'serviceName' => 'API_PURCHASE',
		'serviceParams' => array(
			'merchantUid' => skw_config( 'waafi_merchant_uid' ), 'apiUserId' => skw_config( 'waafi_api_user_id' ), 'apiKey' => skw_config( 'waafi_api_key' ),
			'paymentMethod' => 'MWALLET_ACCOUNT', 'payerInfo' => array( 'accountNo' => $digits ),
			'transactionInfo' => array( 'referenceId' => skw_uuid(), 'invoiceId' => skw_uuid(), 'amount' => $amount, 'currency' => 'USD', 'description' => $description ),
		),
	);
	$res  = skw_http_post_json( skw_config( 'waafi_base_url', 'https://api.waafipay.net/asm' ), json_encode( $body ) );
	$data = $res && 200 === $res[0] ? json_decode( $res[1], true ) : null;
	if ( ! is_array( $data ) ) {
		return $unknown;
	}
	$code = isset( $data['responseCode'] ) ? (string) $data['responseCode'] : '';
	$msg  = isset( $data['responseMsg'] ) ? (string) $data['responseMsg'] : '';
	$err  = isset( $data['errorCode'] ) ? (string) $data['errorCode'] : '';
	if ( '2001' === $code && ! empty( $data['params'] ) ) {
		return array( 'APPROVED', isset( $data['params']['transactionId'] ) ? (string) $data['params']['transactionId'] : null, 'Payment received.' );
	}
	if ( 'E101073' === $err ) {
		return array( 'FAILED', null, 'Not enough balance in your wallet.' );
	}
	if ( 'RCS_NO_ROUTE_FOUND' === $msg ) {
		return array( 'FAILED', null, 'This number is not registered for EVC Plus, Zaad or Sahal.' );
	}
	if ( 'RCS_USER_REJECTED' === $msg || 'E10205' === $err ) {
		return array( 'FAILED', null, 'The payment was not approved on the phone.' );
	}
	return $unknown;
}

function skw_phone_notify( $b, $type, $title_traveler, $body_traveler, $title_staff, $body_staff ) {
	$items = array();
	if ( $title_traveler && $b['customer_id'] ) {
		$items[] = array( 'recipientUserId' => $b['customer_id'], 'agencyId' => $b['agency_id'], 'bookingId' => $b['id'], 'type' => $type, 'title' => $title_traveler, 'body' => $body_traveler, 'href' => skw_app_link( '?booking=' . rawurlencode( $b['id'] ) ), 'dedupeKey' => $type . ':' . $b['id'] . ':' . $b['customer_id'] );
	}
	if ( $title_staff ) {
		foreach ( skw_agency_staff_ids( $b['agency_id'] ) as $sid ) {
			$items[] = array( 'recipientUserId' => $sid, 'agencyId' => $b['agency_id'], 'bookingId' => $b['id'], 'type' => $type, 'title' => $title_staff, 'body' => $body_staff, 'href' => skw_app_link( '?booking=' . rawurlencode( $b['id'] ) ), 'dedupeKey' => $type . ':' . $b['id'] . ':' . $sid );
		}
	}
	skw_notify( $items );
}

/** Applies a final result to the payment and booking. */
function skw_phone_settle( $b, $status, $txn, $message ) {
	$now   = skw_now();
	$label = $b['reference'] . ' (' . $b['offer_title'] . ')';
	$money = skw_money( $b['pp_amount'] ) . ' USD';
	if ( 'APPROVED' === $status ) {
		$open = SKW_DB::transaction( function () use ( $b, $txn, $now ) {
			SKW_DB::query( "UPDATE {phone_payments} SET status = 'APPROVED', transaction_id = ?, error_message = NULL, updated_at = ? WHERE booking_id = ?", array( $txn, $now, $b['id'] ) );
			$n = SKW_DB::query( "UPDATE {bookings} SET state = 'PAYMENT_RECEIVED', updated_at = ? WHERE id = ? AND state = 'PAYMENT_PENDING'", array( $now, $b['id'] ) );
			if ( 1 !== $n ) {
				SKW_DB::query( "UPDATE {bookings} SET refund_status = 'NEEDED', updated_at = ? WHERE id = ? AND refund_status IS NULL", array( $now, $b['id'] ) );
			}
			return 1 === $n;
		} );
		if ( $open ) {
			skw_phone_notify( $b, 'PAYMENT_CONFIRMED', 'Payment received', 'We received ' . $money . ' for booking ' . $label . '. The agency will confirm your trip soon.', 'Payment received – review and accept', $b['traveler_name'] . ' paid ' . $money . ' by phone for ' . $label . '.' );
		} else {
			skw_phone_notify( $b, 'PAYMENT_NEEDS_REFUND', 'Payment received for a cancelled booking', 'We received ' . $money . ' for ' . $label . ', which was already cancelled. The agency will send it back.', 'Payment received for a cancelled booking', $money . ' arrived for ' . $label . ', which was already cancelled. Send the money back, then record the refund.' );
		}
		skw_audit( null, 'PHONE_PAYMENT_APPROVED', $b['reference'] );
		return;
	}
	if ( 'FAILED' === $status ) {
		SKW_DB::transaction( function () use ( $b, $message, $now ) {
			SKW_DB::query( "UPDATE {phone_payments} SET status = 'FAILED', error_message = ?, updated_at = ? WHERE booking_id = ?", array( $message, $now, $b['id'] ) );
			if ( 1 === SKW_DB::query( "UPDATE {bookings} SET state = 'CANCELLED', cancellation_reason = ?, updated_at = ? WHERE id = ? AND state = 'PAYMENT_PENDING'", array( 'Payment not completed: ' . $message, $now, $b['id'] ) ) ) {
				skw_return_seats( $b['offer_id'], $b['agency_id'], $b['seat_count'] );
			}
		} );
		if ( $b['offer_id'] ) {
			skw_notify_waitlist( $b['offer_id'] );
		}
		skw_phone_notify( $b, 'PAYMENT_FAILED', 'Payment not completed', $message . ' No money was taken. Booking ' . $label . ' was cancelled, so you can book again.', null, null );
		return;
	}
	SKW_DB::query( "UPDATE {phone_payments} SET status = 'UNKNOWN', error_message = ?, updated_at = ? WHERE booking_id = ?", array( $message, $now, $b['id'] ) );
	skw_phone_notify( $b, 'PAYMENT_CHECK_NEEDED', 'We are checking your payment', 'We could not confirm your payment for ' . $label . ' yet. Please do not pay again. Your seats stay reserved.', 'Check this phone payment', 'We could not confirm the payment of ' . $money . ' from ' . $b['pp_account'] . ' for ' . $label . '. Check your merchant portal, then mark it as received or not received.' );
}

SKW_Router::add( 'POST', '#^/api/payments/phone/([0-9a-z-]+)/charge$#i', function ( $p ) {
	$user = skw_mutation();
	$b    = skw_load_booking( $p[0] );
	if ( ! $b || ( 'CLIENT' === $user['role'] && $b['customer_id'] !== $user['id'] ) || ( 'CLIENT' !== $user['role'] && 'SUPER_ADMIN' !== $user['role'] ) ) {
		throw new SKW_Http_Error( 'AGENCY' === $user['role'] && $b && $b['agency_id'] === $user['agency_id'] ? 403 : 404, 'AGENCY' === $user['role'] ? 'Only the traveler can pay for this booking.' : 'Booking request not found.' );
	}
	if ( ! $b['pp_status'] ) {
		throw new SKW_Http_Error( 409, 'This booking is not paid by phone.' );
	}
	$finished = function ( $status, $message, $state ) {
		return array( 'payment' => array( 'status' => $status, 'message' => $message, 'bookingState' => $state, 'alreadyFinished' => true ) );
	};
	if ( 'PENDING' !== $b['pp_status'] || $b['pp_started'] ) {
		if ( 'PENDING' === $b['pp_status'] && $b['pp_started'] && $b['pp_started'] < skw_now( -180 ) ) {
			skw_phone_settle( $b, 'UNKNOWN', null, 'The payment took too long to answer.' );
			return $finished( 'UNKNOWN', 'We could not confirm the payment yet. Please do not pay again.', $b['state'] );
		}
		return $finished( 'PENDING' === $b['pp_status'] ? 'PROCESSING' : $b['pp_status'], $b['pp_message'], $b['state'] );
	}
	if ( 'PAYMENT_PENDING' !== $b['state'] ) {
		return array( 'payment' => array( 'status' => 'PENDING', 'message' => null, 'bookingState' => $b['state'] ) );
	}
	if ( ! skw_rate_limit( 'phone-charge:' . $user['id'], 12, 3600 ) || ! skw_rate_limit( 'phone-charge-number:' . $b['pp_account'], 5, 3600 ) ) {
		throw new SKW_Http_Error( 429, 'Too many payment requests. Wait an hour and try again.' );
	}
	// Claim the payment first, so two requests can never charge twice.
	if ( 1 !== SKW_DB::query( "UPDATE {phone_payments} SET started_at = ?, updated_at = ? WHERE booking_id = ? AND status = 'PENDING' AND started_at IS NULL", array( skw_now(), skw_now(), $b['id'] ) ) ) {
		return $finished( 'PROCESSING', null, $b['state'] );
	}
	$result = skw_phone_charge( $b['pp_provider'], $b['pp_account'], (int) $b['pp_amount'], 'SAFAR KAABE booking ' . $b['reference'] );
	skw_phone_settle( $b, $result[0], $result[1], $result[2] );
	$after = skw_load_booking( $b['id'] );
	return array( 'payment' => array( 'status' => $result[0], 'message' => $result[2], 'transactionId' => $result[1], 'bookingState' => $after['state'] ) );
} );

/** Agency actions for phone payments: confirm or reject an unclear payment; automatic refunds are not on the website. */
function skw_phone_booking_action( $b, $user, $action, $body ) {
	if ( 'SEND_REFUND' === $action ) {
		throw new SKW_Http_Error( 409, 'Automatic refunds are not available on the website. Send the money yourself, then record the refund.' );
	}
	if ( 'UNKNOWN' !== $b['pp_status'] ) {
		throw new SKW_Http_Error( 409, 'Only a payment that is being checked can be confirmed or rejected.' );
	}
	if ( 'CONFIRM_PHONE_PAYMENT' === $action ) {
		$txn = isset( $body['transactionId'] ) && is_string( $body['transactionId'] ) ? mb_substr( trim( $body['transactionId'] ), 0, 80 ) : '';
		skw_phone_settle( $b, 'APPROVED', $txn ? $txn : null, 'Confirmed by the agency.' );
		skw_audit( $user['id'], 'PHONE_PAYMENT_CONFIRMED_BY_AGENCY', $b['reference'] );
		return;
	}
	if ( $b['pp_started'] && $b['pp_started'] > skw_now( -900 ) ) {
		throw new SKW_Http_Error( 409, 'Wait 15 minutes after the payment request before marking it as not received – the traveler may still approve it.' );
	}
	skw_phone_settle( $b, 'FAILED', null, 'The agency did not receive the payment.' );
	skw_audit( $user['id'], 'PHONE_PAYMENT_REJECTED_BY_AGENCY', $b['reference'] );
}

SKW_Router::add( 'POST', '#^/api/payments/waafi/refresh$#', function () {
	skw_mutation();
	throw new SKW_Http_Error( 404, 'Payment not found.' );
} );

/* ---------- Sales reports ---------- */

function skw_csv_cell( $value ) {
	$text = null === $value ? '' : (string) $value;
	if ( preg_match( '/^[=+\-@\t\r]/', $text ) && ! preg_match( '/^[+-]?[\d\s().-]+$/', $text ) ) {
		$text = "'" . $text;
	}
	return preg_match( '/[",\r\n]/', $text ) ? '"' . str_replace( '"', '""', $text ) . '"' : $text;
}

SKW_Router::add( 'GET', '#^/api/reports/sales$#', function ( $p, $req ) {
	$user = skw_require_role( array( 'SUPER_ADMIN', 'AGENCY' ) );
	$from = isset( $req['query']['from'] ) ? (string) $req['query']['from'] : skw_today( -89 );
	$to   = isset( $req['query']['to'] ) ? (string) $req['query']['to'] : skw_today();
	if ( ! skw_is_iso_date( $from ) || ! skw_is_iso_date( $to ) || $from > $to ) {
		throw new SKW_Http_Error( 400, 'Choose a valid start and end date. The start date must be before the end date.' );
	}
	$agency = 'AGENCY' === $user['role'] ? $user['agency_id'] : ( isset( $req['query']['agencyId'] ) ? (string) $req['query']['agencyId'] : '' );
	$sql    = 'SELECT b.reference, b.created_at, b.travel_date, b.offer_title, b.category, b.traveler_name, b.phone, b.seat_count, b.state, b.payment_provider, b.financials_json, b.refund_status, b.refund_reference, a.name AS agency_name, pp.status AS pp_status, pp.amount_cents AS pp_amount
		FROM {bookings} b JOIN {agencies} a ON a.id = b.agency_id LEFT JOIN {phone_payments} pp ON pp.booking_id = b.id WHERE b.created_at >= ? AND b.created_at < ?' . ( $agency ? ' AND b.agency_id = ?' : '' ) . ' ORDER BY b.created_at DESC';
	$args   = array( $from . 'T00:00:00.000Z', gmdate( 'Y-m-d', strtotime( $to . 'T00:00:00Z' ) + 86400 ) . 'T00:00:00.000Z' );
	if ( $agency ) {
		$args[] = $agency;
	}
	$rows   = SKW_DB::get_results( $sql, $args );
	$labels = array( 'REQUESTED' => 'New request', 'PAYMENT_PENDING' => 'Waiting for payment', 'PAYMENT_RECEIVED' => 'Paid - needs confirmation', 'ACCEPTED' => 'Confirmed', 'REJECTED' => 'Declined', 'CANCELLED' => 'Cancelled' );
	foreach ( $rows as &$r ) {
		$fin            = json_decode( $r['financials_json'], true );
		$r['total']     = isset( $fin['customerGrandTotalCents'] ) ? (int) $fin['customerGrandTotalCents'] : 0;
		$r['paid']      = 'APPROVED' === $r['pp_status'] ? (int) $r['pp_amount'] : 0;
	}
	unset( $r );
	if ( isset( $req['query']['format'] ) && 'csv' === $req['query']['format'] ) {
		$lines = array( array( 'Booking number', 'Booked on', 'Travel date', 'Trip', 'Type', 'Agency', 'Traveler', 'Phone', 'Seats', 'Status', 'Payment', 'Total (USD)', 'Paid online (USD)', 'Refund', 'Refund reference' ) );
		foreach ( $rows as $r ) {
			$lines[] = array( $r['reference'], substr( $r['created_at'], 0, 10 ), $r['travel_date'], $r['offer_title'], $r['category'], $r['agency_name'], $r['traveler_name'], $r['phone'], $r['seat_count'],
				isset( $labels[ $r['state'] ] ) ? $labels[ $r['state'] ] : $r['state'], 'PHONE' === $r['payment_provider'] ? 'Pay by phone (' . $r['pp_status'] . ')' : 'Pay the agency directly',
				skw_money( $r['total'] ), skw_money( $r['paid'] ), 'NEEDED' === $r['refund_status'] ? 'Refund needed' : ( 'REFUNDED' === $r['refund_status'] ? 'Refunded' : '' ), $r['refund_reference'] );
		}
		$csv = "\xEF\xBB\xBF" . implode( "\r\n", array_map( function ( $line ) {
			return implode( ',', array_map( 'skw_csv_cell', $line ) );
		}, $lines ) ) . "\r\n";
		skw_send_raw( 200, 'text/csv; charset=utf-8', $csv, array( 'Content-Disposition' => 'attachment; filename="safar-kaabe-sales-' . $from . '-to-' . $to . '.csv"' ) );
	}
	$empty  = array( 'requests' => 0, 'confirmed' => 0, 'cancelled' => 0, 'seatsSold' => 0, 'salesCents' => 0, 'paidOnlineCents' => 0 );
	$add    = function ( &$t, $r ) {
		$t['requests']++;
		if ( in_array( $r['state'], array( 'ACCEPTED', 'PAYMENT_RECEIVED' ), true ) ) {
			$t['confirmed']++;
			$t['seatsSold']  += (int) $r['seat_count'];
			$t['salesCents'] += $r['total'];
		}
		if ( in_array( $r['state'], array( 'CANCELLED', 'REJECTED' ), true ) ) {
			$t['cancelled']++;
		}
		$t['paidOnlineCents'] += $r['paid'];
	};
	$totals = $empty;
	$trips  = array();
	$months = array();
	$refund = 0;
	foreach ( $rows as $r ) {
		$add( $totals, $r );
		if ( ! isset( $trips[ $r['offer_title'] ] ) ) {
			$trips[ $r['offer_title'] ] = array_merge( array( 'trip' => $r['offer_title'] ), $empty );
		}
		$add( $trips[ $r['offer_title'] ], $r );
		$m = substr( $r['created_at'], 0, 7 );
		if ( ! isset( $months[ $m ] ) ) {
			$months[ $m ] = array_merge( array( 'month' => $m ), $empty );
		}
		$add( $months[ $m ], $r );
		$refund += 'NEEDED' === $r['refund_status'] ? 1 : 0;
	}
	$trips = array_values( $trips );
	usort( $trips, function ( $a, $b ) {
		return $b['salesCents'] - $a['salesCents'] ? $b['salesCents'] - $a['salesCents'] : $b['requests'] - $a['requests'];
	} );
	krsort( $months );
	return array( 'from' => $from, 'to' => $to, 'totals' => $totals, 'refundsNeeded' => $refund, 'byTrip' => $trips, 'byMonth' => array_values( $months ) );
} );
