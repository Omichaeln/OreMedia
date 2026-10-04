import { fileURLToPath } from 'node:url';
import { closeDatabase, configureDatabase, getDb, runMigrations } from '@oremedia/db';
import { providerReviewStatuses } from '@oremedia/db/schema/platform';
import { startTelemetry, stopTelemetry } from '@oremedia/observability';

export const MONITORED_PROVIDERS = ['facebook_page', 'instagram_business', 'linkedin_page'] as const;
export type MonitoredProvider = (typeof MONITORED_PROVIDERS)[number];
export type ReviewStatus = 'unknown' | 'under_review' | 'approved' | 'rejected' | 'action_required';

type ProviderGroup = 'meta' | 'linkedin';
export interface ReviewMessage {
  id: string;
  internalDate: number;
  sender: string;
  subject: string;
  snippet: string;
}
export interface ReviewMatch {
  status: ReviewStatus;
  providerGroup: ProviderGroup;
  matchedTerms: string[];
}

const monitoredQuery =
  process.env['GMAIL_REVIEW_QUERY'] ??
  'newer_than:30d (from:(linkedin.com) OR from:(facebookmail.com) OR from:(meta.com))';

const terms = (text: string, candidates: string[]): string[] =>
  candidates.filter((term) => text.includes(term));

export function classifyReviewMessage(
  message: Pick<ReviewMessage, 'sender' | 'subject' | 'snippet'>,
): ReviewMatch | null {
  const text = `${message.sender} ${message.subject} ${message.snippet}`.toLowerCase();
  const providerGroup: ProviderGroup | null = text.includes('linkedin')
    ? 'linkedin'
    : text.includes('facebook') || text.includes('instagram') || text.includes('meta')
      ? 'meta'
      : null;
  if (!providerGroup) return null;

  const rejected = terms(text, ['rejected', 'declined', 'not approved', 'unable to approve', 'denied']);
  if (rejected.length > 0) return { status: 'rejected', providerGroup, matchedTerms: rejected };

  const actionRequired = terms(text, [
    'action required',
    'needs more information',
    'more information required',
    'take action',
  ]);
  if (actionRequired.length > 0)
    return { status: 'action_required', providerGroup, matchedTerms: actionRequired };

  const approved = terms(text, ['approved', 'approval complete', 'review complete', 'accepted', 'live mode']);
  if (approved.length > 0) return { status: 'approved', providerGroup, matchedTerms: approved };

  const underReview = terms(text, ['under review', 'in review', 'reviewing', 'submitted for review']);
  if (underReview.length > 0) return { status: 'under_review', providerGroup, matchedTerms: underReview };

  return { status: 'unknown', providerGroup, matchedTerms: [] };
}

/** The providers each review mail family covers (a lookup, so no provider key is branched on here). */
const PROVIDERS_BY_GROUP: Readonly<Record<ProviderGroup, readonly MonitoredProvider[]>> = {
  linkedin: ['linkedin_page'],
  meta: ['facebook_page', 'instagram_business'],
};

function providersFor(group: ProviderGroup): readonly MonitoredProvider[] {
  return PROVIDERS_BY_GROUP[group];
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

async function gmailAccessToken(): Promise<string> {
  const clientId = process.env['GMAIL_CLIENT_ID'];
  const clientSecret = process.env['GMAIL_CLIENT_SECRET'];
  const refreshToken = process.env['GMAIL_REFRESH_TOKEN'];
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN are required');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new Error(
      `Gmail token refresh failed: ${body.error ?? response.status} ${body.error_description ?? ''}`.trim(),
    );
  }
  return body.access_token;
}

async function gmailJson<T>(
  accessToken: string,
  path: string,
  params: Record<string, string | string[]>,
): Promise<T> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 300) };
  }
  if (!response.ok) throw new Error(`Gmail API ${path} failed: ${response.status}`);
  return body as T;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
}
interface GmailMessageResponse {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}

/** The Gmail reads the monitor makes (users/me/<path>); a stub in the unit tests. */
export interface GmailClient {
  get<T>(path: string, params: Record<string, string | string[]>): Promise<T>;
}

const gmailClient = (accessToken: string): GmailClient => ({
  get: (path, params) => gmailJson(accessToken, path, params),
});

