# Self-hosted Temporal server for Railway (used only if Temporal Cloud is not chosen; spec 3.1).
# Persistence is a SEPARATE Railway MySQL 8 instance, never the application database.
FROM temporalio/auto-setup:1.26.2
ENV DB=mysql8 \
    DBNAME=temporal \
    VISIBILITY_DBNAME=temporal_visibility \
    SKIP_DB_CREATE=false \
    NUM_HISTORY_SHARDS=512 \
    TEMPORAL_ADDRESS=0.0.0.0:7233 \
    BIND_ON_IP=0.0.0.0 \
    SQL_MAX_CONNS=10 \
    SQL_MAX_IDLE_CONNS=5
# Connection pool cap (residual risk R19): auto-setup defaults to 20 connections per datastore, and the single process
# runs four services (frontend, history, matching, worker), each with a default and a visibility store, so up to 160
# connections against MySQL's default max_connections of 151; on 4 October 2026 temporal-db refused connections for
# about ten minutes and a backup missed its Temporal dump. 10 per store caps Temporal at 80, leaving room for backups.
# Set on the Railway service from the Temporal MySQL plugin: MYSQL_SEEDS, DB_PORT, MYSQL_USER, MYSQL_PWD.
EXPOSE 7233
