import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_MESSAGES,
  fetchReviewMessages,
  persistStatuses,
  type GmailClient,
  type ReviewMessage,
  type ReviewStatus,
  type ReviewStatusStore,
} from './main';

/** A Gmail mailbox stub: `pages` of message ids for messages.list, and the metadata of each message by id. */
function stubGmail(
  pages: string[][],
  meta: Record<string, { from: string; subject: string; snippet?: string; internalDate: number }> = {},
) {
  const calls: Array<{ path: string; params: Record<string, string | string[]> }> = [];
  const gmail: GmailClient = {
    async get<T>(path: string, params: Record<string, string | string[]>): Promise<T> {
      calls.push({ path, params });
      if (path === 'messages') {
        const index = params['pageToken'] ? Number(String(params['pageToken']).slice(1)) : 0;
        const ids = pages[index] ?? [];
        return {
          messages: ids.map((id) => ({ id })),
          ...(index + 1 < pages.length ? { nextPageToken: `p${index + 1}` } : {}),
        } as T;
      }
      const id = decodeURIComponent(path.slice('messages/'.length));
      const m = meta[id] ?? { from: 'someone@example.test', subject: 'hello', internalDate: 0 };
      return {
        id,
        internalDate: String(m.internalDate),
        snippet: m.snippet ?? '',
        payload: {
          headers: [
            { name: 'From', value: m.from },
            { name: 'subject', value: m.subject }, // header names are matched case-insensitively
          ],
        },
      } as T;
    },
  };
  return { gmail, calls, listCalls: () => calls.filter((c) => c.path === 'messages') };
}

