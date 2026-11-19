<?php
/**
 * Setup, sign in, register, profile, password and app settings endpoints.
 */

if ( ! defined( 'SKW_RUNNING' ) ) {
	exit;
}

function skw_phone_pay_available() {
	$waafi  = (int) skw_config( 'waafi_enabled', 0 ) === 1 && skw_config( 'waafi_merchant_uid' ) && skw_config( 'waafi_api_user_id' ) && skw_config( 'waafi_api_key' );
	$edahab = (int) skw_config( 'edahab_enabled', 0 ) === 1 && skw_config( 'edahab_agent_code' ) && skw_config( 'edahab_api_key' ) && skw_config( 'edahab_secret_key' );
	return array( 'phoneWaafi' => (bool) $waafi, 'phoneEdahab' => (bool) $edahab, 'autoRefunds' => false );
}

SKW_Router::add( 'GET', '#^/api/setup/status$#', function () {
	$configured = (bool) SKW_DB::get_var( "SELECT 1 FROM {users} WHERE role = 'SUPER_ADMIN' LIMIT 1" );
	return array( 'configured' => $configured, 'setupTokenRequired' => ! $configured );
} );

SKW_Router::add( 'GET', '#^/api/app-version$#', function () {
	$index = SKW_DIR . 'app/index.html';
	return array( 'releaseId' => ( defined( 'SKW_VERSION' ) ? SKW_VERSION : 'test' ) . '-' . ( is_file( $index ) ? filemtime( $index ) : 0 ) );
} );

SKW_Router::add( 'GET', '#^/api/payments/methods$#', function () {
	return array_merge( array( 'waafiEnabled' => false, 'waafiEnvironment' => null ), skw_phone_pay_available() );
} );

// Live updates use polling on this server.
SKW_Router::add( 'GET', '#^/api/catalog/realtime$#', function () {
	return array( 'supported' => false );
} );
SKW_Router::add( 'GET', '#^/api/(catalog|notifications)/stream$#', function () {
	throw new SKW_Http_Error( 404, 'Live updates are not available. The app refreshes automatically.' );
} );

SKW_Router::add( 'POST', '#^/api/setup/admin$#', function () {
	$body     = skw_body();
	$name     = skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Name' );
	$email    = skw_normalize_email( isset( $body['email'] ) ? $body['email'] : null );
	$password = skw_validate_password( isset( $body['password'] ) ? $body['password'] : null );
	$token    = (string) skw_config( 'setup_token', '' );
	$given    = isset( $body['setupToken'] ) ? (string) $body['setupToken'] : '';
	if ( '' === $token ) {
		throw new SKW_Http_Error( 503, 'First-time setup is not ready yet. Open WordPress → SAFAR KAABE to see the setup token.' );
	}
	if ( ! hash_equals( $token, $given ) ) {
		throw new SKW_Http_Error( 403, 'Enter the one-time administrator setup token shown in WordPress → SAFAR KAABE.' );
	}
	$admin = array( 'id' => skw_uuid(), 'email' => $email, 'name' => $name, 'phone' => '', 'role' => 'SUPER_ADMIN', 'agency_id' => null );
	SKW_DB::transaction( function () use ( $admin, $password ) {
		if ( SKW_DB::get_var( "SELECT 1 FROM {users} WHERE role = 'SUPER_ADMIN' LIMIT 1" ) ) {
			throw new SKW_Http_Error( 409, 'Super Admin setup has already been completed. Sign in instead.' );
		}
		if ( SKW_DB::get_var( 'SELECT 1 FROM {users} WHERE email = ?', array( $admin['email'] ) ) ) {
			throw new SKW_Http_Error( 409, 'An account with that email already exists. Use a different email address.' );
		}
		SKW_DB::insert( 'users', array_merge( $admin, array( 'password_hash' => skw_hash_password( $password ), 'created_at' => skw_now() ) ) );
		skw_audit( $admin['id'], 'INITIAL_SUPER_ADMIN_CREATED', $admin['email'] );
	} );
	skw_create_session( $admin );
	skw_json( 201, array( 'user' => skw_public_user( $admin ) ) );
} );

