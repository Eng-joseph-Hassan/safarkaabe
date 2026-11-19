/* ANFAC MEDIA Shop: shows a "check your phone" message while a phone payment runs, and stops double submits. */
( function () {
	'use strict';
	document.addEventListener( 'submit', function ( event ) {
		var form = event.target;
		if ( ! form || ! form.matches || ! form.matches( '[data-amsk-checkout]' ) ) {
			return;
		}
		if ( form.dataset.amskSubmitted === '1' ) {
			event.preventDefault();
			return;
		}
		form.dataset.amskSubmitted = '1';
		var button = form.querySelector( 'button[type="submit"]' );
		if ( button ) {
			button.disabled = true;
		}
		var chosen = form.querySelector( 'input[name="payment_method"]:checked' );
		var waiting = form.querySelector( '.amsk-waiting' );
		if ( chosen && chosen.hasAttribute( 'data-amsk-phone-pay' ) && waiting ) {
			waiting.textContent = ( window.amskText && window.amskText.waiting ) || 'Check your phone and enter your PIN to approve the payment.';
			waiting.hidden = false;
		}
	} );
	// If the visitor comes back with the browser's Back button, allow submitting again.
	window.addEventListener( 'pageshow', function () {
		document.querySelectorAll( '[data-amsk-checkout]' ).forEach( function ( form ) {
			form.dataset.amskSubmitted = '';
			var button = form.querySelector( 'button[type="submit"]' );
			if ( button ) {
				button.disabled = false;
			}
		} );
	} );
}() );
