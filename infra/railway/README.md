# Railway deployment (spec 17.1)

Application services, plus a short-lived approval monitor, each use the repository root as their root directory and a config-as-code path under `infra/railway/<service>/railway.json`:

| Service            | Image                                 | `OREMEDIA_APP` variable | Ports / health                                                                       |
| ------------------ | ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `api`              | `infra/railway/Dockerfile`            | `api`                   | `PORT` (HTTP), `/health`; runs migrations as its pre-deploy command                  |
| `worker-core`      | `infra/railway/Dockerfile`            | `worker-core`           | `PORT`, `/health` once all workers started; queues `core`, `agents`, `publish-*`     |
| `worker-ingest`    | `infra/railway/Dockerfile`            | `worker-ingest`         | `PORT`, `/health` once workers started; `ingest-*`, `listening`, `crm`               |
| `worker-render`    | `infra/railway/Dockerfile.render`     | (fixed)                 | `PORT`, `/health` once workers started; `render`, `media`, `video`; Chromium, ffmpeg |
| `redirector`       | `infra/railway/Dockerfile`            | `redirector`            | `PORT`, `/health`; tracked-link redirects on `LINK_REDIRECT_DOMAIN`                  |
| `web`              | `infra/railway/Dockerfile.web`        | (fixed)                 | `PORT`, `/health` (proxied); SPA + API proxy (`API_INTERNAL_URL`)                    |
| `approval-monitor` | `infra/railway/Dockerfile`            | `approval-monitor`      | Railway cron; Gmail review-status poller, exits after each run                       |
| `acceptance`       | `infra/railway/acceptance/Dockerfile` | (fixed)                 | no port; the staging acceptance job, exits after each run; never in production       |

`worker-ingest` (Phase 6) and `redirector` (Phase 5) are listed for completeness: their `railway.json` files are in place, but the apps do not exist yet and the services must not be created until they do.

Database roles: `DATABASE_URL` on every service points at the application role (`packages/db/roles/app-role.sql`); `worker-core` additionally sets `DATABASE_URL_RETENTION`, a second MySQL user with the retention role (`packages/db/roles/retention-role.sql`), used only by the retention sweep's activities.

Managed dependencies: Railway MySQL (application), Railway Redis, Cloudflare R2 (object storage, external: Railway offers no S3-compatible store), and Temporal Cloud (recommended) or the `temporal` service above with its own Railway MySQL instance. Variables follow Appendix A names exactly; secrets are Railway sealed variables.

The `web` service is the only public origin: its Caddy reverse-proxies `/trpc`, `/v1`, `/mcp`, `/auth` and `/health` to `api` over the private network (`API_INTERNAL_URL`), so Google sign-in cookies are first-party (decision D-03; runbook section 1a).

The step-by-step procedure, rollback and the kill switches are in `docs/runbooks/deploy-railway.md`. The `acceptance`
service exists only in the staging project: `docs/runbooks/staging-acceptance.md` (it provisions its own fixtures and
prints `ACCEPTANCE_*` lines).

`approval-monitor` is a separate Railway cron service. Configure its Cron Schedule as `0 */6 * * *` (UTC), set `OREMEDIA_APP=approval-monitor`, and reference the API service's `DATABASE_URL` in the monitor service. It also requires sealed `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` variables. The monitor records Meta and LinkedIn review evidence in the global `provider_review_statuses` table; an approval email does not auto-certify a provider because the certification runbook still requires real publish/read-back and metrics checks.

## worker-render resources for video (STU-2a)

