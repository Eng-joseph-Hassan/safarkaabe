<?php
/**
 * Booking confirmation (voucher) for confirmed bookings: PDF, JPG image and email.
 * The PDF and the image are drawn here, with no outside libraries.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

/** Ticket info for a confirmed booking (same fields the app shows), or null. */
function skw_ticket_info( $b ) {
	if ( ! $b || 'ACCEPTED' !== $b['state'] ) {
		return null;
	}
	$file = 'SAFAR-KAABE-Booking-Voucher-' . $b['reference'];
	$pdf  = skw_base() . 'api/bookings/' . rawurlencode( $b['id'] ) . '/ticket.pdf';
	$jpg  = skw_base() . 'api/bookings/' . rawurlencode( $b['id'] ) . '/ticket.jpg';
	return array(
		'id' => 'voucher-' . $b['id'], 'bookingId' => $b['id'], 'documentReference' => 'SKV-' . substr( $b['reference'], 3 ), 'version' => 1,
		'documentType' => 'BOOKING_CONFIRMATION', 'status' => 'READY', 'fileName' => $file . '.pdf', 'mimeType' => 'application/pdf',
		'issuedAt' => $b['updated_at'], 'previewUrl' => $pdf, 'downloadUrl' => $pdf . '?download=1', 'jpgPreviewUrl' => $jpg, 'jpgDownloadUrl' => $jpg . '?download=1',
		'jpgFileName' => $file . '.jpg', 'emailDeliveryStatus' => null, 'emailSentAt' => null,
	);
}

/** The lines printed on the voucher. */
function skw_ticket_fields( $b ) {
	$fin = json_decode( (string) $b['financials_json'], true );
	return array(
		array( 'Booking number', $b['reference'] ),
		array( 'Booking code', $b['pnr'] ),
		array( 'Traveler', $b['traveler_name'] ),
		array( 'Phone', $b['phone'] ),
		array( 'Trip', $b['offer_title'] ),
		array( 'Route', isset( $b['route_badge'] ) && $b['route_badge'] ? str_replace( array( '── ✈ ──', '•' ), array( '->', '-' ), $b['route_badge'] ) : '' ),
		array( 'Travel date', $b['travel_date'] ? $b['travel_date'] : 'Flexible date' ),
		array( 'Seats', (string) (int) $b['seat_count'] ),
		array( 'Baggage', isset( $b['baggage'] ) && $b['baggage'] ? $b['baggage'] : '' ),
		array( 'Travel agency', $b['agency_name'] ),
		array( 'Total', '$' . skw_money( isset( $fin['customerGrandTotalCents'] ) ? $fin['customerGrandTotalCents'] : 0 ) . ' USD' . ( 'APPROVED' === $b['pp_status'] ? ' - paid by phone' : '' ) ),
		array( 'Confirmed on', substr( (string) $b['updated_at'], 0, 10 ) ),
	);
}

/** Text in the PDF's simple font encoding (Windows-1252). */
function skw_pdf_text( $text ) {
	$text = (string) $text;
	$conv = function_exists( 'iconv' ) ? @iconv( 'UTF-8', 'Windows-1252//TRANSLIT//IGNORE', $text ) : false; // phpcs:ignore
	$text = false === $conv ? preg_replace( '/[^\x20-\x7e]/', '?', $text ) : $conv;
	return '(' . str_replace( array( '\\', '(', ')', "\r", "\n" ), array( '\\\\', '\\(', '\\)', ' ', ' ' ), $text ) . ')';
}

