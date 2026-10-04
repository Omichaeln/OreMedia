<?php
/**
 * Test-only must-use plugin (copied by run.sh into the throwaway site, never shipped): when a conditional write
 * carries `X-Oremedia-Test-Hold: <ms>`, it waits that long while holding its locks, so the test can prove that a
 * concurrent writer is held off until the compare-and-write commits.
 */
add_action(
	'oremedia_conditional_write_locked',
	function () {
		$hold = isset( $_SERVER['HTTP_X_OREMEDIA_TEST_HOLD'] ) ? (int) $_SERVER['HTTP_X_OREMEDIA_TEST_HOLD'] : 0;
		if ( $hold > 0 && $hold <= 10000 ) {
			usleep( $hold * 1000 );
		}
	}
);
