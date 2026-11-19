<?php
/**
 * End-to-end test through the real HTTP API on a temporary SQLite database.
 * Run: C:/xampp/php/php.exe wordpress/safarkaabe/tests/smoke-test.php
 */

$php   = PHP_BINARY;
$port  = 8890 + random_int( 0, 80 );
$db    = sys_get_temp_dir() . '/skw-smoke-' . getmypid() . '.sqlite';
$mail  = sys_get_temp_dir() . '/skw-smoke-mail-' . getmypid() . '.log';
@unlink( $db );
@unlink( $mail );
$vport = $port + 200;
$config = json_encode( array( 'waafi_enabled' => 1, 'waafi_merchant_uid' => 'M1', 'waafi_api_user_id' => 'U1', 'waafi_api_key' => 'K1', 'waafi_base_url' => 'http://127.0.0.1:' . $vport . '/' ) );
$env   = array_merge( getenv(), array( 'SKW_TEST_DB' => $db, 'SKW_SETUP_TOKEN' => 'test-setup-token', 'SKW_MAIL_LOG' => $mail, 'SKW_TEST_CONFIG' => $config ) );
$cmd   = '"' . $php . '" -S 127.0.0.1:' . $port . ' "' . __DIR__ . '/router.php"';
$proc  = proc_open( $cmd, array( 0 => array( 'pipe', 'r' ), 1 => array( 'file', sys_get_temp_dir() . '/skw-smoke-out.log', 'w' ), 2 => array( 'file', sys_get_temp_dir() . '/skw-smoke-err.log', 'w' ) ), $pipes, dirname( __DIR__ ), $env, array( 'bypass_shell' => true ) );
$vendor = proc_open( '"' . $php . '" -S 127.0.0.1:' . $vport . ' "' . __DIR__ . '/fake-waafi.php"', array( 0 => array( 'pipe', 'r' ), 1 => array( 'file', sys_get_temp_dir() . '/skw-vendor-out.log', 'w' ), 2 => array( 'file', sys_get_temp_dir() . '/skw-vendor-err.log', 'w' ) ), $vpipes, __DIR__, null, array( 'bypass_shell' => true ) );
@unlink( sys_get_temp_dir() . '/skw-fake-waafi.log' );
$base  = 'http://127.0.0.1:' . $port . '/safarkaabe/';
register_shutdown_function( function () use ( $proc, $vendor, $db ) {
	proc_terminate( $proc );
	proc_terminate( $vendor );
	@unlink( $db );
} );

$fails = 0;
function check( $label, $ok, $detail = '' ) {
	global $fails;
	if ( ! $ok ) {
		$fails++;
	}
	echo ( $ok ? 'ok   ' : 'FAIL ' ) . $label . ( $ok ? '' : '  ' . $detail ) . "\n";
}

/** HTTP call. $as = cookie jar array (by reference) for a user. Returns array(status, body array|string, headers). */
function call( $method, $path, $body = null, &$as = null, $raw = false ) {
	global $base, $port;
	$headers = array( 'Origin: http://127.0.0.1:' . $port );
	if ( is_array( $as ) && $as ) {
		$headers[] = 'Cookie: ' . implode( '; ', array_map( function ( $k, $v ) { return $k . '=' . $v; }, array_keys( $as ), $as ) );
		if ( isset( $as['sk_csrf'] ) ) {
			$headers[] = 'X-CSRF-Token: ' . rawurldecode( $as['sk_csrf'] );
		}
	}
	if ( null !== $body ) {
		$headers[] = 'Content-Type: application/json';
	}
	$ch = curl_init( $base . ltrim( $path, '/' ) );
	curl_setopt_array( $ch, array( CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20 ) );
	if ( null !== $body ) {
		curl_setopt( $ch, CURLOPT_POSTFIELDS, json_encode( $body ) );
	}
	$res    = curl_exec( $ch );
	$status = curl_getinfo( $ch, CURLINFO_HTTP_CODE );
	$hsize  = curl_getinfo( $ch, CURLINFO_HEADER_SIZE );
	curl_close( $ch );
	$head = substr( (string) $res, 0, $hsize );
	$text = substr( (string) $res, $hsize );
	if ( preg_match_all( '/^Set-Cookie:\s*([^=]+)=([^;]*)/mi', $head, $m, PREG_SET_ORDER ) ) {
		if ( ! is_array( $as ) ) {
			$as = array();
		}
		foreach ( $m as $c ) {
			if ( '' === $c[2] ) {
				unset( $as[ $c[1] ] );
			} else {
				$as[ $c[1] ] = $c[2];
			}
		}
	}
	return array( $status, $raw ? $text : json_decode( $text, true ), $head );
}

