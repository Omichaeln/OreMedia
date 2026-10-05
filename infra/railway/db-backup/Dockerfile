# db-backup (ledger 7.3, re-audit RA-13): the MySQL client image plus the AWS CLI, so one job can dump the
# application database (and Temporal's) and copy the dump off the Railway volume to the object store. The service
# runs on a cron schedule (every 15 minutes in production and staging: the recovery point) with
# `backup.sh`, which also copies new and changed objects of the assets and releases buckets (`object-backup.sh`,
# PR-09); the same image run once with `restore.sh` (or `restore-objects.sh`) loads a chosen dump into a SEPARATE
# MySQL instance (objects into a separate bucket or scratch prefix) and times the restore (the recovery time);
# `verify.sh` is the daily integrity job and `drill.sh` the timed staging drill. No application code and no
# credentials other than the ones Railway injects as variables.
FROM amazon/aws-cli:2.22.35 AS awscli

FROM mysql:9
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws
COPY infra/railway/db-backup/backup.sh infra/railway/db-backup/backup-lib.sh infra/railway/db-backup/object-backup.sh \
  infra/railway/db-backup/restore.sh infra/railway/db-backup/restore-objects.sh infra/railway/db-backup/verify.sh \
  infra/railway/db-backup/drill.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/object-backup.sh /usr/local/bin/restore.sh \
  /usr/local/bin/restore-objects.sh /usr/local/bin/verify.sh /usr/local/bin/drill.sh
ENTRYPOINT []
CMD ["backup.sh"]
