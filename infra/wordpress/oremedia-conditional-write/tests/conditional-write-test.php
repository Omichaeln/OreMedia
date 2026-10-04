<?php
/**
 * The plugin against a real WordPress over HTTP (run.sh): the handshake, the counter, the conditional write, and
 * the stale writes it must refuse with the post left untouched: an edit by another user through the REST API, an
 * edit by another process, a term change in the same second (the row and its modified instant unchanged), a
 * content change whose modified instant reads the same second, a direct table update that fires no hook, a run
 * with post revisions disabled, eight concurrent writes on one precondition, a writer held off while the compare
 * and write holds its locks, a core validation failure rolled back, and a non-transactional table refused.
 *
 *   php conditional-write-test.php <wordpress dir> <site url> <credentials.json> <on|off: revisions>
 */
if ( PHP_SAPI !== 'cli' ) {
	exit( 1 );
}
list( , $dir, $base, $credentials_file, $revisions ) = $argv;
$creds = json_decode( file_get_contents( $credentials_file ), true );
$failures = 0;
$passes   = 0;

function check( $ok, $label ) {
	global $failures, $passes;
	if ( $ok ) {
		$passes++;
		echo "  ok   $label\n";
	} else {
		$failures++;
		echo "  FAIL $label\n";
	}
}

function auth( $who ) {
	global $creds;
	return 'Authorization: Basic ' . base64_encode( $creds[ $who ]['user'] . ':' . $creds[ $who ]['password'] );
}

function handle( $method, $route, $body = null, $who = 'editor', array $headers = array() ) {
	global $base;
	$ch = curl_init( $base . '/?rest_route=' . rawurlencode( $route ) );
	$h  = array_merge( array( 'Accept: application/json' ), $headers );
	if ( $who ) {
		$h[] = auth( $who );
	}
	if ( null !== $body ) {
		$h[] = 'Content-Type: application/json';
		curl_setopt( $ch, CURLOPT_POSTFIELDS, json_encode( $body ) );
	}
	curl_setopt_array(
		$ch,
		array(
			CURLOPT_CUSTOMREQUEST  => $method,
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_HTTPHEADER     => $h,
			CURLOPT_TIMEOUT        => 30,
		)
	);
	return $ch;
}

function call( $method, $route, $body = null, $who = 'editor', array $headers = array() ) {
	$ch   = handle( $method, $route, $body, $who, $headers );
	$raw  = curl_exec( $ch );
	$code = curl_getinfo( $ch, CURLINFO_RESPONSE_CODE );
	curl_close( $ch );
	return array( $code, json_decode( (string) $raw, true ) );
}

/** GET a post with context=edit (the query rides on rest_route's URL). */
function read_post( $id ) {
	global $base;
	$ch = curl_init( $base . '/?rest_route=' . rawurlencode( '/wp/v2/posts/' . $id ) . '&context=edit' );
	curl_setopt_array( $ch, array( CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => array( auth( 'editor' ) ) ) );
	$raw = curl_exec( $ch );
	curl_close( $ch );
	return json_decode( (string) $raw, true );
}

function revisions_count( $id ) {
	global $base;
	$ch = curl_init( $base . '/?rest_route=' . rawurlencode( '/wp/v2/posts/' . $id . '/revisions' ) . '&context=edit' );
	curl_setopt_array( $ch, array( CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => array( auth( 'editor' ) ) ) );
	$raw  = curl_exec( $ch );
	$code = curl_getinfo( $ch, CURLINFO_RESPONSE_CODE );
	curl_close( $ch );
	$json = json_decode( (string) $raw, true );
	return 200 === $code && is_array( $json ) ? count( $json ) : -1;
}

function external( $id, $mode, $value = null ) {
	global $dir;
	$cmd = sprintf( 'php %s %s %d %s %s 2>&1', escapeshellarg( __DIR__ . '/external-edit.php' ), escapeshellarg( $dir ), $id, escapeshellarg( $mode ), null === $value ? '' : escapeshellarg( $value ) );
	exec( $cmd, $out, $code );
	if ( 0 !== $code ) {
		echo '    external edit failed: ' . implode( "\n", $out ) . "\n";
	}
	return 0 === $code;
}

