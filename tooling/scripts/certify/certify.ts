/**
 * `pnpm certify <provider> <command> [options]`: the certification harness (docs/runbooks/certify-a-provider.md,
 * "Running the certification harness"). Runs on a person's machine against the real platform with test accounts; it
 * changes nothing in the running product. The provider's kind (channel, source, CMS) is found in the registries
 * and decides which commands apply; `status`, `attest` and `forget` apply to every kind.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cmsConnect, cmsDelete, cmsRevoke, cmsUnpublish, cmsUpdate, cmsVerify, cmsWrite } from './cms';
import {
  attest,
  authUrl,
  buildDeps,
  comments,
  deletePost,
  editPost,
  exchange,
  find,
  metrics,
  pendingStep,
  publish,
  refresh,
  revoke,
  selectAccount,
  status,
  type PublishInput,
} from './harness';
import {
  sourceAuthUrl,
  sourceExchange,
  sourceRead,
  sourceRefresh,
  sourceRevoke,
  sourceTargets,
} from './source';

const ROOT = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
);

const USAGE = `Usage: pnpm certify <provider> <command> [options]

Providers: channels linkedin_page, instagram_business, facebook_page, x; sources ga4_property, search_console_site,
gbp_location; CMS cms_site (WordPress). Client credentials come from PROVIDER_<KEY>_CLIENT_ID_REF and
PROVIDER_<KEY>_SECRET_REF in this shell (channels and sources; a CMS site needs none).

Every kind (runbook steps in brackets):
  status                                   [12] the required steps with what each run established
  attest --environment <name>              [12] write .certify/<provider>/certification.json, only when every step
                                           passed, with each capability whose steps passed (PR-06)
  forget                                   delete the stored test-account session (recordings are kept)

Channel commands:
  auth-url --redirect-uri <uri>            [3] print the consent URL for the test account
  exchange --code <code> [--state <s>]     [3] exchange the code; shows scopes, missing scopes, other accounts
  select-account --account <id>            [3] switch to another page or organisation of the same login
  publish --text <t> [--image <url,mime,w,h,bytes[,alt]>]... [--video <url,mime,w,h,bytes,durationMs>]
                                           [4] publish to the connected test account (text alone, images
                                           or a video: each certifies its own publish capability)
  pending-status | finalize                [4] follow the last publish while it is pending
  find                                     [5] reconcile the last publish (found / definitely_absent / cannot_determine)
  edit-post --text <t>                     [5] edit the last publish through the adapter and read it back
  delete-post                              [5] delete the last publish through the adapter and prove it absent
  refresh                                  [7] refresh the token (after revoke: reconnect_required proves the revoke)
  metrics [--account-metrics] [--post <id>] [--hours <n>]
                                           [9] post or account metrics; lists declared metrics not returned
  comments [--post <id>] [--cursor <c>] [--reply <text>]
                                           [10] read comments or reply
  revoke                                   [11] revoke the grant at the platform (the adapter's revokeAccess), then refresh

Source commands:
  auth-url --redirect-uri <uri>            [3] print the vendor's consent URL
  exchange --code <code> [--state <s>]     [3] exchange the code; shows granted and missing scopes
  targets [--target <externalId>]          [4] the properties / sites / locations the grant can read; choose one
  read [--report <key>] [--days <n>]       [5] one page of a report of the chosen target (default: the first report, 7 days)
  refresh                                  [7] refresh the token (after revoke: reconnect_required proves the revoke)
  revoke                                   [11] revoke the grant at the vendor, then refresh

CMS commands:
  connect --site <https origin> --username <u> --secret <application password>
                                           [3] keep the site and secret in the session and verify the identity
  verify                                   [3] verify the identity (after revoke: reconnect_required proves the revoke)
  write --title <t> --html <h> [--publish] [4] create a draft article (live only with --publish) and read it back
  update --html <h>                        [4] update it under the read-back precondition and read it back
  unpublish                                [5] set it back to a draft and read it back
  delete                                   [5] delete it and prove it absent
  revoke                                   [11] revoke the application password on the site, then verify

Every request and response is recorded, redacted, under .certify/<provider>/recordings/ for the fixtures (step 6).`;

/** `--video url,mime,width,height,bytes,durationMs`: a video at a public HTTPS URL with its measured duration. */
function parseVideo(spec: string): PublishInput['media'][number] {
  const [url, mime, width, height, bytes, durationMs] = spec.split(',');
  if (!url || !mime || !width || !height || !bytes || !durationMs)
    throw new Error(`--video needs url,mime,width,height,bytes,durationMs: ${spec}`);
  return {
    url,
    mime,
    width: Number(width),
    height: Number(height),
    bytes: Number(bytes),
    durationMs: Number(durationMs),
  };
}