/** Message ids are listed page by page (newest first) until the pages run out or this many are collected. */
export const MAX_REVIEW_MESSAGES = 300;

export async function fetchReviewMessages(gmail: GmailClient): Promise<ReviewMessage[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail.get<GmailListResponse>('messages', {
      q: monitoredQuery,
      maxResults: '100',
      ...(pageToken ? { pageToken } : {}),
    });
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < MAX_REVIEW_MESSAGES);

  const messages: ReviewMessage[] = [];
  for (const id of ids) {
    const message = await gmail.get<GmailMessageResponse>(`messages/${encodeURIComponent(id)}`, {
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    messages.push({
      id: message.id,
      internalDate: Number(message.internalDate ?? 0),
      sender: header(message.payload?.headers, 'From'),
      subject: header(message.payload?.headers, 'Subject'),
      snippet: message.snippet ?? '',
    });
  }
  return messages.sort((a, b) => b.internalDate - a.internalDate);
}

/** The provider_review_statuses reads and writes of one run; a stub in the unit tests. */
export interface ReviewStatusStore {
  current(): Promise<Array<{ providerKey: string; status: ReviewStatus }>>;
  upsert(values: typeof providerReviewStatuses.$inferInsert): Promise<void>;
}

const databaseStore: ReviewStatusStore = {
  current: () => getDb().select().from(providerReviewStatuses),
  async upsert(values) {
    await getDb().insert(providerReviewStatuses).values(values).onDuplicateKeyUpdate({ set: values });
  },
};

/**
 * One row per monitored provider: the newest classified message of its mail family, or, when none matched this run,
 * the previous status with only the check time moved. Returns how many providers matched a message.
 */
export async function persistStatuses(
  messages: ReviewMessage[],
  checkedAt: Date,
  store: ReviewStatusStore = databaseStore,
): Promise<number> {
  const current = await store.current();
  const currentByProvider = new Map(current.map((row) => [row.providerKey, row]));
  const latest = new Map<MonitoredProvider, { message: ReviewMessage; match: ReviewMatch }>();

  for (const message of messages) {
    const match = classifyReviewMessage(message);
    if (!match) continue;
    for (const providerKey of providersFor(match.providerGroup)) {
      if (!latest.has(providerKey)) latest.set(providerKey, { message, match });
    }
  }

  for (const providerKey of MONITORED_PROVIDERS) {
    const found = latest.get(providerKey);
    const previous = currentByProvider.get(providerKey);
    const values = found
      ? {
          providerKey,
          status: found.match.status,
          source: 'gmail' as const,
          lastMessageId: found.message.id,
          lastSubject: found.message.subject.slice(0, 500),
          lastSender: found.message.sender.slice(0, 320),
          lastReceivedAt: new Date(found.message.internalDate || checkedAt.getTime()),
          lastCheckedAt: checkedAt,
          evidence: {
            providerGroup: found.match.providerGroup,
            matchedTerms: found.match.matchedTerms,
            snippet: found.message.snippet.slice(0, 500),
          },
          updatedAt: checkedAt,
        }
      : {
          providerKey,
          status: previous?.status ?? ('unknown' as const),
          source: 'gmail' as const,
          lastCheckedAt: checkedAt,
          updatedAt: checkedAt,
        };
    await store.upsert(values);
  }
  return latest.size;
}

export async function runApprovalMonitor(): Promise<{ messages: number; matchedProviders: number }> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  // Migrations need DDL the application role lacks (D-25): the admin connection when set, as apps/api/src/migrate.ts.
  await runMigrations(process.env['DATABASE_URL_MIGRATE'] ?? databaseUrl);
  configureDatabase({ url: databaseUrl, connectionLimit: 2 });
  const messages = await fetchReviewMessages(gmailClient(await gmailAccessToken()));
  const matchedProviders = await persistStatuses(messages, new Date());
  return { messages: messages.length, matchedProviders };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const log = startTelemetry({
    service: 'oremedia-approval-monitor',
    version: process.env['OREMEDIA_VERSION'],
  });
  try {
    const result = await runApprovalMonitor();
    log.info({ ...result, query: monitoredQuery }, 'provider review status monitor completed');
  } catch (err) {
    log.error(
      { errorMessage: err instanceof Error ? err.message : String(err) },
      'provider review status monitor failed',
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase();
    await stopTelemetry();
  }
}
