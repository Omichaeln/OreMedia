<?php
/**
 * Test-only installer (run.sh): installs WordPress into the throwaway database, activates the plugin, creates two
 * editors and a contributor with an application password each, and prints the credentials as JSON for the test.
 *
 *   php install.php <wordpress dir> <site url>
 */
// Test-only and command line only (tests/ is never installed on a site): it loads WordPress itself, so ABSPATH is
// not defined yet when it starts. Over HTTP, or if WordPress has already loaded it, it stops here.
if ( PHP_SAPI !== 'cli' || defined( 'ABSPATH' ) ) {
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
$contributor_id = wp_insert_user(
	array(
		'user_login' => 'site-contributor',
		'user_pass'  => wp_generate_password( 24 ),
		'user_email' => 'contributor@example.test',
		'role'       => 'contributor',
	)
);
list( $password )    = WP_Application_Passwords::create_new_application_password( $editor_id, array( 'name' => 'oremedia' ) );
list( $other )       = WP_Application_Passwords::create_new_application_password( $author_id, array( 'name' => 'person' ) );
list( $contributor ) = WP_Application_Passwords::create_new_application_password( $contributor_id, array( 'name' => 'contributor' ) );
echo wp_json_encode(
	array(
		'editor'      => array( 'user' => 'ore-editor', 'password' => $password ),
		'person'      => array( 'user' => 'site-author', 'password' => $other ),
		'contributor' => array( 'user' => 'site-contributor', 'password' => $contributor ),
	)
);
