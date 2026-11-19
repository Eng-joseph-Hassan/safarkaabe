<?php
/**
 * Orders: stored as a private post type, managed in WP Admin -> ANFAC MEDIA -> Orders.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AMSK_Orders {

	public static function statuses() {
		return array(
			'new'         => __( 'New – waiting for ANFAC MEDIA', 'anfac-media-safarkaabe' ),
			'confirmed'   => __( 'Confirmed', 'anfac-media-safarkaabe' ),
			'in_progress' => __( 'Being prepared', 'anfac-media-safarkaabe' ),
			'ready'       => __( 'Ready', 'anfac-media-safarkaabe' ),
			'delivered'   => __( 'Delivered', 'anfac-media-safarkaabe' ),
			'cancelled'   => __( 'Cancelled', 'anfac-media-safarkaabe' ),
		);
	}

	public static function payment_labels() {
		return array(
			'none'     => __( 'Pay the seller directly', 'anfac-media-safarkaabe' ),
			'pending'  => __( 'Waiting for phone payment', 'anfac-media-safarkaabe' ),
			'charging' => __( 'Phone payment in progress', 'anfac-media-safarkaabe' ),
			'paid'     => __( 'Paid', 'anfac-media-safarkaabe' ),
			'failed'   => __( 'Not paid', 'anfac-media-safarkaabe' ),
			'unknown'  => __( 'Payment being checked', 'anfac-media-safarkaabe' ),
		);
	}

	/** Allowed next statuses for each admin action. */
	private static function transitions() {
		return array(
			'confirm' => array( 'from' => array( 'new' ), 'to' => 'confirmed' ),
			'start'   => array( 'from' => array( 'new', 'confirmed' ), 'to' => 'in_progress' ),
			'ready'   => array( 'from' => array( 'confirmed', 'in_progress' ), 'to' => 'ready' ),
			'deliver' => array( 'from' => array( 'confirmed', 'in_progress', 'ready' ), 'to' => 'delivered' ),
			'cancel'  => array( 'from' => array( 'new', 'confirmed', 'in_progress', 'ready' ), 'to' => 'cancelled' ),
		);
	}

	public static function register() {
		register_post_type( 'amsk_order', array(
			'labels'          => array(
				'name'          => __( 'Orders', 'anfac-media-safarkaabe' ),
				'singular_name' => __( 'Order', 'anfac-media-safarkaabe' ),
				'edit_item'     => __( 'Order', 'anfac-media-safarkaabe' ),
			),
			'public'          => false,
			'show_ui'         => true,
			'show_in_menu'    => false,
			'show_in_rest'    => false,
			'supports'        => array( 'title' ),
			'map_meta_cap'    => false,
			'capabilities'    => array(
				'edit_post'          => 'amsk_manage_orders',
				'read_post'          => 'amsk_manage_orders',
				'delete_post'        => 'amsk_manage_orders',
				'edit_posts'         => 'amsk_manage_orders',
				'edit_others_posts'  => 'amsk_manage_orders',
				'delete_posts'       => 'amsk_manage_orders',
				'publish_posts'      => 'do_not_allow',
				'read_private_posts' => 'amsk_manage_orders',
				'create_posts'       => 'do_not_allow',
			),
		) );
		add_action( 'admin_post_amsk_order_action', array( __CLASS__, 'handle_admin_action' ) );
		add_filter( 'manage_amsk_order_posts_columns', array( __CLASS__, 'columns' ) );
		add_action( 'manage_amsk_order_posts_custom_column', array( __CLASS__, 'column_value' ), 10, 2 );
	}

	public static function meta( $order_id, $key ) {
		return get_post_meta( $order_id, '_amsk_' . $key, true );
	}

	private static function set( $order_id, $key, $value ) {
		update_post_meta( $order_id, '_amsk_' . $key, $value );
	}

	public static function add_history( $order_id, $text ) {
		$history = self::meta( $order_id, 'history' );
		$history = is_array( $history ) ? $history : array();
		$history[] = array( 'time' => current_time( 'mysql' ), 'text' => $text );
		self::set( $order_id, 'history', $history );
	}

	/**
	 * Creates an order. $lines = array( product_id => quantity ). Prices always come from the database.
	 * Returns the order ID or WP_Error.
	 */
	public static function create( $lines, $buyer, $method ) {
		$items = array();
		$total = 0;
		foreach ( $lines as $product_id => $qty ) {
			$qty     = (int) $qty;
			$product = AMSK_Products::get_sellable( (int) $product_id );
			if ( ! $product || $qty < 1 || $qty > 100 ) {
				continue;
			}
			$items[] = array( 'product_id' => $product['id'], 'title' => $product['title'], 'unit_cents' => $product['price_cents'], 'quantity' => $qty );
			$total  += $product['price_cents'] * $qty;
		}
		if ( ! $items ) {
			return new WP_Error( 'amsk_empty', __( 'Your cart is empty or the products are no longer available.', 'anfac-media-safarkaabe' ) );
		}
		$taken = array();
		foreach ( $items as $item ) {
			if ( ! AMSK_Products::take_stock( $item['product_id'], $item['quantity'] ) ) {
				foreach ( $taken as $done ) {
					AMSK_Products::return_stock( $done['product_id'], $done['quantity'] );
				}
				/* translators: %s: product name */
				return new WP_Error( 'amsk_stock', sprintf( __( 'Sorry, there are not enough of "%s" left. Please choose fewer.', 'anfac-media-safarkaabe' ), $item['title'] ) );
			}
			$taken[] = $item;
		}
		$reference = 'AM-' . strtoupper( wp_generate_password( 6, false, false ) );
		$order_id  = wp_insert_post( array(
			'post_type'   => 'amsk_order',
			'post_status' => 'publish',
			'post_title'  => $reference,
		), true );
		if ( is_wp_error( $order_id ) ) {
			foreach ( $taken as $done ) {
				AMSK_Products::return_stock( $done['product_id'], $done['quantity'] );
			}
			return $order_id;
		}
		self::set( $order_id, 'reference', $reference );
		self::set( $order_id, 'key', wp_generate_password( 32, false, false ) );
		self::set( $order_id, 'items', $items );
		self::set( $order_id, 'total_cents', $total );
		self::set( $order_id, 'buyer', $buyer );
		self::set( $order_id, 'buyer_user', get_current_user_id() );
		self::set( $order_id, 'status', 'new' );
		self::set( $order_id, 'payment_method', $method );
		self::set( $order_id, 'payment_status', 'seller' === $method ? 'none' : 'pending' );
		self::set( $order_id, 'stock_returned', 0 );
		self::add_history( $order_id, __( 'Order placed.', 'anfac-media-safarkaabe' ) );
		self::notify_admin( $order_id, __( 'New order', 'anfac-media-safarkaabe' ) );
		self::notify_buyer( $order_id, __( 'We received your order', 'anfac-media-safarkaabe' ) );
		return $order_id;
	}

	/** Returns the stock of a cancelled order exactly once. */
	private static function release_stock( $order_id ) {
		global $wpdb;
		$claimed = $wpdb->query( $wpdb->prepare(
			"UPDATE {$wpdb->postmeta} SET meta_value = '1' WHERE post_id = %d AND meta_key = '_amsk_stock_returned' AND meta_value = '0'",
			$order_id
		) );
		wp_cache_delete( $order_id, 'post_meta' );
		if ( 1 !== (int) $claimed ) {
			return;
		}
		$items = self::meta( $order_id, 'items' );
		foreach ( is_array( $items ) ? $items : array() as $item ) {
			AMSK_Products::return_stock( (int) $item['product_id'], (int) $item['quantity'] );
		}
	}

	/**
	 * Charges the buyer's phone once. A database check-and-set moves the payment from "pending" to
	 * "charging" first, so a double click or a second request can never charge twice.
	 */
	public static function charge( $order_id, $provider, $phone ) {
		global $wpdb;
		$claimed = $wpdb->query( $wpdb->prepare(
			"UPDATE {$wpdb->postmeta} SET meta_value = 'charging' WHERE post_id = %d AND meta_key = '_amsk_payment_status' AND meta_value = 'pending'",
			$order_id
		) );
		wp_cache_delete( $order_id, 'post_meta' );
		if ( 1 !== (int) $claimed ) {
			return array( 'status' => self::meta( $order_id, 'payment_status' ), 'message' => __( 'This order is already being paid.', 'anfac-media-safarkaabe' ) );
		}
		self::set( $order_id, 'payment_phone', $phone );
		self::set( $order_id, 'payment_started', time() );
		$reference = self::meta( $order_id, 'reference' );
		/* translators: %s: order reference */
		$result = AMSK_Payments::charge( $provider, $phone, (int) self::meta( $order_id, 'total_cents' ), sprintf( __( 'ANFAC MEDIA order %s', 'anfac-media-safarkaabe' ), $reference ) );
		self::set( $order_id, 'payment_status', $result['status'] );
		self::set( $order_id, 'payment_message', $result['message'] );
		if ( $result['transaction_id'] ) {
			self::set( $order_id, 'transaction_id', $result['transaction_id'] );
		}
		if ( 'paid' === $result['status'] ) {
			self::add_history( $order_id, __( 'Payment received by phone.', 'anfac-media-safarkaabe' ) );
			self::notify_admin( $order_id, __( 'Order paid', 'anfac-media-safarkaabe' ) );
			self::notify_buyer( $order_id, __( 'Payment received', 'anfac-media-safarkaabe' ) );
		} elseif ( 'failed' === $result['status'] ) {
			self::set( $order_id, 'status', 'cancelled' );
			self::release_stock( $order_id );
			self::add_history( $order_id, $result['message'] );
		} else {
			self::add_history( $order_id, __( 'Phone payment could not be confirmed. Check the WaafiPay or eDahab merchant portal, then mark the order as paid or not paid.', 'anfac-media-safarkaabe' ) );
			self::notify_admin( $order_id, __( 'Check this payment', 'anfac-media-safarkaabe' ) );
		}
		return $result;
	}

	/** Buyer cancels a new order that has not been paid. */
	public static function buyer_cancel( $order_id ) {
		if ( 'new' !== self::meta( $order_id, 'status' ) || ! in_array( self::meta( $order_id, 'payment_status' ), array( 'none', 'pending', 'failed' ), true ) ) {
			return false;
		}
		self::set( $order_id, 'status', 'cancelled' );
		self::release_stock( $order_id );
		self::add_history( $order_id, __( 'Cancelled by the buyer.', 'anfac-media-safarkaabe' ) );
		self::notify_admin( $order_id, __( 'Order cancelled by the buyer', 'anfac-media-safarkaabe' ) );
		return true;
	}

	public static function handle_admin_action() {
		$order_id = isset( $_POST['order_id'] ) ? absint( $_POST['order_id'] ) : 0;
		$action   = isset( $_POST['amsk_action'] ) ? sanitize_key( wp_unslash( $_POST['amsk_action'] ) ) : '';
		if ( ! $order_id || ! current_user_can( 'amsk_manage_orders' ) ) {
			wp_die( esc_html__( 'You are not allowed to change this order.', 'anfac-media-safarkaabe' ), 403 );
		}
		check_admin_referer( 'amsk_order_action_' . $order_id );
		$post = get_post( $order_id );
		if ( ! $post || 'amsk_order' !== $post->post_type ) {
			wp_die( esc_html__( 'Order not found.', 'anfac-media-safarkaabe' ), 404 );
		}
		$status   = self::meta( $order_id, 'status' );
		$payment  = self::meta( $order_id, 'payment_status' );
		$statuses = self::statuses();
		$rules    = self::transitions();
		$note     = '';
		if ( isset( $rules[ $action ] ) && in_array( $status, $rules[ $action ]['from'], true ) ) {
			if ( 'cancel' === $action && 'charging' === $payment ) {
				$note = __( 'A phone payment is in progress. Wait for it to finish before cancelling.', 'anfac-media-safarkaabe' );
			} else {
				self::set( $order_id, 'status', $rules[ $action ]['to'] );
				if ( 'cancel' === $action ) {
					self::release_stock( $order_id );
					if ( 'paid' === $payment ) {
						self::set( $order_id, 'refund_needed', 1 );
						self::add_history( $order_id, __( 'Cancelled after payment – send the money back to the buyer.', 'anfac-media-safarkaabe' ) );
					}
				}
				/* translators: %s: new order status */
				self::add_history( $order_id, sprintf( __( 'Status changed to: %s', 'anfac-media-safarkaabe' ), $statuses[ $rules[ $action ]['to'] ] ) );
				self::notify_buyer( $order_id, $statuses[ $rules[ $action ]['to'] ] );
			}
		} elseif ( 'mark_paid' === $action && in_array( $payment, array( 'unknown', 'none' ), true ) ) {
			self::set( $order_id, 'payment_status', 'paid' );
			self::add_history( $order_id, __( 'Marked as paid by ANFAC MEDIA after checking the payment.', 'anfac-media-safarkaabe' ) );
			self::notify_buyer( $order_id, __( 'Payment received', 'anfac-media-safarkaabe' ) );
		} elseif ( 'mark_not_paid' === $action && 'unknown' === $payment ) {
			self::set( $order_id, 'payment_status', 'failed' );
			self::set( $order_id, 'status', 'cancelled' );
			self::release_stock( $order_id );
			self::add_history( $order_id, __( 'Payment not received – order cancelled.', 'anfac-media-safarkaabe' ) );
			self::notify_buyer( $order_id, __( 'Payment not received – order cancelled', 'anfac-media-safarkaabe' ) );
		} elseif ( 'refund_sent' === $action && (int) self::meta( $order_id, 'refund_needed' ) === 1 ) {
			self::set( $order_id, 'refund_needed', 2 );
			self::add_history( $order_id, __( 'Refund sent to the buyer.', 'anfac-media-safarkaabe' ) );
			self::notify_buyer( $order_id, __( 'Your money was sent back', 'anfac-media-safarkaabe' ) );
		} else {
			$note = __( 'That change is not possible for this order right now.', 'anfac-media-safarkaabe' );
		}
		$url = add_query_arg( array( 'post' => $order_id, 'action' => 'edit' ), admin_url( 'post.php' ) );
		if ( $note ) {
			set_transient( 'amsk_admin_note_' . get_current_user_id(), $note, 60 );
		}
		wp_safe_redirect( $url );
		exit;
	}

	public static function meta_boxes() {
		add_meta_box( 'amsk_order_details', __( 'Order details', 'anfac-media-safarkaabe' ), array( __CLASS__, 'render_details' ), 'amsk_order', 'normal', 'high' );
		add_meta_box( 'amsk_order_actions', __( 'Update this order', 'anfac-media-safarkaabe' ), array( __CLASS__, 'render_actions' ), 'amsk_order', 'side', 'high' );
		remove_meta_box( 'submitdiv', 'amsk_order', 'side' );
	}

	public static function render_details( $post ) {
		$note = get_transient( 'amsk_admin_note_' . get_current_user_id() );
		if ( $note ) {
			delete_transient( 'amsk_admin_note_' . get_current_user_id() );
			echo '<div class="notice notice-warning inline"><p>' . esc_html( $note ) . '</p></div>';
		}
		$buyer    = self::meta( $post->ID, 'buyer' );
		$buyer    = is_array( $buyer ) ? $buyer : array();
		$items    = self::meta( $post->ID, 'items' );
		$statuses = self::statuses();
		$payments = self::payment_labels();
		$status   = self::meta( $post->ID, 'status' );
		$payment  = self::meta( $post->ID, 'payment_status' );
		?>
		<p><strong><?php esc_html_e( 'Order', 'anfac-media-safarkaabe' ); ?>:</strong> <?php echo esc_html( self::meta( $post->ID, 'reference' ) ); ?> &middot;
			<strong><?php esc_html_e( 'Status', 'anfac-media-safarkaabe' ); ?>:</strong> <?php echo esc_html( isset( $statuses[ $status ] ) ? $statuses[ $status ] : $status ); ?> &middot;
			<strong><?php esc_html_e( 'Payment', 'anfac-media-safarkaabe' ); ?>:</strong> <?php echo esc_html( isset( $payments[ $payment ] ) ? $payments[ $payment ] : $payment ); ?></p>
		<?php if ( self::meta( $post->ID, 'transaction_id' ) ) : ?>
			<p><strong><?php esc_html_e( 'Payment reference', 'anfac-media-safarkaabe' ); ?>:</strong> <?php echo esc_html( self::meta( $post->ID, 'transaction_id' ) ); ?> (<?php echo esc_html( self::meta( $post->ID, 'payment_method' ) ); ?>, <?php echo esc_html( self::meta( $post->ID, 'payment_phone' ) ); ?>)</p>
		<?php endif; ?>
		<?php if ( (int) self::meta( $post->ID, 'refund_needed' ) === 1 ) : ?>
			<div class="notice notice-error inline"><p><?php esc_html_e( 'This order was cancelled after payment. Send the money back to the buyer, then click "Refund sent".', 'anfac-media-safarkaabe' ); ?></p></div>
		<?php endif; ?>
		<h4><?php esc_html_e( 'Buyer', 'anfac-media-safarkaabe' ); ?></h4>
		<p><?php echo esc_html( isset( $buyer['name'] ) ? $buyer['name'] : '' ); ?><br />
			<?php echo esc_html( isset( $buyer['phone'] ) ? $buyer['phone'] : '' ); ?><br />
			<?php echo esc_html( isset( $buyer['email'] ) ? $buyer['email'] : '' ); ?></p>
		<?php if ( ! empty( $buyer['note'] ) ) : ?>
			<p><em><?php echo esc_html( $buyer['note'] ); ?></em></p>
		<?php endif; ?>
		<table class="widefat striped">
			<thead><tr><th><?php esc_html_e( 'Product', 'anfac-media-safarkaabe' ); ?></th><th><?php esc_html_e( 'Price', 'anfac-media-safarkaabe' ); ?></th><th><?php esc_html_e( 'Quantity', 'anfac-media-safarkaabe' ); ?></th></tr></thead>
			<tbody>
			<?php foreach ( is_array( $items ) ? $items : array() as $item ) : ?>
				<tr><td><?php echo esc_html( $item['title'] ); ?></td><td><?php echo esc_html( amsk_money( $item['unit_cents'] ) ); ?></td><td><?php echo esc_html( (int) $item['quantity'] ); ?></td></tr>
			<?php endforeach; ?>
			</tbody>
			<tfoot><tr><th><?php esc_html_e( 'Total', 'anfac-media-safarkaabe' ); ?></th><th colspan="2"><?php echo esc_html( amsk_money( self::meta( $post->ID, 'total_cents' ) ) ); ?></th></tr></tfoot>
		</table>
		<h4><?php esc_html_e( 'History', 'anfac-media-safarkaabe' ); ?></h4>
		<ul>
			<?php foreach ( array_reverse( (array) self::meta( $post->ID, 'history' ) ) as $entry ) : ?>
				<?php if ( is_array( $entry ) ) : ?>
					<li><?php echo esc_html( $entry['time'] . ' – ' . $entry['text'] ); ?></li>
				<?php endif; ?>
			<?php endforeach; ?>
		</ul>
		<?php
	}

	public static function render_actions( $post ) {
		$status  = self::meta( $post->ID, 'status' );
		$payment = self::meta( $post->ID, 'payment_status' );
		$buttons = array();
		$labels  = array(
			'confirm' => __( 'Confirm order', 'anfac-media-safarkaabe' ),
			'start'   => __( 'Start preparing', 'anfac-media-safarkaabe' ),
			'ready'   => __( 'Mark as ready', 'anfac-media-safarkaabe' ),
			'deliver' => __( 'Mark as delivered', 'anfac-media-safarkaabe' ),
			'cancel'  => __( 'Cancel order', 'anfac-media-safarkaabe' ),
		);
		foreach ( self::transitions() as $action => $rule ) {
			if ( in_array( $status, $rule['from'], true ) ) {
				$buttons[ $action ] = $labels[ $action ];
			}
		}
		if ( 'unknown' === $payment ) {
			$buttons['mark_paid']     = __( 'Payment received – mark as paid', 'anfac-media-safarkaabe' );
			$buttons['mark_not_paid'] = __( 'Payment not received – cancel', 'anfac-media-safarkaabe' );
		} elseif ( 'none' === $payment && 'cancelled' !== $status ) {
			$buttons['mark_paid'] = __( 'Buyer paid – mark as paid', 'anfac-media-safarkaabe' );
		}
		if ( (int) self::meta( $post->ID, 'refund_needed' ) === 1 ) {
			$buttons['refund_sent'] = __( 'Refund sent', 'anfac-media-safarkaabe' );
		}
		if ( ! $buttons ) {
			echo '<p>' . esc_html__( 'Nothing to update. This order is finished.', 'anfac-media-safarkaabe' ) . '</p>';
			return;
		}
		foreach ( $buttons as $action => $label ) {
			$confirm = in_array( $action, array( 'cancel', 'mark_not_paid' ), true ) ? ' onclick="return confirm(this.dataset.confirm);" data-confirm="' . esc_attr__( 'Are you sure?', 'anfac-media-safarkaabe' ) . '"' : '';
			// A small separate form per action (the edit screen form cannot be nested, so these post to admin-post.php).
			printf(
				'<p><button type="submit" form="amsk_action_%1$s" class="button %2$s" style="width:100%%"%3$s>%4$s</button></p>',
				esc_attr( $action ),
				'cancel' === $action || 'mark_not_paid' === $action ? '' : 'button-primary',
				$confirm, // Already escaped above.
				esc_html( $label )
			);
		}
		add_action( 'admin_footer', function () use ( $post, $buttons ) {
			foreach ( array_keys( $buttons ) as $action ) {
				printf( '<form id="amsk_action_%1$s" method="post" action="%2$s" style="display:none">', esc_attr( $action ), esc_url( admin_url( 'admin-post.php' ) ) );
				wp_nonce_field( 'amsk_order_action_' . $post->ID );
				printf(
					'<input type="hidden" name="action" value="amsk_order_action" /><input type="hidden" name="order_id" value="%1$d" /><input type="hidden" name="amsk_action" value="%2$s" /></form>',
					(int) $post->ID,
					esc_attr( $action )
				);
			}
		} );
	}

	public static function columns( $columns ) {
		return array(
			'cb'            => isset( $columns['cb'] ) ? $columns['cb'] : '',
			'title'         => __( 'Order', 'anfac-media-safarkaabe' ),
			'amsk_buyer'    => __( 'Buyer', 'anfac-media-safarkaabe' ),
			'amsk_total'    => __( 'Total', 'anfac-media-safarkaabe' ),
			'amsk_status'   => __( 'Status', 'anfac-media-safarkaabe' ),
			'amsk_payment'  => __( 'Payment', 'anfac-media-safarkaabe' ),
			'date'          => __( 'Date', 'anfac-media-safarkaabe' ),
		);
	}

	public static function column_value( $column, $order_id ) {
		if ( 'amsk_buyer' === $column ) {
			$buyer = self::meta( $order_id, 'buyer' );
			echo esc_html( is_array( $buyer ) ? $buyer['name'] . ' · ' . $buyer['phone'] : '' );
		} elseif ( 'amsk_total' === $column ) {
			echo esc_html( amsk_money( self::meta( $order_id, 'total_cents' ) ) );
		} elseif ( 'amsk_status' === $column ) {
			$statuses = self::statuses();
			$status   = self::meta( $order_id, 'status' );
			echo esc_html( isset( $statuses[ $status ] ) ? $statuses[ $status ] : $status );
		} elseif ( 'amsk_payment' === $column ) {
			$labels  = self::payment_labels();
			$payment = self::meta( $order_id, 'payment_status' );
			echo esc_html( isset( $labels[ $payment ] ) ? $labels[ $payment ] : $payment );
			if ( (int) self::meta( $order_id, 'refund_needed' ) === 1 ) {
				echo ' – <strong>' . esc_html__( 'refund needed', 'anfac-media-safarkaabe' ) . '</strong>';
			}
		}
	}

	/** Link where the buyer can see the order without an account (protected by a secret key). */
	public static function view_url( $order_id ) {
		$saved = (string) self::meta( $order_id, 'page_url' );
		$base  = $saved ? $saved : home_url( '/' );
		return add_query_arg( array( 'amsk_order' => self::meta( $order_id, 'reference' ), 'amsk_key' => self::meta( $order_id, 'key' ) ), $base );
	}

	private static function order_summary( $order_id ) {
		$lines = array();
		$items = self::meta( $order_id, 'items' );
		foreach ( is_array( $items ) ? $items : array() as $item ) {
			$lines[] = sprintf( '%d × %s – %s', (int) $item['quantity'], $item['title'], amsk_money( $item['unit_cents'] * $item['quantity'] ) );
		}
		/* translators: %s: total price */
		$lines[] = sprintf( __( 'Total: %s', 'anfac-media-safarkaabe' ), amsk_money( self::meta( $order_id, 'total_cents' ) ) );
		return implode( "\n", $lines );
	}

	public static function notify_admin( $order_id, $subject ) {
		$to = AMSK_Settings::get( 'notification_email' );
		if ( ! $to ) {
			return;
		}
		$buyer = self::meta( $order_id, 'buyer' );
		$body  = sprintf(
			"%s\n\n%s\n%s %s\n\n%s\n\n%s",
			self::meta( $order_id, 'reference' ),
			self::order_summary( $order_id ),
			is_array( $buyer ) ? $buyer['name'] : '',
			is_array( $buyer ) ? $buyer['phone'] : '',
			is_array( $buyer ) && ! empty( $buyer['note'] ) ? $buyer['note'] : '',
			admin_url( 'post.php?post=' . (int) $order_id . '&action=edit' )
		);
		wp_mail( $to, '[' . get_bloginfo( 'name' ) . '] ' . $subject . ' ' . self::meta( $order_id, 'reference' ), $body );
	}

	public static function notify_buyer( $order_id, $subject ) {
		$buyer = self::meta( $order_id, 'buyer' );
		if ( ! is_array( $buyer ) || empty( $buyer['email'] ) || ! is_email( $buyer['email'] ) ) {
			return;
		}
		$body = sprintf(
			"%s\n\n%s %s\n\n%s\n\n%s\n%s",
			$subject,
			__( 'Order', 'anfac-media-safarkaabe' ),
			self::meta( $order_id, 'reference' ),
			self::order_summary( $order_id ),
			__( 'See your order:', 'anfac-media-safarkaabe' ),
			self::view_url( $order_id )
		);
		wp_mail( $buyer['email'], 'ANFAC MEDIA – ' . $subject, $body );
	}

	/** Finds an order by reference and secret key (for buyers without an account). */
	public static function find_by_key( $reference, $key ) {
		$posts = get_posts( array(
			'post_type'      => 'amsk_order',
			'post_status'    => 'any',
			'posts_per_page' => 1,
			'title'          => sanitize_text_field( $reference ),
			'fields'         => 'ids',
		) );
		if ( ! $posts ) {
			return 0;
		}
		$stored = (string) self::meta( $posts[0], 'key' );
		return $stored && hash_equals( $stored, (string) $key ) ? (int) $posts[0] : 0;
	}
}