function skw_ticket_pdf( $b ) {
	$ops   = array();
	$color = function ( $hex ) {
		return sprintf( '%.3f %.3f %.3f', hexdec( substr( $hex, 0, 2 ) ) / 255, hexdec( substr( $hex, 2, 2 ) ) / 255, hexdec( substr( $hex, 4, 2 ) ) / 255 );
	};
	$text  = function ( $x, $y, $size, $bold, $hex, $value ) use ( &$ops, $color ) {
		$ops[] = 'BT ' . $color( $hex ) . ' rg /' . ( $bold ? 'F2' : 'F1' ) . ' ' . $size . ' Tf ' . $x . ' ' . $y . ' Td ' . skw_pdf_text( $value ) . ' Tj ET';
	};
	$rect  = function ( $x, $y, $w, $h, $hex ) use ( &$ops, $color ) {
		$ops[] = $color( $hex ) . ' rg ' . $x . ' ' . $y . ' ' . $w . ' ' . $h . ' re f';
	};
	// Page 595 x 842 (A4). Header band, magenta accent, details card, footer.
	$rect( 0, 722, 595, 120, '0b0f1f' );
	$rect( 0, 718, 595, 4, 'c909e6' );
	$text( 40, 790, 26, true, 'ffffff', 'SAFAR KAABE' );
	$text( 40, 768, 11, false, 'c8cde0', 'Booking confirmation - Travel voucher' );
	$text( 400, 790, 10, false, 'c8cde0', 'Voucher' );
	$text( 400, 772, 14, true, 'ffffff', 'SKV-' . substr( $b['reference'], 3 ) );
	$rect( 40, 664, 515, 38, 'f5d9fb' );
	$text( 54, 678, 13, true, '6b0480', 'CONFIRMED by ' . $b['agency_name'] );
	$y = 630;
	foreach ( skw_ticket_fields( $b ) as $i => $field ) {
		if ( '' === $field[1] ) {
			continue;
		}
		if ( 0 === $i % 2 ) {
			$rect( 40, $y - 9, 515, 30, 'f4f5f9' );
		}
		$text( 54, $y, 10, false, '5b6478', $field[0] );
		$text( 200, $y, 12, true, '0f172a', mb_substr( $field[1], 0, 60 ) );
		$y -= 32;
	}
	$y -= 10;
	$text( 40, $y, 10, false, '334155', 'Bring this voucher and your ID or passport when you travel.' );
	$text( 40, $y - 16, 10, false, '334155', 'Questions? Message ' . $b['agency_name'] . ' in the SAFAR KAABE app.' );
	$rect( 0, 0, 595, 44, '0b0f1f' );
	$text( 40, 17, 9, false, 'c8cde0', 'SAFAR KAABE - One Platform. All Agencies. - ' . skw_app_url( '' ) );
	$stream  = implode( "\n", $ops );
	$objects = array(
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
		'<< /Length ' . strlen( $stream ) . " >>\nstream\n" . $stream . "\nendstream",
		'<< /Title ' . skw_pdf_text( 'SAFAR KAABE booking ' . $b['reference'] ) . ' /Producer (SAFAR KAABE) >>',
	);
	$pdf     = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
	$offsets = array();
	foreach ( $objects as $n => $obj ) {
		$offsets[] = strlen( $pdf );
		$pdf      .= ( $n + 1 ) . " 0 obj\n" . $obj . "\nendobj\n";
	}
	$xref = strlen( $pdf );
	$pdf .= 'xref' . "\n0 " . ( count( $objects ) + 1 ) . "\n0000000000 65535 f \n";
	foreach ( $offsets as $o ) {
		$pdf .= sprintf( "%010d 00000 n \n", $o );
	}
	return $pdf . 'trailer' . "\n<< /Size " . ( count( $objects ) + 1 ) . ' /Root 1 0 R /Info 7 0 R >>' . "\nstartxref\n" . $xref . "\n%%EOF\n";
}

/** JPG image of the voucher (needs the PHP GD extension, standard on WordPress hosting). */
function skw_ticket_jpg( $b ) {
	if ( ! function_exists( 'imagecreatetruecolor' ) || ! function_exists( 'imagejpeg' ) ) {
		throw new SKW_Http_Error( 404, 'The voucher image is not available on this server. Open the PDF instead.' );
	}
	// Drawn at half size with the built-in font, then enlarged, so the text is big enough to read.
	$w   = 400;
	$h   = 600;
	$im  = imagecreatetruecolor( $w, $h );
	$hex = function ( $c ) use ( $im ) {
		return imagecolorallocate( $im, hexdec( substr( $c, 0, 2 ) ), hexdec( substr( $c, 2, 2 ) ), hexdec( substr( $c, 4, 2 ) ) );
	};
	$ascii = function ( $t ) {
		$c = function_exists( 'iconv' ) ? @iconv( 'UTF-8', 'ASCII//TRANSLIT//IGNORE', (string) $t ) : false; // phpcs:ignore
		return false === $c ? preg_replace( '/[^\x20-\x7e]/', '?', (string) $t ) : $c;
	};
	imagefill( $im, 0, 0, $hex( 'ffffff' ) );
	imagefilledrectangle( $im, 0, 0, $w, 78, $hex( '0b0f1f' ) );
	imagefilledrectangle( $im, 0, 78, $w, 81, $hex( 'c909e6' ) );
	imagestring( $im, 5, 16, 16, 'SAFAR KAABE', $hex( 'ffffff' ) );
	imagestring( $im, 2, 16, 38, 'Booking confirmation - Travel voucher', $hex( 'c8cde0' ) );
	imagestring( $im, 3, 16, 56, 'SKV-' . substr( $b['reference'], 3 ), $hex( 'f3baff' ) );
	imagefilledrectangle( $im, 12, 92, $w - 12, 116, $hex( 'f5d9fb' ) );
	imagestring( $im, 3, 20, 97, $ascii( mb_substr( 'CONFIRMED by ' . $b['agency_name'], 0, 46 ) ), $hex( '6b0480' ) );
	$y = 128;
	foreach ( skw_ticket_fields( $b ) as $i => $f ) {
		if ( '' === $f[1] ) {
			continue;
		}
		if ( 0 === $i % 2 ) {
			imagefilledrectangle( $im, 12, $y - 3, $w - 12, $y + 29, $hex( 'f4f5f9' ) );
		}
		imagestring( $im, 2, 20, $y, $ascii( $f[0] ), $hex( '5b6478' ) );
		imagestring( $im, 3, 20, $y + 13, $ascii( mb_substr( $f[1], 0, 46 ) ), $hex( '0f172a' ) );
		$y += 34;
	}
	imagestring( $im, 2, 16, $y + 4, 'Bring this voucher and your ID or passport.', $hex( '334155' ) );
	imagefilledrectangle( $im, 0, $h - 26, $w, $h, $hex( '0b0f1f' ) );
	imagestring( $im, 2, 16, $h - 19, 'SAFAR KAABE - One Platform. All Agencies.', $hex( 'c8cde0' ) );
	$big = imagecreatetruecolor( $w * 2, $h * 2 );
	imagecopyresampled( $big, $im, 0, 0, 0, 0, $w * 2, $h * 2, $w, $h );
	ob_start();
	imagejpeg( $big, null, 90 );
	$jpg = ob_get_clean();
	imagedestroy( $im );
	imagedestroy( $big );
	return $jpg;
}

