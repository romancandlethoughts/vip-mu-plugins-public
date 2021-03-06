<?php

namespace Automattic\WP\Cron_Control;

class Cron_Options_CPT extends Singleton {
	/**
	 * PLUGIN SETUP
	 */

	/**
	 * Class properties
	 */
	const LOCK = 'create-jobs';

	const POST_TYPE             = 'a8c_cron_ctrl_event';
	const POST_STATUS_PENDING   = 'inherit';
	const POST_STATUS_COMPLETED = 'trash';

	private $posts_to_clean = array();

	private $option_before_unscheduling = null;

	/**
	 * Register hooks
	 */
	protected function class_init() {
		// Data storage
		add_action( 'init', array( $this, 'register_post_type' ) );

		// Lock for post insertion, to guard against endless event creation when `wp_next_scheduled()` is misused
		Lock::prime_lock( self::LOCK );

		// Option interception
		add_filter( 'pre_option_cron', array( $this, 'get_option' ) );
		add_filter( 'pre_update_option_cron', array( $this, 'update_option' ), 10, 2 );
	}

	/**
	 * Register a private post type to store cron events
	 */
	public function register_post_type() {
		register_post_type( self::POST_TYPE, array(
			'label'               => 'Cron Events',
			'public'              => false,
			'rewrite'             => false,
			'export'              => false,
			'exclude_from_search' => true,
		) );

		// Clear caches for any manually-inserted posts, lest stale caches be used
		if ( ! empty( $this->posts_to_clean ) ) {
			foreach ( $this->posts_to_clean as $index => $post_to_clean ) {
				clean_post_cache( $post_to_clean );
				unset( $this->posts_to_clean[ $index ] );
			}
		}
	}

	/**
	 * PLUGIN FUNCTIONALITY
	 */

	/**
	 * Override cron option requests with data from CPT
	 */
	public function get_option() {
		$cron_array = array(
			'version' => 2, // Core versions the cron array; without this, events will continually requeue
		);

		// Get events to re-render as the cron option
		$page  = 1;

		do {
			$jobs_posts = $this->get_jobs( array(
				'post_type'        => self::POST_TYPE,
				'post_status'      => self::POST_STATUS_PENDING,
				'suppress_filters' => false,
				'posts_per_page'   => 100,
				'paged'            => $page,
				'orderby'          => 'date',
				'order'            => 'ASC',
			) );

			// Nothing more to add
			if ( empty( $jobs_posts ) ) {
				break;
			}

			$page++;

			// Something's probably wrong if a site has more than 1,500 pending cron actions
			if ( $page > 15 ) {
				do_action( 'a8c_cron_control_stopped_runaway_cron_option_rebuild' );
				break;
			}

			// Loop through results and built output Core expects
			if ( ! empty( $jobs_posts ) ) {
				foreach ( $jobs_posts as $jobs_post ) {
					$timestamp = strtotime( $jobs_post->post_date_gmt );

					$job_args = maybe_unserialize( $jobs_post->post_content_filtered );
					if ( ! is_array( $job_args ) ) {
						continue;
					}

					$action   = $job_args['action'];
					$instance = $job_args['instance'];
					$args     = $job_args['args'];

					$cron_array[ $timestamp ][ $action ][ $instance ] = array(
						'schedule' => $args['schedule'],
						'args'     => $args['args'],
					);

					if ( isset( $args['interval'] ) ) {
						$cron_array[ $timestamp ][ $action ][ $instance ]['interval'] = $args['interval'];
					}

				}
			}
		} while( true );

		// Re-sort the array just as Core does when events are scheduled
		// Ensures events are sorted chronologically
		uksort( $cron_array, 'strnatcasecmp' );

		// If we're unscheduling an event, hold onto the previous value so we can identify what's unscheduled
		if ( $this->is_unscheduling() ) {
			$this->option_before_unscheduling = $cron_array;
		} else {
			$this->option_before_unscheduling = null;
		}

		return $cron_array;
	}

	/**
	 * Handle requests to update the cron option
	 *
	 * By returning $old_value, `cron` option won't be updated
	 */
	public function update_option( $new_value, $old_value ) {
		if ( $this->is_unscheduling() ) {
			$this->unschedule_job( $new_value, $this->option_before_unscheduling );
		} else {
			$this->convert_option( $new_value );
		}

		return $old_value;
	}