SKW_Router::add( 'POST', '#^/api/auth/register$#', function () {
	$body     = skw_body();
	$name     = skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Name' );
	$email    = skw_normalize_email( isset( $body['email'] ) ? $body['email'] : null );
	$phone    = skw_require_string( isset( $body['phone'] ) ? $body['phone'] : null, 'Phone', 40 );
	$password = skw_validate_password( isset( $body['password'] ) ? $body['password'] : null );
	if ( ! skw_rate_limit( 'register:' . skw_req( 'ip' ), 20, 3600 ) ) {
		throw new SKW_Http_Error( 429, 'Too many new accounts from this network. Try again later.' );
	}
	if ( SKW_DB::get_var( 'SELECT 1 FROM {users} WHERE email = ?', array( $email ) ) ) {
		throw new SKW_Http_Error( 409, 'An account with that email already exists. Sign in instead.' );
	}
	$user = array( 'id' => skw_uuid(), 'email' => $email, 'name' => $name, 'phone' => $phone, 'role' => 'CLIENT', 'agency_id' => null );
	try {
		SKW_DB::insert( 'users', array_merge( $user, array( 'password_hash' => skw_hash_password( $password ), 'created_at' => skw_now() ) ) );
	} catch ( Exception $error ) {
		if ( SKW_DB::is_duplicate( $error ) ) {
			throw new SKW_Http_Error( 409, 'An account with that email already exists. Sign in instead.' );
		}
		throw $error;
	}
	skw_audit( $user['id'], 'CUSTOMER_ACCOUNT_REGISTERED', $email );
	skw_create_session( $user );
	skw_json( 201, array( 'user' => skw_public_user( $user ) ) );
} );

SKW_Router::add( 'POST', '#^/api/auth/login$#', function () {
	$key = 'login:' . skw_req( 'ip' );
	if ( skw_rate_limited( $key ) >= 10 ) {
		throw new SKW_Http_Error( 429, 'Too many sign-in attempts. Try again in a few minutes.' );
	}
	$body     = skw_body();
	$email    = skw_normalize_email( isset( $body['email'] ) ? $body['email'] : null );
	$password = skw_require_string( isset( $body['password'] ) ? $body['password'] : null, 'Password', 256 );
	$account  = SKW_DB::get_row( 'SELECT * FROM {users} WHERE email = ?', array( $email ) );
	if ( ! $account || ! password_verify( $password, $account['password_hash'] ) ) {
		skw_rate_limit( $key, 10, 300 );
		throw new SKW_Http_Error( 401, 'Email or password is incorrect.' );
	}
	if ( 'AGENCY' === $account['role'] && ! SKW_DB::get_var( "SELECT 1 FROM {agencies} WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1", array( $account['agency_id'] ) ) ) {
		throw new SKW_Http_Error( 403, 'This agency account is pending approval or suspended. Contact SAFAR KAABE support.' );
	}
	skw_rate_clear( $key );
	if ( 1 === (int) $account['login_code_enabled'] ) {
		$code  = (string) random_int( 100000, 999999 );
		$token = rtrim( strtr( base64_encode( random_bytes( 24 ) ), '+/', '-_' ), '=' );
		SKW_DB::query( 'DELETE FROM {login_challenges} WHERE user_id = ? OR expires_at < ?', array( $account['id'], time() ) );
		SKW_DB::insert( 'login_challenges', array( 'id' => hash( 'sha256', $token ), 'user_id' => $account['id'], 'code_hash' => password_hash( $code, PASSWORD_DEFAULT ), 'expires_at' => time() + 600, 'attempts' => 0, 'created_at' => time() ) );
		if ( ! skw_mail( $account['email'], 'Your SAFAR KAABE sign-in code', 'Your SAFAR KAABE sign-in code is ' . $code . '. It expires in 10 minutes. If you did not just try to sign in, change your password now.' ) ) {
			SKW_DB::query( 'DELETE FROM {login_challenges} WHERE user_id = ?', array( $account['id'] ) );
			throw new SKW_Http_Error( 503, 'We could not email your sign-in code. Try again in a few minutes.' );
		}
		list( $name, $domain ) = array_pad( explode( '@', $account['email'], 2 ), 2, '' );
		return array( 'loginCodeRequired' => true, 'challengeId' => $token, 'emailHint' => mb_substr( $name, 0, 2 ) . str_repeat( '•', max( 1, min( 6, mb_strlen( $name ) - 2 ) ) ) . '@' . $domain );
	}
	skw_create_session( $account );
	skw_audit( $account['id'], 'AUTHENTICATED', $account['email'] );
	return array( 'user' => skw_public_user( $account ) );
} );

