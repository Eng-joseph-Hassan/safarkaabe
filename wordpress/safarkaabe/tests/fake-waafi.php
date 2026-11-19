<?php
// Fake WaafiPay API for tests: the payer number decides the answer.
$req     = json_decode( (string) file_get_contents( 'php://input' ), true );
$account = isset( $req['serviceParams']['payerInfo']['accountNo'] ) ? $req['serviceParams']['payerInfo']['accountNo'] : '';
file_put_contents( sys_get_temp_dir() . '/skw-fake-waafi.log', $account . "\n", FILE_APPEND );
header( 'Content-Type: application/json' );
if ( '252611111111' === $account ) {
	echo json_encode( array( 'responseCode' => '2001', 'params' => array( 'transactionId' => 'TXN-OK-1', 'state' => 'APPROVED' ) ) );
} elseif ( '252612222222' === $account ) {
	echo json_encode( array( 'responseCode' => '5206', 'errorCode' => 'E101073', 'responseMsg' => 'Insufficient balance' ) );
} else {
	echo '<html>gateway timeout</html>';
}
