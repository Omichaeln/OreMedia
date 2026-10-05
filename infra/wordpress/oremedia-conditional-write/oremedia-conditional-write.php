<?php
/**
 * Plugin Name:       Oremedia Conditional Write
 * Description:       Atomic conditional updates for the Oremedia publishing integration: a post is written through the REST API only while it is still the revision Oremedia last read (a per-post write counter compared and advanced inside one database transaction, plus a content fingerprint). Without it Oremedia refuses to update articles on this site.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Oremedia
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 *
 * Why this exists (PR-03): WordPress core's REST API applies `POST /wp/v2/posts/<id>` unconditionally. It sends no
 * ETag and honours no If-Match, If-Unmodified-Since or revision precondition, so a client that reads a post, decides
 * and then writes can silently replace an edit someone made in between. `modified_gmt` is second-granular and the
 * revision list may be disabled (WP_POST_REVISIONS = false), so neither can serve as the precondition.
 *
 * What it adds (namespace `oremedia/v1`, authenticated users who can edit posts only):
 *
 *   GET  /oremedia/v1/capabilities      the handshake: plugin, version, protocol and whether conditional updates
 *                                       are available on this database (transactional storage required). The
 *                                       storage engines and the WordPress version are added only for users who
 *                                       can edit others' posts (editors, administrators).
 *   POST /oremedia/v1/posts/<id>        { expected_version, expected_fingerprint, post: { ...core post fields } }
 *                                       applies `post` through core's own `/wp/v2/posts/<id>` handler (its
 *                                       validation, permissions and hooks) only if the post is still at
 *                                       `expected_version` with `expected_fingerprint`; otherwise 412 with the
 *                                       current state and nothing written.
 *   field `oremedia_write` on posts     (context=edit) { version, fingerprint, protocol }: what a client stores as
 *                                       the precondition of its next write.
 *
 * The precondition, and why it is atomic:
 *
 *   - Every save of a post advances a monotonically increasing counter in post meta (`_oremedia_write_counter`):
 *     before the row changes (`pre_post_update`), after its terms and meta are saved (`wp_after_insert_post`), on
 *     term changes (`set_object_terms`) and on content-relevant meta changes. The counter is advanced with a single
 *     `UPDATE ... SET meta_value = meta_value + 1` (atomic in the database), never read-modify-write in PHP. It
 *     does not depend on time (two saves in the same second give two values) nor on revisions (it lives in meta).
 *   - A conditional write opens a transaction, locks the counter row and the post row (`SELECT ... FOR UPDATE`),
 *     compares the counter and the fingerprint of the locked row with what the client expects, applies the write
 *     through core inside the same transaction, and commits. Another save that started earlier has already advanced
 *     the counter (its `pre_post_update` runs before its row update) and is seen; one that starts later waits on the
 *     counter row lock until the commit. The fingerprint (SHA-256 of the row's title, content, excerpt, status,
 *     slug, password, parent, menu order and modified instant) also catches a writer that bypasses WordPress hooks.
 *   - The handshake reports `conditional_update: false` when the posts or postmeta table is not InnoDB (no
 *     transactions or row locks, e.g. MyISAM or a SQLite drop-in): Oremedia then stays in its limited mode.
 *
 * Install only this file: the tests/ directory is the development test suite (it needs a throwaway WordPress and
 * database) and must not be copied to a site.
 *
 * Limits (documented in docs/platform-apps/wordpress.md): a later blind write by someone else (the block editor
 * saving a stale screen) still lands after Oremedia's write; that is the editor's own behaviour and Oremedia's
 * read-back after every write records what the site holds.
 */

namespace Oremedia\ConditionalWrite;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const VERSION     = '1.0.0';
const PROTOCOL    = 1;
const PLUGIN_SLUG = 'oremedia-conditional-write';
const META_KEY    = '_oremedia_write_counter';
const REST_NS     = 'oremedia/v1';

/** Meta keys whose changes do not change the article (editor locks, bookkeeping) and so do not advance the counter. */
function ignored_meta_keys() {
	return (array) apply_filters(
		'oremedia_conditional_write_ignored_meta_keys',
		array( META_KEY, '_edit_lock', '_edit_last', '_encloseme', '_pingme', '_wp_old_slug', '_wp_old_date', '_wp_trash_meta_status', '_wp_trash_meta_time', '_wp_desired_post_slug' )
	);
}

/** The post types the counter and the conditional endpoint cover (filterable; `post` by default). */
function covered_post_types() {
	return (array) apply_filters( 'oremedia_conditional_write_post_types', array( 'post' ) );
}