SKW_Router::add( 'POST', '#^/api/auth/login/verify$#', function () {
	$body      = skw_body();
	$token     = skw_require_string( isset( $body['challengeId'] ) ? $body['challengeId'] : null, 'Sign-in request', 200 );
	$code      = preg_replace( '/\s+/', '', (string) ( isset( $body['code'] ) ? $body['code'] : '' ) );
	$id        = hash( 'sha256', $token );
	$challenge = SKW_DB::get_row( 'SELECT * FROM {login_challenges} WHERE id = ?', array( $id ) );
	if ( ! $challenge || (int) $challenge['expires_at'] < time() ) {
		SKW_DB::query( 'DELETE FROM {login_challenges} WHERE id = ?', array( $id ) );
		throw new SKW_Http_Error( 400, 'This code has expired. Sign in again to get a new code.' );
	}
	SKW_DB::query( 'UPDATE {login_challenges} SET attempts = attempts + 1 WHERE id = ?', array( $id ) );
	if ( (int) $challenge['attempts'] + 1 > 5 || ! skw_rate_limit( 'login-code:' . $challenge['user_id'], 15, 900 ) ) {
		SKW_DB::query( 'DELETE FROM {login_challenges} WHERE user_id = ?', array( $challenge['user_id'] ) );
		throw new SKW_Http_Error( 429, 'Too many wrong codes. Sign in again to get a new code.' );
	}
	if ( ! preg_match( '/^\d{6}$/', $code ) || ! password_verify( $code, $challenge['code_hash'] ) ) {
		throw new SKW_Http_Error( 400, 'That code is not correct. Check the email and try again.' );
	}
	SKW_DB::query( 'DELETE FROM {login_challenges} WHERE id = ?', array( $id ) );
	$account = skw_user_by_id( $challenge['user_id'] );
	if ( ! $account ) {
		throw new SKW_Http_Error( 400, 'This code has expired. Sign in again to get a new code.' );
	}
	if ( 'AGENCY' === $account['role'] && ! SKW_DB::get_var( "SELECT 1 FROM {agencies} WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1", array( $account['agency_id'] ) ) ) {
		throw new SKW_Http_Error( 403, 'This agency account is pending approval or suspended. Contact SAFAR KAABE support.' );
	}
	skw_create_session( $account );
	skw_audit( $account['id'], 'AUTHENTICATED', $account['email'] . ' (with sign-in code)' );
	return array( 'user' => skw_public_user( $account ) );
} );

SKW_Router::add( 'GET', '#^/api/auth/session$#', function () {
	global $skw_mailer;
	$user = skw_current_user();
	return array( 'user' => $user ? skw_public_user( $user ) : null, 'loginCodesAvailable' => is_callable( $skw_mailer ) );
} );

SKW_Router::add( 'POST', '#^/api/auth/logout$#', function () {
	$user = skw_current_user();
	if ( $user ) {
		skw_require_csrf();
		SKW_DB::query( 'DELETE FROM {sessions} WHERE id_hash = ?', array( $user['session_hash'] ) );
	}
	skw_clear_session_cookies();
	return array( 'ok' => true );
} );

SKW_Router::add( 'PATCH', '#^/api/auth/profile$#', function () {
	$user  = skw_mutation();
	$body  = skw_body();
	$name  = skw_require_string( isset( $body['name'] ) ? $body['name'] : null, 'Name' );
	$phone = skw_require_string( isset( $body['phone'] ) ? $body['phone'] : null, 'Phone', 40 );
	SKW_DB::update( 'users', array( 'name' => $name, 'phone' => $phone ), array( 'id' => $user['id'] ) );
	skw_audit( $user['id'], 'ACCOUNT_PROFILE_UPDATED', $user['email'] );
	return array( 'user' => skw_public_user( array_merge( $user, array( 'name' => $name, 'phone' => $phone ) ) ) );
} );

SKW_Router::add( 'PUT', '#^/api/auth/avatar$#', function () {
	$user = skw_mutation();
	$body = skw_body( 400000 );
	$mime = skw_require_string( isset( $body['mime'] ) ? $body['mime'] : null, 'Image type', 32 );
	$data = array_key_exists( 'data', $body ) && null === $body['data'] ? null : skw_validate_image( isset( $body['data'] ) ? $body['data'] : null, $mime );
	SKW_DB::update( 'users', array( 'avatar_mime' => $data ? $mime : null, 'avatar_data' => $data ), array( 'id' => $user['id'] ) );
	skw_audit( $user['id'], $data ? 'ACCOUNT_AVATAR_UPDATED' : 'ACCOUNT_AVATAR_REMOVED', $user['email'] );
	return array( 'user' => skw_public_user( array_merge( $user, array( 'avatar_mime' => $data ? $mime : null, 'avatar_data' => $data ) ) ) );
} );

