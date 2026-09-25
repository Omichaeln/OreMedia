/**
 * `pnpm certify <provider> <command> [options]`: the certification harness (docs/runbooks/certify-a-channel.md,
 * "Running the certification harness"). Runs on a person's machine against the real platform with test accounts; it
 * changes nothing in the running product.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  authUrl,
  buildDeps,
  comments,
  exchange,
  find,
  metrics,
  pendingStep,
  publish,
  refresh,
  selectAccount,
  type PublishInput,
} from './harness';

const ROOT = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
);

const USAGE = `Usage: pnpm certify <provider> <command> [options]

Providers: linkedin_page, instagram_business, facebook_page, x
Client credentials come from PROVIDER_<KEY>_CLIENT_ID_REF and PROVIDER_<KEY>_SECRET_REF in this shell.

Commands (runbook step in brackets):
  auth-url --redirect-uri <uri>            [3] print the consent URL for the test account
  exchange --code <code> [--state <s>]     [3] exchange the code; shows scopes, missing scopes, other accounts
  select-account --account <id>            [3] switch to another page or organisation of the same login
  publish --text <t> [--image <url,mime,w,h,bytes[,alt]>]...
                                           [4] publish to the connected test account
  status | finalize                        [4] follow the last publish while it is pending
  find                                     [5] reconcile the last publish (found / definitely_absent / cannot_determine)
  refresh                                  [7] refresh the token (after revoking the app: reconnect_required)
  metrics [--account-metrics] [--post <id>] [--hours <n>]
                                           [9] post or account metrics; lists declared metrics not returned
  comments [--post <id>] [--cursor <c>] [--reply <text>]
                                           [10] read comments or reply
  forget                                   delete the stored test-account session

Every request and response is recorded, redacted, under .certify/<provider>/recordings/ for the fixtures (step 6).`;

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
      post: { type: 'string' },
      hours: { type: 'string' },
      cursor: { type: 'string' },
      reply: { type: 'string' },
      'account-metrics': { type: 'boolean' },
    },
    allowPositionals: false,
  });
  const deps = buildDeps({ root: ROOT, providerKey, command, out: (line) => console.log(line) });
  switch (command) {
    case 'auth-url':
      if (!values['redirect-uri'])
        throw new Error('--redirect-uri is required (as registered in the platform app)');
      return authUrl(deps, values['redirect-uri']);
    case 'exchange':
      if (!values.code) throw new Error('--code is required');
      return exchange(deps, values.code, values.state);
    case 'select-account':
      if (!values.account) throw new Error('--account is required');
      return selectAccount(deps, values.account);
    case 'publish':
      if (values.text === undefined) throw new Error('--text is required');
      return publish(deps, { text: values.text, media: (values.image ?? []).map(parseImage) });
    case 'status':
    case 'finalize':
      return pendingStep(deps, command);
    case 'find':
      return find(deps);
    case 'refresh':
      return refresh(deps);
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
    case 'forget':
      deps.forget();
      console.log(`Removed the stored session for ${providerKey}. Recordings are kept.`);
      return;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