function conditional( $id, array $token, array $post, array $headers = array() ) {
	return call(
		'POST',
		'/oremedia/v1/posts/' . $id,
		array(
			'expected_version'     => $token['version'],
			'expected_fingerprint' => $token['fingerprint'],
			'post'                 => $post,
		),
		'editor',
		$headers
	);
}

function new_post( $content ) {
	list( $code, $json ) = call( 'POST', '/wp/v2/posts', array( 'title' => 'Why ore & tar', 'content' => $content, 'status' => 'publish' ) );
	if ( 201 !== $code ) {
		echo '    could not create a post: ' . json_encode( $json ) . "\n";
		exit( 1 );
	}
	return (int) $json['id'];
}

// 0. Core alone (why the plugin exists): /wp/v2/posts/<id> ignores every HTTP precondition and applies a stale write.
$core_id = new_post( '<p>Original.</p>' );
list( $code ) = call( 'POST', '/wp/v2/posts/' . $core_id, array( 'content' => '<p>The person’s edit.</p>' ), 'person' );
list( $code, $json ) = call(
	'POST',
	'/wp/v2/posts/' . $core_id,
	array( 'content' => '<p>Stale write.</p>' ),
	'editor',
	array( 'If-Match: "stale-etag"', 'If-Unmodified-Since: Mon, 01 Jan 2001 00:00:00 GMT' )
);
check( 200 === $code && '<p>Stale write.</p>' === read_post( $core_id )['content']['raw'], 'core: If-Match / If-Unmodified-Since are ignored, the stale write replaced the person’s edit' );
check( ! isset( read_post( $core_id )['etag'] ), 'core: no ETag or revision precondition is offered on the post' );

// 1. The handshake.
list( $code, $caps ) = call( 'GET', '/oremedia/v1/capabilities' );
check( 200 === $code && 'oremedia-conditional-write' === $caps['plugin'] && 1 === $caps['protocol'], 'capabilities: plugin and protocol 1' );
check( true === ( $caps['features']['conditional_update'] ?? null ), 'capabilities: conditional updates available on InnoDB' );
list( $code ) = call( 'GET', '/oremedia/v1/capabilities', null, null );
check( 401 === $code, 'capabilities: refused without credentials (401)' );

// 2. The precondition rides on the post (context=edit).
$id    = new_post( '<p>Ore is heavy.</p>' );
$post  = read_post( $id );
$token = $post['oremedia_write'] ?? null;
check( is_array( $token ) && $token['version'] >= 1 && preg_match( '/^[0-9a-f]{64}$/', $token['fingerprint'] ), 'read: oremedia_write carries a version and a sha256 fingerprint' );

// 3. A conditional write on the current precondition goes through once.
list( $code, $written ) = conditional( $id, $token, array( 'content' => '<p>Ore is heavy and tar is sticky.</p>' ) );
check( 200 === $code && '<p>Ore is heavy and tar is sticky.</p>' === $written['post']['content']['raw'], 'write: applied on the current precondition' );
check( $written['version'] > $token['version'] && $written['fingerprint'] !== $token['fingerprint'], 'write: the version advanced and the fingerprint moved' );
$after = read_post( $id );
check( $after['oremedia_write']['version'] === $written['version'] && $after['oremedia_write']['fingerprint'] === $written['fingerprint'], 'write: the returned precondition is what a read shows' );
list( $code ) = conditional( $id, $token, array( 'content' => '<p>Replayed.</p>' ) );
check( 412 === $code && '<p>Ore is heavy and tar is sticky.</p>' === read_post( $id )['content']['raw'], 'write: the consumed precondition cannot be replayed (412, untouched)' );