function covered( $post_id ) {
	$type = get_post_type( $post_id );
	return $type && in_array( $type, covered_post_types(), true );
}

/** A named lock so two first saves of the same post cannot both create its counter row. */
function lock_name( $post_id ) {
	return 'oremedia_cw_' . get_current_blog_id() . '_' . (int) $post_id;
}

/**
 * Advances the counter by one in a single statement; creates it (at 1) when the post has none yet. Writes through
 * $wpdb directly so no meta hook fires for the counter itself.
 */
function bump( $post_id ) {
	global $wpdb;
	$post_id = (int) $post_id;
	if ( $post_id <= 0 || ! covered( $post_id ) ) {
		return;
	}
	$updated = $wpdb->query(
		$wpdb->prepare(
			"UPDATE {$wpdb->postmeta} SET meta_value = CAST(meta_value AS UNSIGNED) + 1 WHERE post_id = %d AND meta_key = %s",
			$post_id,
			META_KEY
		)
	);
	if ( 0 === $updated ) {
		ensure_counter( $post_id, 1 );
	}
	wp_cache_delete( $post_id, 'post_meta' );
}

/** Creates the counter row once (under a named lock); an existing row is left as it is. */
function ensure_counter( $post_id, $initial = 1 ) {
	global $wpdb;
	$name = lock_name( $post_id );
	$wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 10)', $name ) );
	$exists = $wpdb->get_var(
		$wpdb->prepare( "SELECT meta_id FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s LIMIT 1", $post_id, META_KEY )
	);
	if ( ! $exists ) {
		$wpdb->insert(
			$wpdb->postmeta,
			array(
				'post_id'    => (int) $post_id,
				'meta_key'   => META_KEY,
				'meta_value' => (string) (int) $initial,
			),
			array( '%d', '%s', '%s' )
		);
	}
	$wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $name ) );
	wp_cache_delete( $post_id, 'post_meta' );
}

/** The fields a fingerprint covers, as stored in the posts table. */
const ROW_FIELDS = 'ID, post_title, post_content, post_excerpt, post_status, post_name, post_password, post_parent, menu_order, post_modified_gmt';

/** SHA-256 over the stored row (fingerprint scheme `sha256-v1`), as the conditional write recomputes it under lock. */
function fingerprint_of_row( $row ) {
	$fields = array(
		(string) $row->post_title,
		(string) $row->post_content,
		(string) $row->post_excerpt,
		(string) $row->post_status,
		(string) $row->post_name,
		(string) $row->post_password,
		(string) (int) $row->post_parent,
		(string) (int) $row->menu_order,
		(string) $row->post_modified_gmt,
	);
	return hash( 'sha256', wp_json_encode( $fields ) );
}

/**
 * The current state in one statement (a consistent read of the row and its counter), or with `FOR UPDATE` inside the
 * conditional write's transaction. Null when the post does not exist.
 */
function current_state( $post_id, $for_update = false ) {
	global $wpdb;
	$lock = $for_update ? ' FOR UPDATE' : '';
	if ( $for_update ) {
		$counter = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s ORDER BY meta_id ASC LIMIT 1 FOR UPDATE",
				$post_id,
				META_KEY
			)
		);
		$row     = $wpdb->get_row( $wpdb->prepare( 'SELECT ' . ROW_FIELDS . " FROM {$wpdb->posts} WHERE ID = %d{$lock}", $post_id ) );
	} else {
		$row     = $wpdb->get_row(
			$wpdb->prepare(
				'SELECT ' . ROW_FIELDS . ", (SELECT MAX(CAST(m.meta_value AS UNSIGNED)) FROM {$wpdb->postmeta} m WHERE m.post_id = p.ID AND m.meta_key = %s) AS oremedia_counter FROM {$wpdb->posts} p WHERE p.ID = %d",
				META_KEY,
				$post_id
			)
		);
		$counter = $row ? $row->oremedia_counter : null;
	}
	if ( ! $row ) {
		return null;
	}
	return array(
		'version'     => null === $counter ? 0 : (int) $counter,
		'fingerprint' => fingerprint_of_row( $row ),
	);
}