	/**
	 * Delete jobs that are unscheduled using `wp_unschedule_event()`
	 */
	private function unschedule_job( $new_value, $old_value ) {
		$jobs = $this->find_unscheduled_jobs( $new_value, $old_value );

		foreach ( $jobs as $job ) {
			$this->mark_job_completed( $job['timestamp'], $job['action'], $job['instance'] );
		}
	}

	/**
	 * Save cron events in CPT
	 */
	private function convert_option( $new_value ) {
		if ( is_array( $new_value ) && ! empty( $new_value ) ) {
			$events = collapse_events_array( $new_value );

			foreach ( $events as $event ) {
				$job_exists = $this->job_exists( $event['timestamp'], $event['action'], $event['instance'] );

				if ( ! $job_exists ) {
					// Build minimum information needed to create a post
					$job_post = array(
						'post_title'            => $this->event_title( $event['timestamp'], $event['action'], $event['instance'] ),
						'post_name'             => $this->event_name( $event['timestamp'], $event['action'], $event['instance'] ),
						'post_content_filtered' => maybe_serialize( array(
							'action'   => $event['action'],
							'instance' => $event['instance'],
							'args'     => $event['args'],
						) ),
						'post_date'             => date( 'Y-m-d H:i:s', $event['timestamp'] ),
						'post_date_gmt'         => date( 'Y-m-d H:i:s', $event['timestamp'] ),
						'post_type'             => self::POST_TYPE,
						'post_status'           => self::POST_STATUS_PENDING,
					);

					$this->create_job( $job_post );
				}
			}
		}
	}

	/**
	 * PLUGIN UTILITY METHODS
	 */

	/**
	 * Retrieve list of jobs, respecting whether or not the CPT is registered
	 *
	 * `WP_Query` also can't be used before `init` due to capabilities checks
	 */
	private function get_jobs( $args ) {
		// If called before `init`, we need to query directly because post types aren't registered earlier
		if ( did_action( 'init' ) ) {
			return get_posts( $args );
		} else {
			global $wpdb;

			$orderby = 'date' === $args['orderby'] ? 'post_date' : $args['orderby'];

			if ( isset( $args['paged'] ) ) {
				$paged  = max( 0, $args['paged'] - 1 );
				$offset = $paged * $args['posts_per_page'];
			} else {
				$offset = 0;
			}

			return $wpdb->get_results( $wpdb->prepare( "SELECT * FROM {$wpdb->posts} WHERE post_type = %s AND post_status = %s ORDER BY %s %s LIMIT %d,%d;", $args['post_type'], $args['post_status'], $orderby, $args['order'], $offset, $args['posts_per_page'] ), 'OBJECT' );
		}
	}