function parseImage(spec: string): PublishInput['media'][number] {
  const [url, mime, width, height, bytes, altText] = spec.split(',');
  if (!url || !mime || !width || !height || !bytes)
    throw new Error(`--image needs url,mime,width,height,bytes: ${spec}`);
  return {
    url,
    mime,
    width: Number(width),
    height: Number(height),
    bytes: Number(bytes),
    ...(altText ? { altText } : {}),
  };
}

const required = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

async function main(argv: string[]): Promise<void> {
  const [providerKey, command, ...rest] = argv;
  if (!providerKey || !command || providerKey === '--help') {
    console.log(USAGE);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      'redirect-uri': { type: 'string' },
      code: { type: 'string' },
      state: { type: 'string' },
      account: { type: 'string' },
      text: { type: 'string' },
      image: { type: 'string', multiple: true },
      video: { type: 'string', multiple: true },
      post: { type: 'string' },
      hours: { type: 'string' },
      cursor: { type: 'string' },
      reply: { type: 'string' },
      'account-metrics': { type: 'boolean' },
      target: { type: 'string' },
      report: { type: 'string' },
      days: { type: 'string' },
      site: { type: 'string' },
      username: { type: 'string' },
      secret: { type: 'string' },
      title: { type: 'string' },
      html: { type: 'string' },
      publish: { type: 'boolean' },
      environment: { type: 'string' },
    },
    allowPositionals: false,
  });
  const deps = buildDeps({ root: ROOT, providerKey, command, out: (line) => console.log(line) });
  switch (command) {
    case 'status':
      return status(deps);
    case 'attest':
      attest(deps, deps.writeCertification, required(values.environment, 'environment'));
      console.log(`Record written to ${deps.certificationFile}`);
      return;
    case 'forget':
      deps.forget();
      console.log(`Removed the stored session for ${providerKey}. Recordings are kept.`);
      return;
  }
  if (deps.kind === 'channel') {
    switch (command) {
      case 'auth-url':
        return authUrl(deps, required(values['redirect-uri'], 'redirect-uri'));
      case 'exchange':
        return exchange(deps, required(values.code, 'code'), values.state);
      case 'select-account':
        return selectAccount(deps, required(values.account, 'account'));
      case 'publish':
        if (values.text === undefined) throw new Error('--text is required');
        return publish(deps, {
          text: values.text,
          media: [...(values.image ?? []).map(parseImage), ...(values.video ?? []).map(parseVideo)],
        });
      case 'pending-status':
        return pendingStep(deps, 'status');
      case 'finalize':
        return pendingStep(deps, 'finalize');
      case 'find':
        return find(deps);
      case 'edit-post':
        return editPost(deps, required(values.text, 'text'));
      case 'delete-post':
        return deletePost(deps);
      case 'refresh':
        return refresh(deps);
      case 'revoke':
        return revoke(deps);
      case 'metrics':
        return metrics(
          deps,
          values['account-metrics'] ? 'account' : 'post',
          values.hours ? Number(values.hours) : 24,
          values.post,
        );
      case 'comments':
        return comments(deps, {
          ...(values.post ? { remotePostId: values.post } : {}),
          ...(values.cursor ? { cursor: values.cursor } : {}),
          ...(values.reply !== undefined ? { reply: values.reply } : {}),
        });
    }
  } else if (deps.kind === 'source') {
    switch (command) {
      case 'auth-url':
        return sourceAuthUrl(deps, required(values['redirect-uri'], 'redirect-uri'));
      case 'exchange':
        return sourceExchange(deps, required(values.code, 'code'), values.state);
      case 'targets':
        return sourceTargets(deps, values.target);
      case 'read':
        return sourceRead(deps, values.report, values.days ? Number(values.days) : 7);
      case 'refresh':
        return sourceRefresh(deps);
      case 'revoke':
        return sourceRevoke(deps);
    }
  } else {
    switch (command) {
      case 'connect':
        return cmsConnect(
          deps,
          { siteUrl: required(values.site, 'site'), username: required(values.username, 'username') },
          required(values.secret, 'secret'),
        );
      case 'verify':
        return cmsVerify(deps);
      case 'write':
        return cmsWrite(deps, {
          title: required(values.title, 'title'),
          html: required(values.html, 'html'),
          publish: values.publish === true,
        });
      case 'update':
        return cmsUpdate(deps, required(values.html, 'html'));
      case 'unpublish':
        return cmsUnpublish(deps);
      case 'delete':
        return cmsDelete(deps);
      case 'revoke':
        return cmsRevoke(deps);
    }
  }
  console.log(`${command} is not a ${deps.kind} command.\n\n${USAGE}`);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
