#!/usr/bin/env node
// A stand-in for the AWS CLI for the db-backup script tests (tooling/scripts/db-backup): the subset of `aws s3` and
// `aws s3api` the scripts in infra/railway/db-backup call, over a directory per endpoint (FAKE_S3_ROOT). Unknown
// commands or queries fail, so a script change that needs more of the CLI fails its test instead of passing
// against a fake that ignores it. FAKE_S3_KEYS maps an endpoint to the access key id it accepts; FAKE_S3_LOG
// receives one JSON line per call (endpoint, command, bucket, key; never a credential); FAKE_S3_FAIL_GET_KEYS lists
// keys whose download fails with a 500.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const opts = {};
const flags = new Set();
const pos = [];
const VALUED = new Set([
  '--endpoint-url',
  '--content-type',
  '--bucket',
  '--key',
  '--prefix',
  '--query',
  '--output',
  '--body',
]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED.has(a)) opts[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) flags.add(a.slice(2));
  else pos.push(a);
}
const [service, op, ...rest] = pos;

function die(message, code = 254) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const endpoint = opts['endpoint-url'];
if (!endpoint) die('fake aws: --endpoint-url is required', 2);
const root = process.env.FAKE_S3_ROOT;
if (!root) die('fake aws: FAKE_S3_ROOT is not set', 2);
const keys = JSON.parse(process.env.FAKE_S3_KEYS ?? '{}');
if (keys[endpoint] !== undefined && keys[endpoint] !== process.env.AWS_ACCESS_KEY_ID)
  die('An error occurred (InvalidAccessKeyId) when calling the operation: The access key ID does not exist');
const config = process.env.AWS_CONFIG_FILE ? readFileSync(process.env.AWS_CONFIG_FILE, 'utf8') : '';
const pathStyle = /addressing_style\s*=\s*path/.test(config);

const store = join(root, encodeURIComponent(endpoint));
const objectPath = (bucket, key) => join(store, bucket, 'objects', encodeURIComponent(key));
const metaPath = (bucket, key) => join(store, bucket, 'meta', `${encodeURIComponent(key)}.json`);
function needBucket(bucket) {
  if (!existsSync(join(store, bucket)))
    die('An error occurred (NoSuchBucket) when calling the operation: The specified bucket does not exist');
}
function parseS3(url) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url ?? '');
  return m ? { bucket: m[1], key: m[2] } : null;
}
function log(entry) {
  if (process.env.FAKE_S3_LOG)
    appendFileSync(process.env.FAKE_S3_LOG, `${JSON.stringify({ endpoint, pathStyle, ...entry })}\n`);
}
function listKeys(bucket, prefix = '') {
  needBucket(bucket);
  const dir = join(store, bucket, 'objects');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => decodeURIComponent(f))
    .filter((k) => k.startsWith(prefix))
    .sort();
}
function head(bucket, key) {
  needBucket(bucket);
  const p = objectPath(bucket, key);
  if (!existsSync(p)) return null;
  const body = readFileSync(p);
  const meta = JSON.parse(readFileSync(metaPath(bucket, key), 'utf8'));
  return {
    size: body.length,
    etag: `"${createHash('md5').update(body).digest('hex')}"`,
    contentType: meta.contentType,
    body,
  };
}
function put(bucket, key, body, contentType) {
  needBucket(bucket);
  mkdirSync(join(store, bucket, 'objects'), { recursive: true });
  mkdirSync(join(store, bucket, 'meta'), { recursive: true });
  writeFileSync(objectPath(bucket, key), body);
  writeFileSync(metaPath(bucket, key), JSON.stringify({ contentType: contentType ?? 'binary/octet-stream' }));
}
function text(rows) {
  process.stdout.write(rows.length ? `${rows.map((r) => r.join('\t')).join('\n')}\n` : 'None\n');
}

