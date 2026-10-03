import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelVariantInput, DecryptedCredentials } from '@oremedia/contracts/providers';
import type { ProviderAdapter, PublishMedia, PublishRequest } from './contract';
import { facebookPageAdapter } from './facebook_page/adapter';
import { instagramBusinessAdapter } from './instagram_business/adapter';
import { linkedInPageAdapter } from './linkedin_page/adapter';
import { textFingerprint } from './shared';
import { FixtureServer, fixtureIO, loadScenario } from './testing';
import { xAdapter } from './x/adapter';

/**
 * STU-2a: a rendered video export (video/mp4 with its duration and frame rate) through each adapter that takes video.
 * The fixtures assert what reaches the platform: the signed release URL, the mime and the byte size (X's
 * total_bytes, LinkedIn's fileSizeBytes and part upload, Facebook's file_url, Instagram's REELS video_url). No real
 * provider is called. validateVariant enforces each capability's media.video limits with the duration.
 */
const TEXT = 'Hello from Oremedia #launch';
const BODY = 'MP4-EXPORT-BYTES-0123456';
const exportMedia: PublishMedia = {
  url: 'https://media.oremedia.test/release/export.mp4',
  mime: 'video/mp4',
  width: 1080,
  height: 1920,
  bytes: BODY.length,
  contentHash: 'e'.repeat(64),
  durationMs: 15_000,
  fps: 30,
};
const request = (remoteAccountId: string): PublishRequest => ({
  publicationId: 'pub_v',
  attemptId: 'att_v',
  idempotencyKey: 'att_v',
  remoteAccountId,
  text: TEXT,
  media: [exportMedia],
  settings: {},
  textFingerprint: textFingerprint(TEXT),
  mediaFingerprints: [exportMedia.contentHash],
});

const cases: Array<{
  adapter: ProviderAdapter;
  dir: string;
  scenario: string;
  account: string;
  creds: DecryptedCredentials;
  calls: string[];
  pending: Record<string, unknown>;
}> = [
  {
    adapter: xAdapter,
    dir: 'x',
    scenario: 'video_export_pending',
    account: 'u_42',
    creds: { accessToken: 'xat_1_fake', extra: { username: 'oremedia' } },
    calls: [
      'R GET /release/export.mp4',
      'M POST /2/media/upload/initialize',
      'M POST /2/media/upload/m_x/append',
      'M POST /2/media/upload/m_x/finalize',
    ],
    pending: { outcome: 'pending', remoteJobId: 'm_x' },
  },
  {
    adapter: linkedInPageAdapter,
    dir: 'linkedin_page',
    scenario: 'video_pending',
    account: '2001',
    creds: { accessToken: 'at_1_fake', extra: { organizationUrn: 'urn:li:organization:2001' } },
    calls: [
      'R GET /release/export.mp4',
      'M POST /rest/videos',
      'M PUT /dms-uploads/V1/part1',
      'M POST /rest/videos',
    ],
    pending: {
      outcome: 'pending',
      remoteJobId: 'urn:li:video:V1',
      pending: { data: { media: [{ urn: 'urn:li:video:V1', kind: 'video' }] } },
    },
  },
  {
    adapter: facebookPageAdapter,
    dir: 'facebook_page',
    scenario: 'video_export_pending',
    account: 'p_100',
    creds: { accessToken: 'page_100_fake', extra: { pageId: 'p_100' } },
    calls: ['M POST /v25.0/p_100/videos'],
    pending: { outcome: 'pending', remoteJobId: 'vid_88' },
  },
  {
    adapter: instagramBusinessAdapter,
    dir: 'instagram_business',
    scenario: 'reel_pending',
    account: 'ig_900',
    creds: { accessToken: 'long_user_fake', extra: { igUserId: 'ig_900', pageId: 'p_100' } },
    calls: ['M POST /v25.0/ig_900/media'],
    pending: { outcome: 'pending' },
  },
];

describe('video exports through the provider adapters (fixtures, no real provider)', () => {
  const server = new FixtureServer();
  beforeAll(() => server.start());
  afterAll(() => server.stop());

  it.each(cases)('$dir publishes the export with its mime and size and reports pending', async (c) => {
    const io = await fixtureIO(server, { providerKey: c.adapter.key });
    server.load(loadScenario(new URL(`./${c.dir}/fixtures/publish.json`, import.meta.url), c.scenario));
    const out = await c.adapter.publish(request(c.account), c.creds, io);
    expect(out).toMatchObject(c.pending);
    expect(io.calls.map((x) => `${x.mutation ? 'M' : 'R'} ${x.method} ${new URL(x.url).pathname}`)).toEqual(
      c.calls,
    );
    // Every exchange matched, including the body checks on mime, size and URL.
    expect(server.remaining()).toEqual([]);
  });

  it.each(cases)('$dir validates the video duration and size against its capability', (c) => {
    const limits = c.adapter.capability.media.video;
    expect(limits).toBeDefined();
    if (!limits) return;
    const variant = (media: ChannelVariantInput['media'][number]): ChannelVariantInput => ({
      text: 'x',
      altTexts: [],
      media: [media],
      settings: {},
    });
    const base = { mime: 'video/mp4', width: 1080, height: 1920, bytes: 1000, fps: 30 };
    const issues = (m: ChannelVariantInput['media'][number]) =>
      c.adapter.validateVariant(variant(m)).issues.map((i) => i.issue);
    expect(issues({ ...base, durationMs: 15_000 }).filter((i) => i.startsWith('video_'))).toEqual([]);
    expect(issues({ ...base, durationMs: limits.maxDurationSec * 1000 + 1000 })).toContain(
      `video_too_long:${limits.maxDurationSec + 1}s>${limits.maxDurationSec}s`,
    );
    expect(issues({ ...base, durationMs: 15_000, bytes: limits.maxBytes + 1 })).toContain(
      `video_too_large:${limits.maxBytes + 1}>${limits.maxBytes}`,
    );
    expect(issues(base)).toContain('video_duration_unknown');
  });
});