SKW_Router::add( 'PUT', '#^/api/agency/logo$#', function () {
	$user = skw_mutation( array( 'AGENCY' ) );
	$body = skw_body( 400000 );
	$mime = skw_require_string( isset( $body['mime'] ) ? $body['mime'] : null, 'Image type', 32 );
	$data = array_key_exists( 'data', $body ) && null === $body['data'] ? null : skw_validate_image( isset( $body['data'] ) ? $body['data'] : null, $mime );
	SKW_DB::update( 'agencies', array( 'logo_mime' => $data ? $mime : null, 'logo_data' => $data ), array( 'id' => $user['agency_id'] ) );
	skw_audit( $user['id'], $data ? 'AGENCY_LOGO_UPDATED' : 'AGENCY_LOGO_REMOVED', $user['agency_id'] );
	return array( 'agency' => array( 'id' => $user['agency_id'], 'logoMime' => $data ? $mime : null, 'logoData' => $data ) );
} );

SKW_Router::add( 'POST', '#^/api/auth/password$#', function () {
	$user    = skw_mutation();
	$body    = skw_body();
	$current = skw_require_string( isset( $body['currentPassword'] ) ? $body['currentPassword'] : null, 'Current password', 256 );
	$new     = skw_validate_password( isset( $body['newPassword'] ) ? $body['newPassword'] : null );
	if ( ! password_verify( $current, $user['password_hash'] ) ) {
		throw new SKW_Http_Error( 401, 'Current password is incorrect.' );
	}
	if ( $current === $new ) {
		throw new SKW_Http_Error( 400, 'Choose a new password that is different from your current password.' );
	}
	SKW_DB::transaction( function () use ( $user, $new ) {
		SKW_DB::update( 'users', array( 'password_hash' => skw_hash_password( $new ) ), array( 'id' => $user['id'] ) );
		SKW_DB::query( 'DELETE FROM {sessions} WHERE user_id = ? AND id_hash <> ?', array( $user['id'], $user['session_hash'] ) );
		skw_audit( $user['id'], 'ACCOUNT_PASSWORD_CHANGED', $user['email'] );
	} );
	return array( 'ok' => true, 'message' => 'Password updated. Other signed-in sessions were revoked.' );
} );

SKW_Router::add( 'POST', '#^/api/auth/password-reset/request$#', function () {
	$body  = skw_body();
	$email = skw_normalize_email( isset( $body['email'] ) ? $body['email'] : null );
	if ( ! skw_rate_limit( 'reset-ip:' . skw_req( 'ip' ), 5, 900 ) || ! skw_rate_limit( 'reset-email:' . $email, 5, 900 ) ) {
		throw new SKW_Http_Error( 429, 'Too many reset requests. Wait 15 minutes and try again.' );
	}
	$account = SKW_DB::get_row( 'SELECT id, email FROM {users} WHERE email = ?', array( $email ) );
	if ( $account ) {
		$code = (string) random_int( 100000, 999999 );
		SKW_DB::upsert( 'password_reset_codes', array(
			'email' => $email, 'user_id' => $account['id'], 'code_hash' => password_hash( $code, PASSWORD_DEFAULT ),
			'expires_at' => time() + 600, 'attempts' => 0, 'created_at' => time(),
		), array( 'email' ) );
		$sent = skw_mail( $account['email'], 'Your SAFAR KAABE password reset code', 'Your SAFAR KAABE password reset code is ' . $code . '. It expires in 10 minutes. If you did not request this, ignore this email.' );
		if ( ! $sent ) {
			SKW_DB::query( 'DELETE FROM {password_reset_codes} WHERE email = ?', array( $email ) );
			throw new SKW_Http_Error( 503, 'The reset email could not be delivered. Try again later or contact support.' );
		}
	}
	return array( 'message' => 'If an account uses that email, a verification code has been sent.' );
} );