The render image carries ffmpeg and ffprobe (Ubuntu noble's 6.1.1 package, pinned in `Dockerfile.render`). Task queue
`video` (video and audio ingest; the video export store) runs on `worker-render` beside `render` and `media`, with
its own activity slots: `VIDEO_CONCURRENCY` (default 1) bounds concurrent ffmpeg jobs per container, independent of
`RENDER_CONCURRENCY` and `MEDIA_CONCURRENCY`, so a ten-minute transcode never takes a still render's slot. A
production container without ffmpeg/ffprobe refuses to start (its deploy fails); outside production it does not
poll `video` and logs `ffmpeg/ffprobe not found`. The start line names the queues polled.

Expectations per container, for one video job at a time. Measured during STU-2a on a shared 4 vCPU host (ffmpeg
6.1.1) with a deliberately hard 30 s 1080p30 source (12 Mbit/s with film-grain noise, 46 MB): probe 0.2–0.6 s,
decode check 1.4–2.4 s, all derivatives 43–46 s, of which the 720p proxy took 23 s on a quieter host and 36 s with
the host's load average near 20; poster 2–5 s, strip 4 s, waveform under 1 s; peak resident memory about 270 MB
for ffmpeg and 300 MB for the worker process. Ordinary camera footage encodes faster than this noise-heavy source.

| Resource       | Expectation                                                                           | Why                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| vCPU           | 2 or more (4 preferred)                                                               | The 720p H.264 proxy (`-preset veryfast`) dominates: about 0.8–1.2 × real time on 4 shared vCPU for the hard test source, so a 10-minute source takes up to about 12 minutes. `MEDIA_PROXY_TIMEOUT_MS` (default 30 minutes) is the ceiling; on fewer than 2 vCPU a 10-minute source can exceed it, so raise it there.    |
| Memory         | 2 GB plus the Chromium render budget                                                  | ffmpeg decoding 1080p/4K H.264 and x264 encoding 720p peak at a few hundred MB; sources are streamed to disk, never held in memory.                                                                                                                                                                                      |
| Ephemeral disk | 3 GB free per concurrent video job in `MEDIA_TMP_DIR` (default the OS temp directory) | The source (up to 1 GiB) is streamed to a private temp directory, then the proxy (capped with `-fs`) and frames are written beside it. Each job's budget is the upload cap plus 1.5 GiB (`MEDIA_TMP_MAX_BYTES` overrides). Directories are removed when the job ends; any left by a killed container are swept at start. |
| Egress         | Object store only (unchanged)                                                         | Sources are read with ranged/streamed GETs; derivatives are written with multipart uploads (8 MiB parts).                                                                                                                                                                                                                |

`VIDEO_CONCURRENCY` above 1 multiplies the CPU, memory and disk lines. Railway's default ephemeral disk is enough
for one job; raise the plan or attach a volume and point `MEDIA_TMP_DIR` at it before raising concurrency. The clamav
service's `StreamMaxLength` must cover the video cap (1 GiB) or every video upload stays quarantined with
`scanner_unavailable` (the scan names the setting). `infra/railway/clamav/` builds that service from the official
image with `StreamMaxLength`, `MaxScanSize` and `MaxFileSize` set to 1100M; point the clamav service at the repo with
config file `infra/railway/clamav/railway.json` (staging first) before the video rollout. See the runbook rollout
order for STU-2a.

### Video export (STU-2b)

`videoRenderJobWorkflowV1` composes a committed video document on `video`: Chromium draws title, caption and logo
overlays as PNGs, then one ffmpeg run (`-threads` from `VIDEO_FFMPEG_THREADS`, default 2) encodes H.264 High + AAC
with faststart. Measured on the same shared 4 vCPU host: a 30 s 1920x1080 30 fps project (3 clips, 2 transitions,
6 captions) took 32.8 s end to end (about 1.1 x real time) and produced a 24.8 MB MP4. A project is at most 180 s, so
expect up to about 3.5 minutes per export on 2 threads; the compose activity's timeout is 60 minutes with a 1 minute
heartbeat. Temp files (sources, overlay PNGs, the MP4) count against `MEDIA_TMP_MAX_BYTES` (default 20 GiB for a
render; the encoder's `-fs` stops at the remaining budget). The same `VIDEO_CONCURRENCY` slot bounds exports and
ingest.
