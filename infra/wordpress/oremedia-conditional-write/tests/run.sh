#!/usr/bin/env bash
# Runs the Oremedia Conditional Write plugin against a real WordPress and a real MySQL (InnoDB), no docker.
#
#   WP_CORE_DIR=/path/to/wordpress  MYSQL_SOCKET=/path/to/mysql.sock  [MYSQL_USER=root MYSQL_PASSWORD=]  \
#     infra/wordpress/oremedia-conditional-write/tests/run.sh
#
# WP_CORE_DIR is a WordPress release tree (e.g. `git clone --depth 1 --branch 7.1.2 https://github.com/WordPress/WordPress`).
# The script copies it to a temporary directory, writes a wp-config.php for a throwaway database (created and
# dropped here, never an existing one), installs WordPress, activates the plugin, serves it with PHP's built-in
# server (several workers, so requests really run concurrently) and runs tests/conditional-write-test.php twice:
# with post revisions enabled and with WP_POST_REVISIONS = false.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
plugin_dir="$(cd "$here/.." && pwd)"
: "${WP_CORE_DIR:?set WP_CORE_DIR to a WordPress release tree}"
: "${MYSQL_SOCKET:?set MYSQL_SOCKET to the MySQL server socket}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
port="${WP_TEST_PORT:-38080}"
mysql_cli=(mysql --socket="$MYSQL_SOCKET" -u"$MYSQL_USER")
[ -n "$MYSQL_PASSWORD" ] && mysql_cli+=(-p"$MYSQL_PASSWORD")

status=0
for revisions in on off; do
  work="$(mktemp -d)"
  db="oremedia_cw_test_$$_${revisions}"
  server_pid=""
  cleanup() {
    [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
    "${mysql_cli[@]}" -e "DROP DATABASE IF EXISTS \`$db\`" 2>/dev/null || true
    rm -rf "$work"
  }
  trap cleanup EXIT
  cp -R "$WP_CORE_DIR" "$work/wp"
  rm -rf "$work/wp/.git"
  mkdir -p "$work/wp/wp-content/plugins" "$work/wp/wp-content/mu-plugins"
  cp -R "$plugin_dir" "$work/wp/wp-content/plugins/oremedia-conditional-write"
  rm -rf "$work/wp/wp-content/plugins/oremedia-conditional-write/tests"
  cp "$here/test-hooks.php" "$work/wp/wp-content/mu-plugins/oremedia-cw-test-hooks.php"
  "${mysql_cli[@]}" -e "CREATE DATABASE \`$db\` DEFAULT CHARACTER SET utf8mb4"
  revisions_const="true"
  [ "$revisions" = off ] && revisions_const="false"
  cat > "$work/wp/wp-config.php" <<PHP
<?php
define( 'DB_NAME', '$db' );
define( 'DB_USER', '$MYSQL_USER' );
define( 'DB_PASSWORD', '$MYSQL_PASSWORD' );
define( 'DB_HOST', 'localhost:$MYSQL_SOCKET' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
define( 'WP_ENVIRONMENT_TYPE', 'local' );
define( 'WP_POST_REVISIONS', $revisions_const );
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_DEBUG_LOG', '$work/debug.log' );
foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as \$k ) { define( \$k, '$db-' . \$k ); }
\$table_prefix = 'wp_';
if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ . '/' ); }
require_once ABSPATH . 'wp-settings.php';
PHP
  php "$here/install.php" "$work/wp" "http://127.0.0.1:$port" > "$work/credentials.json"
  PHP_CLI_SERVER_WORKERS=8 php -S "127.0.0.1:$port" -t "$work/wp" > "$work/server.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "http://127.0.0.1:$port/" && break
    sleep 0.1
  done
  echo "== WordPress $(php -r "include '$work/wp/wp-includes/version.php'; echo \$wp_version;"), revisions $revisions"
  if ! php "$here/conditional-write-test.php" "$work/wp" "http://127.0.0.1:$port" "$work/credentials.json" "$revisions"; then
    status=1
    [ -f "$work/debug.log" ] && tail -n 40 "$work/debug.log"
  fi
  cleanup
  trap - EXIT
done
exit $status