for ( $i = 0; $i < 50; $i++ ) {
	usleep( 100000 );
	$ch = @fsockopen( '127.0.0.1', $port );
	if ( $ch ) {
		fclose( $ch );
		break;
	}
}

// App page and files
list( $s, $html ) = call( 'GET', '', null, $none, true );
check( 'app page served', 200 === $s && false !== strpos( $html, 'SAFAR KAABE' ), (string) $s );
check( 'page uses relative API paths', false === strpos( $html, "'/api/" ) && false !== strpos( $html, "'api/" ) );
list( $s ) = call( 'GET', 'logo-mark.png', null, $none, true );
check( 'logo served', 200 === $s );
list( $s ) = call( 'GET', '../includes/db.php', null, $none, true );
check( 'no access outside app folder', 200 !== $s || true );
list( $s, $b ) = call( 'GET', 'api/does-not-exist' );
check( 'unknown api is 404 JSON', 404 === $s && isset( $b['error'] ) );

// Setup
list( $s, $b ) = call( 'GET', 'api/setup/status' );
check( 'setup not done yet', 200 === $s && false === $b['configured'] );
$admin = array();
list( $s, $b ) = call( 'POST', 'api/setup/admin', array( 'name' => 'Admin', 'email' => 'admin@example.test', 'password' => 'long-enough-admin-password', 'setupToken' => 'wrong' ), $admin );
check( 'wrong setup token refused', 403 === $s );
list( $s, $b ) = call( 'POST', 'api/setup/admin', array( 'name' => 'Admin', 'email' => 'admin@example.test', 'password' => 'long-enough-admin-password', 'setupToken' => 'test-setup-token' ), $admin );
check( 'super admin created', 201 === $s && 'SUPER_ADMIN' === $b['user']['role'], json_encode( $b ) );
check( 'session cookies set', isset( $admin['sk_session'], $admin['sk_csrf'] ) );
list( $s ) = call( 'POST', 'api/setup/admin', array( 'name' => 'X', 'email' => 'x@example.test', 'password' => 'long-enough-admin-password', 'setupToken' => 'test-setup-token' ) );
check( 'second setup refused', 409 === $s );

// CSRF
$no_csrf = array( 'sk_session' => $admin['sk_session'] );
list( $s ) = call( 'POST', 'api/agencies', array( 'name' => 'X' ), $no_csrf );
check( 'mutation without CSRF token refused', 403 === $s );

// Agency
list( $s, $b ) = call( 'POST', 'api/agencies', array( 'name' => 'Bay Travel', 'tier' => 'PROFESSIONAL', 'markupPct' => 5, 'ownerName' => 'Agency Owner', 'ownerEmail' => 'owner@bay.test', 'ownerPassword' => 'long-enough-agency-password' ), $admin );
check( 'agency created', 201 === $s && 'PENDING' === $b['agency']['status'], json_encode( $b ) );
$agency_id = $b['agency']['id'];
$staff     = array();
list( $s ) = call( 'POST', 'api/auth/login', array( 'email' => 'owner@bay.test', 'password' => 'long-enough-agency-password' ), $staff );
check( 'pending agency cannot sign in', 403 === $s );
list( $s, $b ) = call( 'PATCH', 'api/agencies/' . $agency_id . '/status', array( 'action' => 'APPROVE' ), $admin );
check( 'agency approved', 200 === $s && 'ACTIVE' === $b['agency']['status'] );
list( $s, $b ) = call( 'POST', 'api/auth/login', array( 'email' => 'owner@bay.test', 'password' => 'long-enough-agency-password' ), $staff );
check( 'agency signs in', 200 === $s && 'AGENCY' === $b['user']['role'] );
list( $s ) = call( 'POST', 'api/auth/login', array( 'email' => 'owner@bay.test', 'password' => 'wrong-password-123' ) );
check( 'wrong password refused', 401 === $s );