function skw_ticket_booking( $id ) {
	$user = skw_require_role();
	$b    = skw_owned_booking( $id, $user );
	return array( $user, $b );
}

SKW_Router::add( '*', '#^/api/bookings/([0-9a-z-]+)/ticket(\.pdf|\.jpg|/generate|/email)?$#i', function ( $p, $req ) {
	list( $user, $b ) = skw_ticket_booking( $p[0] );
	$what             = isset( $p[1] ) ? strtolower( $p[1] ) : '';
	$ticket           = skw_ticket_info( $b );
	if ( '' === $what || '/generate' === $what ) {
		if ( '/generate' === $what ) {
			skw_require_csrf();
		}
		return $ticket ? array( 'ticket' => $ticket ) : array( 'ticket' => null, 'status' => 'PENDING' );
	}
	if ( ! $ticket ) {
		throw new SKW_Http_Error( 404, 'The booking confirmation is ready after the agency confirms the booking.' );
	}
	$download = isset( $req['query']['download'] );
	if ( '.pdf' === $what ) {
		skw_send_raw( 200, 'application/pdf', skw_ticket_pdf( $b ), array( 'Content-Disposition' => ( $download ? 'attachment' : 'inline' ) . '; filename="' . $ticket['fileName'] . '"' ) );
	}
	if ( '.jpg' === $what ) {
		skw_send_raw( 200, 'image/jpeg', skw_ticket_jpg( $b ), array( 'Content-Disposition' => ( $download ? 'attachment' : 'inline' ) . '; filename="' . $ticket['jpgFileName'] . '"' ) );
	}
	// Email the confirmation to the traveler.
	skw_require_csrf();
	$to = $b['traveler_email'] ? $b['traveler_email'] : (string) SKW_DB::get_var( 'SELECT email FROM {users} WHERE id = ?', array( $b['customer_id'] ) );
	if ( ! $to ) {
		throw new SKW_Http_Error( 400, 'This booking has no traveler email address.' );
	}
	$lines = array();
	foreach ( skw_ticket_fields( $b ) as $f ) {
		if ( '' !== $f[1] ) {
			$lines[] = $f[0] . ': ' . $f[1];
		}
	}
	$sent = skw_mail( $to, 'Your SAFAR KAABE booking is confirmed – ' . $b['reference'], "Your booking is confirmed.\n\n" . implode( "\n", $lines ) . "\n\nView or download your voucher in the SAFAR KAABE app:\n" . skw_app_url( '?booking=' . rawurlencode( $b['id'] ) ) . "\n\nBring your ID or passport when you travel." );
	if ( ! $sent ) {
		throw new SKW_Http_Error( 503, 'The email could not be sent right now. Try again later.' );
	}
	$ticket['emailDeliveryStatus'] = 'SENT';
	$ticket['emailSentAt']         = skw_now();
	return array( 'ticket' => $ticket, 'message' => 'Booking confirmation sent to ' . $to . '.' );
} );

/** Sends the confirmation email automatically when the agency confirms a booking. */
function skw_ticket_email_on_accept( $booking_id ) {
	$b  = skw_load_booking( $booking_id );
	$to = $b && $b['traveler_email'] ? $b['traveler_email'] : '';
	if ( $to && skw_ticket_info( $b ) ) {
		skw_mail( $to, 'Your SAFAR KAABE booking is confirmed – ' . $b['reference'], 'Good news! ' . $b['agency_name'] . ' confirmed your booking ' . $b['reference'] . ' for ' . $b['offer_title'] . ( $b['travel_date'] ? ' on ' . $b['travel_date'] : '' ) . ".\n\nOpen your voucher in the SAFAR KAABE app:\n" . skw_app_url( '?booking=' . rawurlencode( $b['id'] ) ) );
	}
}