	/**
	 * Check if a job post exists
	 *
	 * Uses a direct query to avoid stale caches that result in duplicate events
	 */
	private function job_exists( $timestamp, $action, $instance, $return_id = false ) {
		global $wpdb;

		 $exists = $wpdb->get_col( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE post_name = %s AND post_type = %s AND post_status = %s LIMIT 1;", $this->event_name( $timestamp, $action, $instance ), self::POST_TYPE, self::POST_STATUS_PENDING ) );

		if ( $return_id ) {
			return empty( $exists ) ? 0 : (int) array_shift( $exists );
		} else {
			return ! empty( $exists );
		}
	}

	/**
	 * Create a job post, respecting whether or not Core is ready for CPTs
	 *
	 * `wp_insert_post()` can't be called as early as we need, in part because of the capabilities checks Core performs
	 */
	private function create_job( $job_post ) {
		// Limit how many events to insert at once
		if ( ! Lock::check_lock( self::LOCK, 5 ) ) {
			return false;
		}

		// If called before `init`, we need to insert directly because post types aren't registered earlier
		if ( did_action( 'init' ) ) {
			wp_insert_post( $job_post );
		} else {
			global $wpdb;

			// Additional data needed to manually create a post
			$job_post = wp_parse_args( $job_post, array(
				'post_author'       => 0,
				'comment_status'    => 'closed',
				'ping_status'       => 'closed',
				'post_parent'       => 0,
				'post_modified'     => current_time( 'mysql' ),
				'post_modified_gmt' => current_time( 'mysql', true ),
			) );

			// Some sanitization in place of `sanitize_post()`, which we can't use this early
			foreach ( array( 'post_title', 'post_name', 'post_content_filtered' ) as $field ) {
				$job_post[ $field ] = sanitize_text_field( $job_post[ $field ] );
			}

			// Duplicate some processing performed in `wp_insert_post()`
			$charset = $wpdb->get_col_charset( $wpdb->posts, 'post_title' );
			if ( 'utf8' === $charset ) {
				$job_post['post_title'] = wp_encode_emoji( $job_post['post_title'] );
			}

			$job_post = wp_unslash( $job_post );

			// Set this so it isn't empty, even though it serves us no purpose
			$job_post['guid'] = esc_url( add_query_arg( self::POST_TYPE, $job_post['post_name'], home_url( '/' ) ) );

			// Create the post
			$inserted = $wpdb->insert( $wpdb->posts, $job_post );

			// Clear caches for new posts once the post type is registered
			if ( $inserted ) {
				$this->posts_to_clean[] = $wpdb->insert_id;
			}
		}

		// Allow more events to be created
		Lock::free_lock( self::LOCK );
	}

	/**
	 * Mark an event's CPT entry as completed
	 *
	 * Trashed posts will be cleaned up by an internal job
	 *
	 * @param $timestamp  int     Unix timestamp
	 * @param $action     string  name of action used when the event is registered (unhashed)
	 * @param $instance   string  md5 hash of the event's arguments array, which Core uses to index the `cron` option
	 *
	 * @return bool
	 */
	private function mark_job_completed( $timestamp, $action, $instance ) {
		$job_post_id = $this->job_exists( $timestamp, $action, $instance, true );

		if ( ! $job_post_id ) {
			return false;
		}

		return $this->mark_job_post_completed( $job_post_id );
	}

	/**
	 * Set a job post to the "completed" status
	 *
	 * `wp_trash_post()` calls `wp_insert_post()`, which can't be used before `init` due to capabilities checks
	 */
	private function mark_job_post_completed( $job_post_id ) {
		// If called before `init`, we need to modify directly because post types aren't registered earlier
		if ( did_action( 'init' ) ) {
			wp_trash_post( $job_post_id );
		} else {
			global $wpdb;

			$wpdb->update( 'posts', array( 'post_status' => self::POST_STATUS_COMPLETED, ), array( 'ID' => $job_post_id, ) );
			wp_add_trashed_suffix_to_post_name_for_post( $job_post_id );
			$this->posts_to_clean[] = $job_post_id;
		}

		return true;
	}

	/**
	 * Determine if current request is a call to `wp_unschedule_event()`
	 */
	private function is_unscheduling() {
		return false !== array_search( 'wp_unschedule_event', wp_debug_backtrace_summary( __CLASS__, null, false ) );
	}

	/**
	 * Identify jobs unscheduled using `wp_unschedule_event()` by comparing current value with previous
	 */
	private function find_unscheduled_jobs( $new, $old ) {
		$differences = array();

		$old = collapse_events_array( $old );

		foreach ( $old as $event ) {
			$timestamp = $event['timestamp'];
			$action    = $event['action'];
			$instance  = $event['instance'];

			if ( ! isset( $new[ $timestamp ][ $action ][ $instance ] ) ) {
				$differences[] = array(
					'timestamp' => $timestamp,
					'action'    => $action,
					'instance'  => $instance,
				);
			}
		}

		return $differences;
	}

	/**
	 * Generate a standardized post name from an event's arguments
	 */
	private function event_name( $timestamp, $action, $instance ) {
		return sprintf( '%s-%s-%s', $timestamp, md5( $action ), $instance );
	}

	/**
	 * Generate a standardized, human-readable post title from an event's arguments
	 */
	private function event_title( $timestamp, $action, $instance ) {
		return sprintf( '%s | %s | %s', $timestamp, $action, $instance );
	}
}

Cron_Options_CPT::instance();