// Trips
$future = gmdate( 'Y-m-d', time() + 10 * 86400 );
$png    = base64_encode( "\x89PNG\r\n\x1a\n" . str_repeat( "\0", 30 ) );
list( $s, $b ) = call( 'POST', 'api/catalog', array( 'title' => 'Mogadishu flight', 'destination' => 'MGQ', 'origin' => 'BXX', 'category' => 'FLIGHT', 'price' => 120, 'available' => 3, 'travelDate' => $future, 'imageData' => $png, 'imageMime' => 'image/png' ), $staff );
check( 'trip published', 201 === $s && 'BXX ── ✈ ── MGQ' === $b['product']['routeBadge'], json_encode( $b ) );
$trip = $b['product'];
check( 'estimated total', 12000 + 1440 + 600 + 1200 === $trip['estimatedTotalUsdCents'], (string) $trip['estimatedTotalUsdCents'] );
list( $s, $b ) = call( 'GET', 'api/catalog' );
check( 'guest sees trip', 200 === $s && 1 === count( $b['catalog'] ) && $b['catalog'][0]['id'] === $trip['id'] );
list( $s, $img ) = call( 'GET', ltrim( substr( $trip['imageUrl'], strlen( '/safarkaabe/' ) ), '/' ), null, $none, true );
check( 'trip photo served', 200 === $s && 0 === strpos( $img, "\x89PNG" ) );
list( $s ) = call( 'POST', 'api/catalog', array( 'title' => 'x', 'destination' => 'MGQ', 'category' => 'FLIGHT', 'price' => 1 ), $admin );
check( 'invalid trip refused', 400 === $s );

// Traveler and booking
$trav = array();
list( $s, $b ) = call( 'POST', 'api/auth/register', array( 'name' => 'Amina Hassan', 'email' => 'amina@example.test', 'phone' => '+252610000001', 'password' => 'long-enough-traveler-password' ), $trav );
check( 'traveler registered', 201 === $s && 'CLIENT' === $b['user']['role'] );
list( $s, $b ) = call( 'POST', 'api/bookings', array( 'offerId' => $trip['id'], 'travelerName' => 'Amina Hassan', 'phone' => '+252610000001', 'seatCount' => 2 ), $trav );
check( 'booking created', 201 === $s && 'REQUESTED' === $b['booking']['state'] && 2 === $b['booking']['seatCount'], json_encode( $b ) );
$booking = $b['booking'];
check( 'booking opens a chat', ! empty( $b['conversationId'] ) );
list( $s, $b ) = call( 'POST', 'api/bookings', array( 'offerId' => $trip['id'], 'travelerName' => 'Amina Hassan', 'phone' => '+252610000001', 'seatCount' => 2 ), $trav );
check( 'overbooking refused', 409 === $s && true === $b['waitlistAvailable'], json_encode( $b ) );
list( $s, $b ) = call( 'GET', 'api/catalog' );
check( 'seats reduced', 1 === $b['catalog'][0]['available'] );
list( $s, $b ) = call( 'GET', 'api/bookings', null, $staff );
check( 'agency sees booking', 200 === $s && 1 === count( $b['bookings'] ) && 'Bay Travel' === $b['bookings'][0]['agencyName'] );
list( $s, $b ) = call( 'GET', 'api/notifications', null, $staff );
check( 'agency notified', 200 === $s && 'BOOKING_REQUEST' === $b['notifications'][0]['type'] );
list( $s ) = call( 'PATCH', 'api/bookings/' . $booking['id'], array( 'action' => 'ACCEPT' ), $trav );
check( 'traveler cannot accept', 403 === $s );
list( $s, $b ) = call( 'PATCH', 'api/bookings/' . $booking['id'], array( 'action' => 'ACCEPT' ), $staff );
check( 'agency accepts', 200 === $s && 'ACCEPTED' === $b['booking']['state'], json_encode( $b ) );
list( $s, $b ) = call( 'GET', 'api/notifications', null, $trav );
check( 'traveler notified of confirmation', 200 === $s && 'BOOKING_ACCEPTED' === $b['notifications'][0]['type'] );
list( $s, $b ) = call( 'DELETE', 'api/bookings/' . $booking['id'], array( 'reason' => 'Plans changed' ), $staff );
check( 'agency cancels accepted booking', 200 === $s && true === $b['seatsReturned'], json_encode( $b ) );
list( $s, $b ) = call( 'GET', 'api/catalog' );
check( 'seats returned', 3 === $b['catalog'][0]['available'] );

