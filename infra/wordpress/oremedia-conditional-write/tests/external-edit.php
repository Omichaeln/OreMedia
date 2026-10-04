<?php
/**
 * Test-only (run.sh): a change made to a post outside Oremedia, as another process on the site makes it.
 *
 *   php external-edit.php <wordpress dir> <post id> <mode> [value]
 *
 * modes: content (wp_update_post, as the block editor or wp-cli saves), content-same-second (the same, then the
 * modified instants are set back to what they were: a save within the same second as the client's read), term
 * (wp_set_post_terms only: the row and its modified instant do not change), bypass (a direct table update that
 * fires no WordPress hook), engine (ALTER the postmeta table to the given storage engine).
 */
if ( PHP_SAPI !== 'cli' ) {
	exit( 1 );
}
list( , $dir, $post_id, $mode ) = $argv;
$value = $argv[4] ?? 'External change ' . microtime( true );
$_SERVER['HTTP_HOST'] = 'localhost';
require rtrim( $dir, '/' ) . '/wp-load.php';
global $wpdb;
$post_id = (int) $post_id;
wp_set_current_user( get_user_by( 'login', 'site-author' )->ID );
switch ( $mode ) {
	case 'content':
		$r = wp_update_post( array( 'ID' => $post_id, 'post_content' => $value ), true );
		break;
	case 'content-same-second':
		$before = $wpdb->get_row( $wpdb->prepare( "SELECT post_modified, post_modified_gmt FROM {$wpdb->posts} WHERE ID = %d", $post_id ) );
		$r      = wp_update_post( array( 'ID' => $post_id, 'post_content' => $value ), true );
		$wpdb->update( $wpdb->posts, array( 'post_modified' => $before->post_modified, 'post_modified_gmt' => $before->post_modified_gmt ), array( 'ID' => $post_id ) );
		clean_post_cache( $post_id );
		break;
	case 'term':
		$term = wp_insert_term( $value, 'post_tag' );
		$r    = wp_set_post_terms( $post_id, array( is_wp_error( $term ) ? $term->get_error_data( 'term_exists' ) : $term['term_id'] ), 'post_tag', true );
		break;
	case 'bypass':
		$r = $wpdb->update( $wpdb->posts, array( 'post_content' => $value ), array( 'ID' => $post_id ) );
		clean_post_cache( $post_id );
		break;
	case 'engine':
		$r = $wpdb->query( "ALTER TABLE {$wpdb->postmeta} ENGINE = " . ( 'MyISAM' === $value ? 'MyISAM' : 'InnoDB' ) );
		break;
	default:
		fwrite( STDERR, "unknown mode $mode\n" );
		exit( 2 );
}
if ( is_wp_error( $r ) || false === $r ) {
	fwrite( STDERR, is_wp_error( $r ) ? $r->get_error_message() : $wpdb->last_error );
	exit( 1 );
}
echo 'ok';
