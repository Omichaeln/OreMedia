import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedActorPlatformOperator } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { newId } from '@oremedia/domain/ids';
import { featureFlag } from '@oremedia/module-operations';
import { resetRoutingPolicies, setTenantRoutingPolicy } from '../routing-policy';
import type { ToolContext } from '../tool-registry';
import type { SpeechGenerator, ToolServices, VideoGenerator } from './services';
import { speechGenerate } from './speech';
import { videosGenerate } from './videos';

/**
 * G05: videos.generate and speech.generate are offered to an agent only while their flag is on for the run's tenant.
 * The unit tests stub the flag service; here the tools read the real feature_flags row as operations.flags.set
 * writes it, per tenant, on and off.
 */
describe('video and speech generation follow their flags (creative.video_generation, creative.audio_generation)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const operator: ResolvedActorPlatformOperator = {
    kind: 'platform_operator',
    id: newId('user'),
    tenantId: tenantA,
    supportSessionId: 'sup_flags',
    mode: 'escalated',
    expired: false,
  };
  const videos: VideoGenerator = {
    provider: 'fake',
    model: 'fake-video',
    submit: async () => ({ jobId: 'render_1' }),
    poll: async () => ({ status: 'pending' }),
  };
  const speech = { provider: 'fake', model: 'fake-speech' } as SpeechGenerator;
  const services = { flags: featureFlag, videos, speech } as unknown as ToolServices;
  const availability = (tool: typeof videosGenerate | typeof speechGenerate, tenantId: string) =>
    tool.availability!({ services, run: { tenantId } as ToolContext['run'] });
  const versions = new Map<string, number | null>();
  const setFlag = (key: 'creative.video_generation' | 'creative.audio_generation', enabled: boolean) =>
    runInTenant(
      { tenantId: tenantA, actor: operator, brandIds: 'all', correlationId: 'corr_flags' },
      async () => {
        const { flag } = await withTransaction((tx) =>
          featureFlag.set(
            operator,
            {
              key,
              target: { kind: 'tenant', tenantId: tenantA },
              enabled,
              expectedVersion: versions.get(key) ?? null,
              reason: 'pilot',
            },
            tx,
          ),
        );
        versions.set(key, flag.version);
      },
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'gen-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'gen-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
  });
  afterAll(async () => {
    await tdb?.drop();
  });
  beforeEach(() => {
    for (const t of [tenantA, tenantB])
      setTenantRoutingPolicy(t, {
        schemaVersion: 1,
        defaultModel: 'fake-model',
        permittedVendors: ['fake'],
        permittedRegions: [],
        deniedModels: [],
      });
  });
  afterEach(() => resetRoutingPolicies());

  it.each([
    { tool: videosGenerate, key: 'creative.video_generation' as const },
    { tool: speechGenerate, key: 'creative.audio_generation' as const },
  ])(
    '$key: off by default, on for the targeted tenant only, off again when withdrawn',
    async ({ tool, key }) => {
      expect(await availability(tool, tenantA)).toBe('feature_disabled');
      await setFlag(key, true);
      expect(await availability(tool, tenantA)).toBeNull();
      expect(await availability(tool, tenantB)).toBe('feature_disabled');
      await setFlag(key, false);
      expect(await availability(tool, tenantA)).toBe('feature_disabled');
    },
  );
});