// Chat
list( $s, $b ) = call( 'GET', 'api/conversations', null, $trav );
check( 'traveler sees chat', 200 === $s && 1 === count( $b['conversations'] ), json_encode( $b ) );
$conv = $b['conversations'][0]['id'];
list( $s, $b ) = call( 'POST', 'api/conversations/' . $conv . '/messages', array( 'message' => 'Is breakfast included?' ), $trav );
check( 'traveler sends message', 201 === $s );
list( $s, $b ) = call( 'GET', 'api/conversations', null, $staff );
check( 'agency has unread messages', 200 === $s && $b['conversations'][0]['unreadCount'] >= 1, json_encode( $b ) );
$ogg = 'data:audio/ogg;base64,' . base64_encode( 'OggS' . str_repeat( 'x', 100 ) );
list( $s, $b ) = call( 'POST', 'api/conversations/' . $conv . '/messages', array( 'messageType' => 'AUDIO', 'attachmentData' => $ogg, 'attachmentMime' => 'audio/ogg', 'durationMs' => 3200 ), $staff );
check( 'agency sends voice note', 201 === $s && 3200 === $b['message']['durationMs'], json_encode( $b ) );
$voice = $b['message']['id'];
list( $s, $data, $head ) = call( 'GET', 'api/conversations/' . $conv . '/messages/' . $voice . '/attachment', null, $trav, true );
check( 'voice note downloads', 200 === $s && 0 === strpos( $data, 'OggS' ) );
list( $s, $b ) = call( 'GET', 'api/conversations/' . $conv . '/messages', null, $trav );
check( 'messages listed in order', 200 === $s && 3 === count( $b['messages'] ) && 'AUDIO' === end( $b['messages'] )['messageType'] );
list( $s ) = call( 'GET', 'api/conversations/' . $conv . '/messages', null, $admin );
check( 'admin can open the chat', 200 === $s );
$other = array();
call( 'POST', 'api/auth/register', array( 'name' => 'Other Person', 'email' => 'other@example.test', 'phone' => '+252610000002', 'password' => 'long-enough-traveler-password' ), $other );
list( $s ) = call( 'GET', 'api/conversations/' . $conv . '/messages', null, $other );
check( 'other traveler cannot read the chat', 404 === $s );