// 4. Another user edits through the core REST API between the read and the write.
$token = read_post( $id )['oremedia_write'];
list( $code ) = call( 'POST', '/wp/v2/posts/' . $id, array( 'content' => '<p>The person’s edit.</p>' ), 'person' );
check( 200 === $code, 'setup: another user edited the post through /wp/v2/posts' );
list( $code, $refused ) = conditional( $id, $token, array( 'content' => '<p>Stale approved text.</p>' ) );
check( 412 === $code && 'oremedia_precondition_failed' === $refused['code'], 'stale (REST edit): refused with 412' );
check( '<p>The person’s edit.</p>' === read_post( $id )['content']['raw'], 'stale (REST edit): the person’s content is untouched' );
check( '<p>The person’s edit.</p>' === ( $refused['data']['current']['post']['content']['raw'] ?? null ) && $refused['data']['current']['version'] > $token['version'], 'stale (REST edit): the 412 carries the current post and version' );

// 5. A term change in the same second: the row (and its modified instant) does not change, only the counter.
$before = read_post( $id );
$token  = $before['oremedia_write'];
check( external( $id, 'term', 'same-second-tag' ), 'setup: a tag added by another process' );
$now = read_post( $id );
check( $now['modified_gmt'] === $before['modified_gmt'] && $now['oremedia_write']['fingerprint'] === $token['fingerprint'], 'same second (terms): modified_gmt and the row fingerprint are unchanged' );
list( $code ) = conditional( $id, $token, array( 'content' => '<p>Stale approved text.</p>' ) );
check( 412 === $code && $before['content']['raw'] === read_post( $id )['content']['raw'], 'same second (terms): refused by the counter alone, content untouched' );

// 6. A content save whose modified instant reads the same second as the client's read.
$before = read_post( $id );
$token  = $before['oremedia_write'];
check( external( $id, 'content-same-second', '<p>Saved within the same second.</p>' ), 'setup: a content save in the same second by another process' );
$now = read_post( $id );
check( $now['modified_gmt'] === $before['modified_gmt'], 'same second (content): modified_gmt reads the same instant' );
list( $code ) = conditional( $id, $token, array( 'content' => '<p>Stale approved text.</p>' ) );
check( 412 === $code && '<p>Saved within the same second.</p>' === read_post( $id )['content']['raw'], 'same second (content): refused, the other save untouched' );

// 7. A writer that bypasses every WordPress hook: the counter does not move, the fingerprint of the locked row does.
$token = read_post( $id )['oremedia_write'];
check( external( $id, 'bypass', '<p>Direct table update.</p>' ), 'setup: a direct table update (no hook fired)' );
check( read_post( $id )['oremedia_write']['version'] === $token['version'], 'bypass: the counter did not move' );
list( $code ) = conditional( $id, $token, array( 'content' => '<p>Stale approved text.</p>' ) );
check( 412 === $code && '<p>Direct table update.</p>' === read_post( $id )['content']['raw'], 'bypass: refused by the fingerprint, content untouched' );

// 8. Revisions: the precondition does not depend on them.
$revs = revisions_count( $id );
if ( 'off' === $revisions ) {
	check( 0 === $revs, 'revisions disabled: the site kept no revision of the post (every refusal above held without them)' );
} else {
	check( $revs > 0, 'revisions enabled: the site kept revisions (the precondition does not read them)' );
}

// 9. Eight concurrent writes on one precondition: exactly one wins, the rest are refused.
$token = read_post( $id )['oremedia_write'];
$multi = curl_multi_init();
$handles = array();
for ( $i = 0; $i < 8; $i++ ) {
	$ch = handle(
		'POST',
		'/oremedia/v1/posts/' . $id,
		array(
			'expected_version'     => $token['version'],
			'expected_fingerprint' => $token['fingerprint'],
			'post'                 => array( 'content' => "<p>Concurrent writer $i.</p>" ),
		)
	);
	curl_multi_add_handle( $multi, $ch );
	$handles[ $i ] = $ch;
}
do {
	curl_multi_exec( $multi, $running );
	curl_multi_select( $multi );
} while ( $running > 0 );
$codes = array();
$winner = null;
foreach ( $handles as $i => $ch ) {
	$codes[ $i ] = curl_getinfo( $ch, CURLINFO_RESPONSE_CODE );
	if ( 200 === $codes[ $i ] ) {
		$winner = $i;
	}
	curl_multi_remove_handle( $multi, $ch );
}
curl_multi_close( $multi );
$counts = array_count_values( $codes );
check( 1 === ( $counts[200] ?? 0 ) && 7 === ( $counts[412] ?? 0 ), 'concurrent: one 200 and seven 412 (' . json_encode( $counts ) . ')' );
check( null !== $winner && "<p>Concurrent writer $winner.</p>" === read_post( $id )['content']['raw'], 'concurrent: the post holds the single winner’s content' );