/** Whether this database can run the conditional write atomically: the posts and postmeta tables are InnoDB. */
function storage_report() {
	global $wpdb;
	static $report = null;
	if ( null !== $report ) {
		return $report;
	}
	$engines = array();
	// A SQLite drop-in (WordPress Playground, the SQLite Database Integration plugin) emulates MySQL's catalogue but
	// has no row locks: never transactional here. A wpdb subclass on MySQL (Query Monitor, HyperDB) is read as usual.
	$sqlite = ( defined( 'DB_ENGINE' ) && 'sqlite' === strtolower( (string) DB_ENGINE ) ) || false !== stripos( get_class( $wpdb ), 'sqlite' );
	if ( $wpdb instanceof \wpdb && ! $sqlite ) {
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				'SELECT TABLE_NAME AS t, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (%s, %s)',
				$wpdb->posts,
				$wpdb->postmeta
			)
		);
		foreach ( (array) $rows as $r ) {
			$engines[ $r->t ] = $r->e;
		}
	}
	$transactional = 2 === count( $engines ) && count( array_filter( $engines, function ( $e ) {
		return 'innodb' === strtolower( (string) $e );
	} ) ) === 2;
	$report = array(
		'transactional' => $transactional,
		'engines'       => $engines,
	);
	return $report;
}

// ---- the counter: every save advances it ----

add_action(
	'pre_post_update',
	function ( $post_id ) {
		bump( $post_id );
	},
	1
);
add_action(
	'wp_after_insert_post',
	function ( $post_id, $post ) {
		if ( $post && 'revision' !== $post->post_type ) {
			bump( $post_id );
		}
	},
	1,
	2
);
add_action(
	'set_object_terms',
	function ( $object_id, $terms, $tt_ids, $taxonomy ) {
		$type = get_post_type( $object_id );
		if ( $type && is_object_in_taxonomy( $type, $taxonomy ) ) {
			bump( $object_id );
		}
	},
	1,
	4
);
$oremedia_cw_meta_changed = function ( $meta_id, $object_id, $meta_key ) {
	if ( ! in_array( $meta_key, ignored_meta_keys(), true ) ) {
		bump( $object_id );
	}
};
add_action( 'added_post_meta', $oremedia_cw_meta_changed, 1, 3 );
add_action( 'updated_post_meta', $oremedia_cw_meta_changed, 1, 3 );
add_action( 'deleted_post_meta', function ( $meta_ids, $object_id, $meta_key ) {
	if ( ! in_array( $meta_key, ignored_meta_keys(), true ) ) {
		bump( $object_id );
	}
}, 1, 3 );

// ---- REST ----

add_action( 'rest_api_init', __NAMESPACE__ . '\\register_routes' );

function register_routes() {
	foreach ( covered_post_types() as $type ) {
		register_rest_field(
			$type,
			'oremedia_write',
			array(
				'get_callback' => function ( $prepared ) {
					$post_id = (int) $prepared['id'];
					$state   = current_state( $post_id );
					if ( $state && 0 === $state['version'] ) {
						ensure_counter( $post_id, 1 );
						$state = current_state( $post_id );
					}
					return $state ? array_merge( $state, array( 'protocol' => PROTOCOL ) ) : null;
				},
				'schema'       => array(
					'description' => 'Oremedia conditional-write precondition: the post write counter and fingerprint.',
					'type'        => 'object',
					'context'     => array( 'edit' ),
					'readonly'    => true,
				),
			)
		);
	}

	register_rest_route(
		REST_NS,
		'/capabilities',
		array(
			'methods'             => 'GET',
			'permission_callback' => function () {
				return current_user_can( 'edit_posts' );
			},
			'callback'            => function () {
				$storage  = storage_report();
				$response = array(
					'plugin'   => PLUGIN_SLUG,
					'version'  => VERSION,
					'protocol' => PROTOCOL,
					'features' => array(
						'conditional_update' => $storage['transactional'],
						'write_counter'      => true,
						'fingerprint'        => 'sha256-v1',
						'post_types'         => array_values( covered_post_types() ),
					),
				);
				// The handshake above is all Oremedia reads. The storage engines and the WordPress version are
				// diagnostics for the site's editors and administrators only, never for a Contributor or Author.
				if ( current_user_can( 'edit_others_posts' ) ) {
					$response['storage']   = $storage;
					$response['wordpress'] = get_bloginfo( 'version' );
				}
				return rest_ensure_response( $response );
			},
		)
	);

	register_rest_route(
		REST_NS,
		'/posts/(?P<id>\d+)',
		array(
			'methods'             => 'POST',
			'permission_callback' => function ( $request ) {
				$post_id = (int) $request['id'];
				return covered( $post_id ) && current_user_can( 'edit_post', $post_id );
			},
			'args'                => array(
				'expected_version'     => array(
					'type'     => 'integer',
					'required' => true,
					'minimum'  => 1,
				),
				'expected_fingerprint' => array(
					'type'     => 'string',
					'required' => true,
					'pattern'  => '^[0-9a-f]{64}$',
				),
				'post'                 => array(
					'type'     => 'object',
					'required' => true,
				),
			),
			'callback'            => __NAMESPACE__ . '\\conditional_update',
		)
	);
}