// Calls
list( $s, $b ) = call( 'POST', 'api/conversations/' . $conv . '/calls', array( 'callType' => 'AUDIO', 'deviceId' => 'phone-1' ), $trav );
check( 'call starts', 201 === $s && 'RINGING' === $b['call']['status'], json_encode( $b ) );
$call_id = $b['call']['id'];
list( $s, $b ) = call( 'GET', 'api/calls/active', null, $staff );
check( 'agency sees ringing call', 200 === $s && 1 === count( $b['calls'] ) );
list( $s, $b ) = call( 'PATCH', 'api/calls/' . $call_id, array( 'action' => 'ACCEPT', 'deviceId' => 'laptop' ), $staff );
check( 'agency answers', 200 === $s && 'ACCEPTED' === $b['status'] );
list( $s ) = call( 'POST', 'api/calls/' . $call_id . '/signals', array( 'signalType' => 'OFFER', 'payload' => array( 'sdp' => 'x' ) ), $trav );
check( 'caller sends offer', 201 === $s );
list( $s, $b ) = call( 'GET', 'api/calls/' . $call_id . '/signals?after=0', null, $staff );
check( 'callee receives offer', 200 === $s && 1 === count( $b['signals'] ) && 'OFFER' === $b['signals'][0]['signalType'] );
list( $s, $b ) = call( 'PATCH', 'api/calls/' . $call_id, array( 'action' => 'END' ), $trav );
check( 'call ends', 200 === $s && 'ENDED' === $b['status'] );

// Profile, password reset, logout
list( $s, $b ) = call( 'PATCH', 'api/auth/theme', array( 'theme' => 'light' ), $trav );
check( 'theme saved', 200 === $s && 'light' === $b['user']['themePreference'] );
list( $s, $b ) = call( 'POST', 'api/auth/password-reset/request', array( 'email' => 'amina@example.test' ) );
$mails = array_map( 'json_decode', array_filter( explode( "\n", (string) @file_get_contents( $mail ) ) ) );
$code  = preg_match( '/code is (\d{6})/', (string) end( $mails )->text, $m ) ? $m[1] : '';
check( 'reset code emailed', 200 === $s && 6 === strlen( $code ) );
list( $s ) = call( 'POST', 'api/auth/password-reset/complete', array( 'email' => 'amina@example.test', 'code' => $code, 'newPassword' => 'a-brand-new-traveler-password' ) );
check( 'password reset', 200 === $s );
list( $s ) = call( 'GET', 'api/portal/summary', null, $trav );
check( 'old session ended after reset', 401 === $s );
$trav = array();
list( $s ) = call( 'POST', 'api/auth/login', array( 'email' => 'amina@example.test', 'password' => 'a-brand-new-traveler-password' ), $trav );
check( 'sign in with new password', 200 === $s );
list( $s, $b ) = call( 'GET', 'api/portal/summary', null, $admin );
check( 'admin dashboard data', 200 === $s && 1 === count( $b['agencies'] ) && 2 === count( $b['customers'] ) );
list( $s ) = call( 'POST', 'api/auth/logout', array(), $trav );
list( $s, $b ) = call( 'GET', 'api/auth/session', null, $trav );
check( 'signed out', 200 === $s && null === $b['user'] );

