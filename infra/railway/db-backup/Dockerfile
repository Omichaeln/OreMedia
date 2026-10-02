# db-backup (ledger 7.3, re-audit RA-13): the MySQL client image plus the AWS CLI, so one job can dump the
# application database (and Temporal's) and copy the dump off the Railway volume to the object store. The service
# runs on a cron schedule (every 15 minutes in production and staging: the recovery point) with
# `backup.sh`; the same image run once with `restore.sh` loads a chosen dump into a SEPARATE MySQL instance and
# times the restore (the recovery time). No application code and no credentials other than the ones Railway
# injects as variables.
FROM amazon/aws-cli:2.22.35 AS awscli

FROM mysql:9
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws
COPY infra/railway/db-backup/backup.sh /usr/local/bin/backup.sh
COPY infra/railway/db-backup/restore.sh /usr/local/bin/restore.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
ENTRYPOINT []
CMD ["backup.sh"]