const cmd = `${service} ${op}`;
switch (cmd) {
  case 's3 ls': {
    const t = parseS3(rest[0]);
    log({ cmd, bucket: t.bucket, key: t.key });
    const seen = new Set();
    const lines = [];
    for (const k of listKeys(t.bucket, t.key)) {
      const tail = k.slice(t.key.length);
      const slash = tail.indexOf('/');
      if (slash >= 0) {
        const dir = tail.slice(0, slash + 1);
        if (!seen.has(dir)) lines.push(`                           PRE ${dir}`);
        seen.add(dir);
      } else {
        lines.push(
          `2026-10-05 10:00:00 ${String(statSync(objectPath(t.bucket, k)).size).padStart(10)} ${tail}`,
        );
      }
    }
    if (!lines.length) process.exit(1);
    process.stdout.write(`${lines.join('\n')}\n`);
    break;
  }
  case 's3 cp': {
    const [from, to] = rest;
    const src = parseS3(from);
    const dst = parseS3(to);
    if (src && !dst) {
      log({ cmd: 's3 cp get', bucket: src.bucket, key: src.key });
      const h = head(src.bucket, src.key);
      if (!h)
        die(
          `fatal error: An error occurred (404) when calling the HeadObject operation: Key "${src.key}" does not exist`,
          1,
        );
      writeFileSync(to, h.body);
    } else if (dst && !src) {
      log({ cmd: 's3 cp put', bucket: dst.bucket, key: dst.key });
      put(dst.bucket, dst.key, readFileSync(from), opts['content-type']);
    } else die('fake aws: s3 cp supports local to s3 and s3 to local only', 2);
    break;
  }
  case 's3 rm': {
    const t = parseS3(rest[0]);
    log({ cmd, bucket: t.bucket, key: t.key });
    needBucket(t.bucket);
    rmSync(objectPath(t.bucket, t.key), { force: true });
    rmSync(metaPath(t.bucket, t.key), { force: true });
    break;
  }
  case 's3api head-object': {
    log({ cmd, bucket: opts.bucket, key: opts.key });
    const h = head(opts.bucket, opts.key);
    if (!h) die('An error occurred (404) when calling the HeadObject operation: Not Found');
    if (opts.query === 'ContentLength' && opts.output === 'text') process.stdout.write(`${h.size}\n`);
    else if (opts.query === undefined)
      process.stdout.write(`${JSON.stringify({ ContentLength: h.size, ETag: h.etag })}\n`);
    else die(`fake aws: unsupported head-object query ${opts.query}`, 2);
    break;
  }
  case 's3api get-object': {
    log({ cmd, bucket: opts.bucket, key: opts.key });
    if ((process.env.FAKE_S3_FAIL_GET_KEYS ?? '').split(',').includes(opts.key))
      die('An error occurred (InternalError) when calling the GetObject operation (reached max retries: 2)');
    const h = head(opts.bucket, opts.key);
    if (!h)
      die(
        'An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist.',
      );
    if (opts.query !== '[ContentLength,ETag,ContentType]' || opts.output !== 'text')
      die(`fake aws: unsupported get-object query ${opts.query}`, 2);
    writeFileSync(rest[0], h.body);
    process.stdout.write(`${h.size}\t${h.etag}\t${h.contentType ?? 'None'}\n`);
    break;
  }
  case 's3api list-objects-v2': {
    log({ cmd, bucket: opts.bucket, key: opts.prefix ?? '' });
    const ks = listKeys(opts.bucket, opts.prefix ?? '');
    if (opts.output !== 'text') die('fake aws: list-objects-v2 supports --output text only', 2);
    if (opts.query === 'Contents[].[Size,ETag,Key]') {
      text(
        ks.map((k) => {
          const h = head(opts.bucket, k);
          return [h.size, h.etag, k];
        }),
      );
    } else if (opts.query === 'Contents[].[Key]') text(ks.map((k) => [k]));
    else die(`fake aws: unsupported list-objects-v2 query ${opts.query}`, 2);
    break;
  }
  default:
    die(`fake aws: unsupported command ${cmd} (flags: ${[...flags].join(' ')})`, 2);
}