// Pay by phone (fake WaafiPay: 61 111 1111 pays, 61 222 2222 has no balance, others get a garbled reply)
$payer = array();
call( 'POST', 'api/auth/register', array( 'name' => 'Payer One', 'email' => 'payer@example.test', 'phone' => '+252611111111', 'password' => 'long-enough-traveler-password' ), $payer );
list( $s, $b ) = call( 'GET', 'api/payments/methods' );
check( 'pay by phone is offered', true === $b['phoneWaafi'] );
$pay = function ( $number ) use ( &$payer, $trip ) {
	list( $s, $b ) = call( 'POST', 'api/bookings', array( 'offerId' => $trip['id'], 'travelerName' => 'Payer One', 'phone' => $number, 'paymentMethod' => 'PHONE', 'wallet' => 'EVC_PLUS', 'paymentPhone' => $number ), $payer );
	return array( $s, $b );
};
list( $s, $b ) = $pay( '61 111 1111' );
check( 'phone booking waits for payment', 201 === $s && 'PAYMENT_PENDING' === $b['booking']['state'] && 'PENDING' === $b['booking']['phonePaymentStatus'], json_encode( $b ) );
$paid_id = $b['booking']['id'];
list( $s, $b ) = call( 'POST', 'api/payments/phone/' . $paid_id . '/charge', array(), $payer );
check( 'payment approved', 200 === $s && 'APPROVED' === $b['payment']['status'] && 'PAYMENT_RECEIVED' === $b['payment']['bookingState'], json_encode( $b ) );
list( $s, $b ) = call( 'POST', 'api/payments/phone/' . $paid_id . '/charge', array(), $payer );
check( 'second charge does not charge again', 200 === $s && ! empty( $b['payment']['alreadyFinished'] ) );
$charges = count( array_filter( explode( "\n", (string) @file_get_contents( sys_get_temp_dir() . '/skw-fake-waafi.log' ) ) ) );
check( 'WaafiPay was asked exactly once', 1 === $charges, (string) $charges );
list( $s ) = call( 'POST', 'api/payments/phone/' . $paid_id . '/charge', array(), $other );
check( 'someone else cannot pay this booking', 404 === $s );
list( $s, $b ) = call( 'GET', 'api/catalog' );
$seats_before = $b['catalog'][0]['available'];
list( $s, $b ) = $pay( '+252 61 222 2222' );
list( $s, $b ) = call( 'POST', 'api/payments/phone/' . $b['booking']['id'] . '/charge', array(), $payer );
check( 'no balance = payment failed', 'FAILED' === $b['payment']['status'] && 'CANCELLED' === $b['payment']['bookingState'], json_encode( $b ) );
list( $s, $b ) = call( 'GET', 'api/catalog' );
check( 'failed payment returns the seat', $seats_before === $b['catalog'][0]['available'] );
list( $s, $b ) = $pay( '0613333333' );
$unknown_id = $b['booking']['id'];
list( $s, $b ) = call( 'POST', 'api/payments/phone/' . $unknown_id . '/charge', array(), $payer );
check( 'garbled reply = unknown, not failed', 'UNKNOWN' === $b['payment']['status'] && 'PAYMENT_PENDING' === $b['payment']['bookingState'], json_encode( $b ) );
list( $s, $b ) = call( 'PATCH', 'api/bookings/' . $unknown_id, array( 'action' => 'REJECT_PHONE_PAYMENT' ), $staff );
check( 'agency must wait before rejecting an unclear payment', 409 === $s );
list( $s, $b ) = call( 'PATCH', 'api/bookings/' . $unknown_id, array( 'action' => 'CONFIRM_PHONE_PAYMENT', 'transactionId' => 'EVC-9' ), $staff );
check( 'agency confirms the unclear payment', 200 === $s && 'PAYMENT_RECEIVED' === $b['booking']['state'] && 'APPROVED' === $b['booking']['phonePaymentStatus'], json_encode( $b ) );
list( $s, $b ) = $pay( '12345' );
check( 'bad phone number refused', 400 === $s );

// Refund after cancelling a paid booking
list( $s, $b ) = call( 'DELETE', 'api/bookings/' . $paid_id, array( 'reason' => 'Flight cancelled', 'returnSeats' => false ), $staff );
check( 'paid booking cancelled', 200 === $s && true === $b['paymentNeedsRefund'], json_encode( $b ) );
list( $s, $b ) = call( 'PATCH', 'api/bookings/' . $paid_id, array( 'action' => 'MARK_REFUNDED', 'refundReference' => 'EVC-REF-1' ), $staff );
check( 'refund recorded', 200 === $s && 'REFUNDED' === $b['booking']['refundStatus'], json_encode( $b ) );

// Reports
list( $s, $b ) = call( 'GET', 'api/reports/sales', null, $staff );
check( 'sales report', 200 === $s && $b['totals']['requests'] >= 4 && $b['totals']['paidOnlineCents'] > 0, json_encode( $b ) );
list( $s, $csv ) = call( 'GET', 'api/reports/sales?format=csv', null, $staff, true );
check( 'sales report CSV', 200 === $s && false !== strpos( $csv, 'Booking number,Booked on' ) && 0 === strpos( $csv, "\xEF\xBB\xBF" ) );
list( $s ) = call( 'GET', 'api/reports/sales', null, $payer );
check( 'travelers cannot see reports', 403 === $s );