SKW_Router::add( 'POST', '#^/api/auth/password-reset/complete$#', function () {
	$body  = skw_body();
	$email = skw_normalize_email( isset( $body['email'] ) ? $body['email'] : null );
	$code  = isset( $body['code'] ) && is_string( $body['code'] ) && preg_match( '/^\d{6}$/', $body['code'] ) ? $body['code'] : '';
	$new   = skw_validate_password( isset( $body['newPassword'] ) ? $body['newPassword'] : null );
	$reset = SKW_DB::get_row( 'SELECT * FROM {password_reset_codes} WHERE email = ?', array( $email ) );
	$bad   = 'The reset code is invalid or expired. Request a new code.';
	if ( ! $reset || ! $code || (int) $reset['expires_at'] <= time() || (int) $reset['attempts'] >= 5 ) {
		if ( $reset ) {
			SKW_DB::query( 'DELETE FROM {password_reset_codes} WHERE email = ?', array( $email ) );
		}
		throw new SKW_Http_Error( 400, $bad );
	}
	if ( ! password_verify( $code, $reset['code_hash'] ) ) {
		SKW_DB::query( 'UPDATE {password_reset_codes} SET attempts = attempts + 1 WHERE email = ?', array( $email ) );
		throw new SKW_Http_Error( 400, $bad );
	}
	SKW_DB::transaction( function () use ( $reset, $new, $email ) {
		SKW_DB::update( 'users', array( 'password_hash' => skw_hash_password( $new ) ), array( 'id' => $reset['user_id'] ) );
		SKW_DB::query( 'DELETE FROM {sessions} WHERE user_id = ?', array( $reset['user_id'] ) );
		SKW_DB::query( 'DELETE FROM {password_reset_codes} WHERE email = ?', array( $email ) );
		skw_audit( $reset['user_id'], 'ACCOUNT_PASSWORD_RESET', $email );
	} );
	return array( 'message' => 'Password reset successfully. Sign in on your devices with your new password.' );
} );

SKW_Router::add( 'PATCH', '#^/api/auth/theme$#', function () {
	$user = skw_mutation();
	$body = skw_body();
	$theme = isset( $body['theme'] ) ? $body['theme'] : '';
	if ( ! in_array( $theme, array( 'light', 'dark', 'system' ), true ) ) {
		throw new SKW_Http_Error( 400, 'Choose Light, Dark or Automatic.' );
	}
	SKW_DB::update( 'users', array( 'theme_preference' => $theme ), array( 'id' => $user['id'] ) );
	return array( 'user' => skw_public_user( array_merge( $user, array( 'theme_preference' => $theme ) ) ) );
} );

SKW_Router::add( 'PATCH', '#^/api/auth/login-code$#', function () {
	global $skw_mailer;
	$user = skw_mutation();
	$body = skw_body();
	if ( ! isset( $body['enabled'] ) || ! is_bool( $body['enabled'] ) ) {
		throw new SKW_Http_Error( 400, 'Choose whether to turn sign-in codes on or off.' );
	}
	$password = skw_require_string( isset( $body['password'] ) ? $body['password'] : null, 'Current password', 256 );
	if ( ! password_verify( $password, $user['password_hash'] ) ) {
		throw new SKW_Http_Error( 400, 'Your current password is not correct.' );
	}
	if ( $body['enabled'] && ! is_callable( $skw_mailer ) ) {
		throw new SKW_Http_Error( 503, 'Sign-in codes need email sending to be set up on the server first.' );
	}
	SKW_DB::update( 'users', array( 'login_code_enabled' => $body['enabled'] ? 1 : 0 ), array( 'id' => $user['id'] ) );
	skw_audit( $user['id'], $body['enabled'] ? 'LOGIN_CODES_ENABLED' : 'LOGIN_CODES_DISABLED', $user['email'] );
	return array( 'user' => skw_public_user( array_merge( $user, array( 'login_code_enabled' => $body['enabled'] ? 1 : 0 ) ) ) );
} );

SKW_Router::add( 'POST', '#^/api/presence$#', function () {
	$user   = skw_mutation();
	$body   = skw_body();
	$status = isset( $body['status'] ) && in_array( $body['status'], array( 'AVAILABLE', 'BUSY', 'AWAY' ), true ) ? $body['status'] : null;
	$data   = array( 'last_seen_at' => skw_now() );
	if ( $status ) {
		$data['presence_status'] = $status;
	}
	if ( array_key_exists( 'typingConversationId', $body ) ) {
		$typing                         = is_string( $body['typingConversationId'] ) ? $body['typingConversationId'] : null;
		$data['typing_conversation_id'] = $typing;
		$data['typing_until']           = $typing ? skw_now( 6 ) : null;
	}
	SKW_DB::update( 'users', $data, array( 'id' => $user['id'] ) );
	return array( 'ok' => true, 'presenceStatus' => $status ? $status : ( $user['presence_status'] ? $user['presence_status'] : 'AVAILABLE' ) );
} );
