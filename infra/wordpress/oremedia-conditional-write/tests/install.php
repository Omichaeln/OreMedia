<?php
/**
 * Test-only installer (run.sh): installs WordPress into the throwaway database, activates the plugin, creates an
 * editor and an application password for it, and prints the credentials as JSON for the test to use.
 *
 *   php install.php <wordpress dir> <site url>
 */
if ( PHP_SAPI !== 'cli' ) {
	exit( 1 );
}
$dir = rtrim( $argv[1], '/' );
$url = $argv[2];
define( 'WP_INSTALLING', true );
$_SERVER['HTTP_HOST'] = parse_url( $url, PHP_URL_HOST ) . ':' . parse_url( $url, PHP_URL_PORT );
require $dir . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$installed = wp_install( 'Oremedia conditional write test', 'admin', 'admin@example.test', false, '', wp_generate_password( 24 ) );
update_option( 'siteurl', $url );
update_option( 'home', $url );
$activated = activate_plugin( 'oremedia-conditional-write/oremedia-conditional-write.php' );
if ( is_wp_error( $activated ) ) {
	fwrite( STDERR, $activated->get_error_message() . "\n" );
	exit( 1 );
}
$editor_id = wp_insert_user(
	array(
		'user_login' => 'ore-editor',
		'user_pass'  => wp_generate_password( 24 ),
		'user_email' => 'editor@example.test',
		'role'       => 'editor',
	)
);
$author_id = wp_insert_user(
	array(
		'user_login' => 'site-author',
		'user_pass'  => wp_generate_password( 24 ),
		'user_email' => 'author@example.test',
		'role'       => 'editor',
	)
);
list( $password ) = WP_Application_Passwords::create_new_application_password( $editor_id, array( 'name' => 'oremedia' ) );
list( $other )    = WP_Application_Passwords::create_new_application_password( $author_id, array( 'name' => 'person' ) );
echo wp_json_encode(
	array(
		'editor' => array( 'user' => 'ore-editor', 'password' => $password ),
		'person' => array( 'user' => 'site-author', 'password' => $other ),
	)
);