// 10. While the compare-and-write holds its locks, another process's save waits until it commits.
$token = read_post( $id )['oremedia_write'];
$multi = curl_multi_init();
$ch    = handle(
	'POST',
	'/oremedia/v1/posts/' . $id,
	array(
		'expected_version'     => $token['version'],
		'expected_fingerprint' => $token['fingerprint'],
		'post'                 => array( 'content' => '<p>Written under the lock.</p>' ),
	),
	'editor',
	array( 'X-Oremedia-Test-Hold: 2000' )
);
curl_multi_add_handle( $multi, $ch );
// Drive the request until it is inside the lock (it holds for 2s), then save from another process.
$started = microtime( true );
do {
	curl_multi_exec( $multi, $running );
	curl_multi_select( $multi, 0.05 );
} while ( microtime( true ) - $started < 0.7 );
$edit_started = microtime( true );
external( $id, 'content', '<p>Saved by another process during the lock.</p>' );
$edit_took = microtime( true ) - $edit_started;
do {
	curl_multi_exec( $multi, $running );
	curl_multi_select( $multi );
} while ( $running > 0 );
$locked_code = curl_getinfo( $ch, CURLINFO_RESPONSE_CODE );
$locked_body = json_decode( (string) curl_multi_getcontent( $ch ), true );
curl_multi_remove_handle( $multi, $ch );
curl_multi_close( $multi );
check( 200 === $locked_code, "lock: the conditional write that held the lock committed ($locked_code)" );
check( $edit_took >= 1.0, sprintf( 'lock: the other process waited for the commit (%.2fs)', $edit_took ) );
$final = read_post( $id );
check( $final['oremedia_write']['version'] > $locked_body['version'], 'lock: the later save advanced the counter past the committed write, so a write on the stale precondition is refused' );
list( $code ) = conditional( $id, array( 'version' => $locked_body['version'], 'fingerprint' => $locked_body['fingerprint'] ), array( 'content' => '<p>Stale.</p>' ) );
check( 412 === $code, 'lock: the precondition returned before the later save is now stale (412)' );

// 11. A write core refuses is rolled back: nothing changes, the precondition still holds.
$token = read_post( $id )['oremedia_write'];
$content_before = read_post( $id )['content']['raw'];
list( $code ) = conditional( $id, $token, array( 'content' => '<p>Bad status.</p>', 'status' => 'not-a-status' ) );
check( 400 === $code, 'core refusal: the 400 is passed through' );
$now = read_post( $id );
check( $now['content']['raw'] === $content_before && $now['oremedia_write']['version'] === $token['version'], 'core refusal: rolled back (content and version unchanged)' );
list( $code ) = conditional( $id, $token, array( 'content' => '<p>After the refusal.</p>' ) );
check( 200 === $code, 'core refusal: the untouched precondition still writes' );

// 12. No transactions, no conditional writes.
check( external( $id, 'engine', 'MyISAM' ), 'setup: postmeta converted to MyISAM' );
list( $code, $caps ) = call( 'GET', '/oremedia/v1/capabilities' );
check( 200 === $code && false === $caps['features']['conditional_update'], 'MyISAM: the handshake reports no conditional updates' );
$token = read_post( $id )['oremedia_write'];
list( $code ) = conditional( $id, $token, array( 'content' => '<p>Not atomic.</p>' ) );
check( 501 === $code && '<p>After the refusal.</p>' === read_post( $id )['content']['raw'], 'MyISAM: the conditional endpoint refuses (501), content untouched' );
external( $id, 'engine', 'InnoDB' );

echo "  $passes passed, $failures failed\n";
exit( $failures > 0 ? 1 : 0 );