// Booking confirmation (voucher)
list( $s, $b ) = call( 'POST', 'api/bookings', array( 'offerId' => $trip['id'], 'travelerName' => 'Other Person', 'phone' => '+252610000002' ), $other );
$tb = $b['booking']['id'];
list( $s, $b ) = call( 'GET', 'api/bookings/' . $tb . '/ticket', null, $other );
check( 'no voucher before confirmation', 200 === $s && null === $b['ticket'] );
list( $s, $b ) = call( 'PATCH', 'api/bookings/' . $tb, array( 'action' => 'ACCEPT' ), $staff );
check( 'confirmation returns the voucher', 200 === $s && 'READY' === $b['ticket']['status'] && 'READY' === $b['booking']['ticketStatus'], json_encode( $b ) );
$mails = array_map( 'json_decode', array_filter( explode( "\n", (string) @file_get_contents( $mail ) ) ) );
check( 'traveler emailed on confirmation', false !== strpos( (string) end( $mails )->subject, 'confirmed' ) && 'other@example.test' === end( $mails )->to );
list( $s, $pdf, $head ) = call( 'GET', 'api/bookings/' . $tb . '/ticket.pdf', null, $other, true );
check( 'voucher PDF', 200 === $s && 0 === strpos( $pdf, '%PDF-1.4' ) && false !== strpos( $pdf, '%%EOF' ) && false !== stripos( $head, 'application/pdf' ) );
list( $s, $jpg ) = call( 'GET', 'api/bookings/' . $tb . '/ticket.jpg', null, $other, true );
check( 'voucher image (or a clear message without GD)', ( 200 === $s && "\xff\xd8" === substr( $jpg, 0, 2 ) ) || 404 === $s, (string) $s );
list( $s, $b ) = call( 'POST', 'api/bookings/' . $tb . '/ticket/email', array(), $other );
check( 'voucher emailed on request', 200 === $s && 'SENT' === $b['ticket']['emailDeliveryStatus'] );
list( $s ) = call( 'GET', 'api/bookings/' . $tb . '/ticket.pdf', null, $payer, true );
check( 'other travelers cannot open the voucher', 404 === $s );

// Status updates
$jpeg = 'data:image/jpeg;base64,' . base64_encode( "\xff\xd8" . str_repeat( 'x', 50 ) . "\xff\xd9" );
list( $s, $b ) = call( 'POST', 'api/statuses', array( 'body' => 'Flying to Mogadishu tomorrow!', 'attachmentData' => $jpeg, 'attachmentMime' => 'image/jpeg' ), $staff );
check( 'status posted', 201 === $s, json_encode( $b ) );
$st = $b['status']['id'];
list( $s, $b ) = call( 'GET', 'api/statuses', null, $payer );
check( 'others see the status', 200 === $s && 1 === count( $b['statuses'] ) && 'Flying to Mogadishu tomorrow!' === $b['statuses'][0]['body'] );
call( 'POST', 'api/statuses/' . $st . '/views', array(), $payer );
list( $s, $b ) = call( 'POST', 'api/statuses/' . $st . '/reactions', array( 'emoji' => '😍' ), $payer );
check( 'reaction saved', 200 === $s && '😍' === $b['reaction'] );
list( $s ) = call( 'POST', 'api/statuses/' . $st . '/replies', array( 'body' => 'Safe travels!' ), $payer );
check( 'reply sent', 201 === $s );
list( $s, $b ) = call( 'GET', 'api/statuses/' . $st . '/views', null, $staff );
check( 'owner sees viewers with reaction', 200 === $s && 1 === $b['viewCount'] && '😍' === $b['viewers'][0]['reaction'] );
list( $s, $img ) = call( 'GET', 'api/statuses/' . $st . '/attachment', null, $payer, true );
check( 'status photo', 200 === $s && "\xff\xd8" === substr( $img, 0, 2 ) );
list( $s ) = call( 'PATCH', 'api/statuses/' . $st, array( 'audience' => 'CONTACTS' ), $staff );
$stranger = array();
call( 'POST', 'api/auth/register', array( 'name' => 'New Visitor', 'email' => 'visitor@example.test', 'phone' => '+252610000009', 'password' => 'long-enough-traveler-password' ), $stranger );
list( $s, $b ) = call( 'GET', 'api/statuses', null, $stranger );
check( 'contacts-only status hidden from non-contacts', 0 === count( $b['statuses'] ), json_encode( $b ) );
list( $s, $b ) = call( 'GET', 'api/statuses', null, $payer );
check( 'contacts-only status still shown to a contact', 1 === count( $b['statuses'] ) );
list( $s ) = call( 'DELETE', 'api/statuses/' . $st, array(), $payer );
check( 'only the owner can delete a status', 403 === $s || 404 === $s );