/** provider_review_statuses stub: the rows a run starts from and every upsert it makes. */
function stubStore(rows: Array<{ providerKey: string; status: ReviewStatus }> = []) {
  const upserts: Array<Parameters<ReviewStatusStore['upsert']>[0]> = [];
  const store: ReviewStatusStore = {
    current: async () => rows,
    upsert: async (values) => {
      upserts.push(values);
    },
  };
  return { store, upserts, byProvider: (key: string) => upserts.find((u) => u.providerKey === key) };
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('Gmail paging (fetchReviewMessages)', () => {
  it('follows nextPageToken until the last page and reads each message once', async () => {
    const { gmail, listCalls, calls } = stubGmail([ids('a', 2), ids('b', 2), ids('c', 1)]);
    const messages = await fetchReviewMessages(gmail);
    expect(listCalls().map((c) => c.params['pageToken'] ?? null)).toEqual([null, 'p1', 'p2']);
    expect(
      listCalls().every((c) => c.params['maxResults'] === '100' && typeof c.params['q'] === 'string'),
    ).toBe(true);
    expect(messages.map((m) => m.id).sort()).toEqual(['a0', 'a1', 'b0', 'b1', 'c0']);
    const reads = calls.filter((c) => c.path !== 'messages');
    expect(reads).toHaveLength(5);
    expect(reads[0]!.params).toEqual({ format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
  });

  it(`stops listing once ${MAX_REVIEW_MESSAGES} ids are collected, even with more pages`, async () => {
    const pages = [ids('a', 100), ids('b', 100), ids('c', 100), ids('d', 100)];
    const { gmail, listCalls } = stubGmail(pages);
    const messages = await fetchReviewMessages(gmail);
    expect(listCalls()).toHaveLength(3);
    expect(messages).toHaveLength(MAX_REVIEW_MESSAGES);
  });

  it('a mailbox with no matching mail lists once and reads nothing', async () => {
    const { gmail, calls } = stubGmail([[]]);
    expect(await fetchReviewMessages(gmail)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('maps headers and snippet, and returns the newest message first', async () => {
    const { gmail } = stubGmail([['old', 'new']], {
      old: { from: 'LinkedIn <noreply@linkedin.com>', subject: 'In review', internalDate: 1000 },
      new: {
        from: 'LinkedIn <noreply@linkedin.com>',
        subject: 'Approved',
        snippet: 'ok',
        internalDate: 2000,
      },
    });
    const messages = await fetchReviewMessages(gmail);
    expect(messages).toEqual([
      {
        id: 'new',
        internalDate: 2000,
        sender: 'LinkedIn <noreply@linkedin.com>',
        subject: 'Approved',
        snippet: 'ok',
      },
      {
        id: 'old',
        internalDate: 1000,
        sender: 'LinkedIn <noreply@linkedin.com>',
        subject: 'In review',
        snippet: '',
      },
    ]);
  });

  it('a Gmail failure propagates (the run fails and exits non-zero)', async () => {
    const gmail: GmailClient = {
      get: async () => {
        throw new Error('Gmail API messages failed: 401');
      },
    };
    await expect(fetchReviewMessages(gmail)).rejects.toThrow('Gmail API messages failed: 401');
  });
});

describe('persistStatuses', () => {
  const checkedAt = new Date('2026-10-04T10:00:00.000Z');
  const msg = (
    m: Partial<ReviewMessage> & Pick<ReviewMessage, 'id' | 'sender' | 'subject'>,
  ): ReviewMessage => ({
    internalDate: Date.parse('2026-10-03T09:00:00.000Z'),
    snippet: '',
    ...m,
  });

  it('writes the newest classified mail per provider: Meta mail covers Facebook and Instagram', async () => {
    const { store, upserts, byProvider } = stubStore();
    const matched = await persistStatuses(
      [
        // Sorted newest first, as fetchReviewMessages returns them.
        msg({
          id: 'm2',
          sender: 'Meta for Developers <platform@facebookmail.com>',
          subject: 'Your app review is approved for Live Mode',
          snippet: 'You can now use the approved permissions.',
        }),
        msg({
          id: 'm1',
          sender: 'Meta <platform@facebookmail.com>',
          subject: 'Your submission is under review',
        }),
        msg({
          id: 'l1',
          sender: 'LinkedIn <noreply@linkedin.com>',
          subject: 'Action required on your application',
        }),
        msg({ id: 'x1', sender: 'news@example.test', subject: 'Weekly digest' }), // not a provider mail
      ],
      checkedAt,
      store,
    );
    expect(matched).toBe(3);
    expect(upserts.map((u) => u.providerKey)).toEqual([
      'facebook_page',
      'instagram_business',
      'linkedin_page',
    ]);
    for (const key of ['facebook_page', 'instagram_business'])
      expect(byProvider(key)).toMatchObject({
        status: 'approved',
        source: 'gmail',
        lastMessageId: 'm2',
        lastReceivedAt: new Date('2026-10-03T09:00:00.000Z'),
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt,
        evidence: { providerGroup: 'meta', matchedTerms: expect.arrayContaining(['approved']) },
      });
    expect(byProvider('linkedin_page')).toMatchObject({
      status: 'action_required',
      lastMessageId: 'l1',
      evidence: { providerGroup: 'linkedin', matchedTerms: ['action required'] },
    });
  });

  it('a provider without new mail keeps its previous status and only moves the check time', async () => {
    const { store, byProvider } = stubStore([
      { providerKey: 'linkedin_page', status: 'approved' },
      { providerKey: 'facebook_page', status: 'rejected' },
    ]);
    expect(await persistStatuses([], checkedAt, store)).toBe(0);
    expect(byProvider('linkedin_page')).toEqual({
      providerKey: 'linkedin_page',
      status: 'approved',
      source: 'gmail',
      lastCheckedAt: checkedAt,
      updatedAt: checkedAt,
    });
    expect(byProvider('facebook_page')).toMatchObject({ status: 'rejected' });
    // Never seen before: recorded as unknown, without message fields to overwrite.
    expect(byProvider('instagram_business')).toEqual({
      providerKey: 'instagram_business',
      status: 'unknown',
      source: 'gmail',
      lastCheckedAt: checkedAt,
      updatedAt: checkedAt,
    });
  });

  it('truncates long mail fields to the column sizes; a message without a date uses the check time', async () => {
    const { store, byProvider } = stubStore();
    await persistStatuses(
      [
        msg({
          id: 'l2',
          internalDate: 0,
          sender: `LinkedIn <${'x'.repeat(400)}@linkedin.com>`,
          subject: `Approved ${'s'.repeat(600)}`,
          snippet: 'n'.repeat(700),
        }),
      ],
      checkedAt,
      store,
    );
    const row = byProvider('linkedin_page')!;
    expect(row.lastSubject).toHaveLength(500);
    expect(row.lastSender).toHaveLength(320);
    expect(row.evidence?.snippet).toHaveLength(500);
    expect(row.lastReceivedAt).toEqual(checkedAt);
  });
});