/** The post as core's REST API shows it (context=edit), for a 412 body or after a write. */
function core_post( $post_id ) {
	$request = new \WP_REST_Request( 'GET', '/wp/v2/posts/' . (int) $post_id );
	$request->set_param( 'context', 'edit' );
	$response = rest_do_request( $request );
	return $response->is_error() ? null : $response->get_data();
}

function precondition_failed( $post_id, $state ) {
	return new \WP_Error(
		'oremedia_precondition_failed',
		'The post changed since the revision the client last read; nothing was written.',
		array(
			'status'  => 412,
			'current' => array(
				'version'     => $state ? $state['version'] : null,
				'fingerprint' => $state ? $state['fingerprint'] : null,
				'post'        => core_post( $post_id ),
			),
		)
	);
}

/**
 * The conditional write: compare and write inside one transaction holding the counter and post row locks; the write
 * itself is core's `/wp/v2/posts/<id>` handler (its validation, its permission checks, its hooks).
 */
function conditional_update( \WP_REST_Request $request ) {
	global $wpdb;
	$post_id  = (int) $request['id'];
	$expected = (int) $request['expected_version'];
	$expected_fingerprint = (string) $request['expected_fingerprint'];
	$fields   = $request['post'];
	if ( ! is_array( $fields ) ) {
		return new \WP_Error( 'oremedia_invalid_post', 'post must be an object of core post fields.', array( 'status' => 400 ) );
	}
	unset( $fields['id'], $fields['context'] );

	if ( ! storage_report()['transactional'] ) {
		return new \WP_Error( 'oremedia_not_transactional', 'This database cannot apply a conditional write atomically.', array( 'status' => 501 ) );
	}
	if ( null === current_state( $post_id ) ) {
		return new \WP_Error( 'rest_post_invalid_id', 'Invalid post ID.', array( 'status' => 404 ) );
	}
	ensure_counter( $post_id, 1 );

	if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
		return new \WP_Error( 'oremedia_transaction_failed', 'The transaction could not be opened.', array( 'status' => 503 ) );
	}
	try {
		$state = current_state( $post_id, true );
		if ( null === $state ) {
			$wpdb->query( 'ROLLBACK' );
			return new \WP_Error( 'rest_post_invalid_id', 'Invalid post ID.', array( 'status' => 404 ) );
		}
		if ( $state['version'] !== $expected || ! hash_equals( $state['fingerprint'], $expected_fingerprint ) ) {
			$wpdb->query( 'ROLLBACK' );
			do_action( 'oremedia_conditional_write_refused', $post_id, $expected, $state );
			return precondition_failed( $post_id, $state );
		}
		// A persistent object cache must not hand core a stale copy to merge the update into.
		clean_post_cache( $post_id );
		do_action( 'oremedia_conditional_write_locked', $post_id, $state );

		$core = new \WP_REST_Request( 'POST', '/wp/v2/posts/' . $post_id );
		$core->set_body_params( $fields );
		$core->set_param( 'context', 'edit' );
		$response = rest_do_request( $core );
		if ( $response->is_error() || $response->get_status() >= 300 ) {
			$wpdb->query( 'ROLLBACK' );
			clean_post_cache( $post_id );
			return $response;
		}
		$after = current_state( $post_id, true );
		if ( $after['version'] <= $expected ) {
			// A write that changed nothing still consumes the precondition.
			bump( $post_id );
			$after = current_state( $post_id, true );
		}
		if ( false === $wpdb->query( 'COMMIT' ) ) {
			$wpdb->query( 'ROLLBACK' );
			return new \WP_Error( 'oremedia_commit_failed', 'The write could not be committed.', array( 'status' => 503 ) );
		}
	} catch ( \Throwable $e ) {
		$wpdb->query( 'ROLLBACK' );
		clean_post_cache( $post_id );
		throw $e;
	}
	clean_post_cache( $post_id );
	return rest_ensure_response(
		array(
			'version'     => $after['version'],
			'fingerprint' => $after['fingerprint'],
			'protocol'    => PROTOCOL,
			'post'        => $response->get_data(),
		)
	);
}