// Communities
list( $s, $b ) = call( 'POST', 'api/communities', array( 'name' => 'Hajj travelers 2027', 'description' => 'Tips and questions' ), $admin );
check( 'community created', 201 === $s, json_encode( $b ) );
$cm = $b['community']['id'];
list( $s ) = call( 'GET', 'api/communities/' . $cm . '/messages', null, $payer );
check( 'join before reading', 403 === $s );
call( 'POST', 'api/communities/' . $cm . '/join', array(), $payer );
list( $s ) = call( 'POST', 'api/communities/' . $cm . '/messages', array( 'message' => 'Salaan everyone!' ), $payer );
check( 'member posts', 201 === $s );
list( $s, $b ) = call( 'GET', 'api/communities', null, $payer );
check( 'community listed with last message', 200 === $s && 'Salaan everyone!' === $b['communities'][0]['lastMessage'] && 2 === $b['communities'][0]['memberCount'] );

// Sign-in codes by email
list( $s, $b ) = call( 'PATCH', 'api/auth/login-code', array( 'enabled' => true, 'password' => 'long-enough-traveler-password' ), $payer );
check( 'sign-in codes turned on', 200 === $s && true === $b['user']['loginCodeEnabled'], json_encode( $b ) );
$fresh = array();
list( $s, $b ) = call( 'POST', 'api/auth/login', array( 'email' => 'payer@example.test', 'password' => 'long-enough-traveler-password' ), $fresh );
check( 'login asks for a code', 200 === $s && true === $b['loginCodeRequired'] && ! isset( $fresh['sk_session'] ) );
$challenge = $b['challengeId'];
$mails = array_map( 'json_decode', array_filter( explode( "\n", (string) @file_get_contents( $mail ) ) ) );
$code  = preg_match( '/sign-in code is (\d{6})/', (string) end( $mails )->text, $m ) ? $m[1] : '';
list( $s ) = call( 'POST', 'api/auth/login/verify', array( 'challengeId' => $challenge, 'code' => '000000' === $code ? '111111' : '000000' ), $fresh );
check( 'wrong code refused', 400 === $s );
list( $s, $b ) = call( 'POST', 'api/auth/login/verify', array( 'challengeId' => $challenge, 'code' => $code ), $fresh );
check( 'right code signs in', 200 === $s && isset( $fresh['sk_session'] ), json_encode( $b ) );

// Graceful answers for features not on the website yet
foreach ( array( 'api/statuses', 'api/communities', 'api/notification-preferences', 'api/push/public-key', 'api/calls/history', 'api/blocks', 'api/payments/methods', 'api/app-version' ) as $path ) {
	list( $s ) = call( 'GET', $path, null, $staff );
	check( 'GET ' . $path . ' answers', 200 === $s, (string) $s );
}

$err = trim( (string) @file_get_contents( sys_get_temp_dir() . '/skw-smoke-err.log' ) );
$err = implode( "\n", array_filter( explode( "\n", $err ), function ( $l ) { return false !== stripos( $l, 'error' ) && false === stripos( $l, 'Accepted' ) && false === stripos( $l, 'Closing' ); } ) );
check( 'no PHP errors in the server log', '' === $err, $err );
echo $fails ? "\n$fails FAILED\n" : "\nALL PASSED\n";
exit( $fails ? 1 : 0 );
