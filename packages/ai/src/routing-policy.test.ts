import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRoutingPolicy } from '@oremedia/contracts/agents';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { estimateCostMicros, modelConfigFromEnv } from './model-adapter';
import {
  DEFAULT_MODEL_ID,
  assertRoutingAllowed,
  configureModelRegion,
  modelRegion,
  registerRoutingPolicySource,
  resetRoutingPolicies,
  routingPolicyFromEnv,
  setTenantRoutingPolicy,
} from './routing-policy';

afterEach(() => resetRoutingPolicies());

describe('model routing policy (spec 12.7)', () => {
  it('the built-in policy permits the configured Anthropic model and denies other vendors', async () => {
    await expect(assertRoutingAllowed('ten_A', 'anthropic', DEFAULT_MODEL_ID)).resolves.toMatchObject({
      defaultModel: DEFAULT_MODEL_ID,
    });
    await expect(assertRoutingAllowed('ten_A', 'fake', 'x')).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(assertRoutingAllowed('ten_A', 'openai', 'gpt')).rejects.toThrow(/not permitted/);
  });

  it('a tenant policy narrows vendors, models and regions', async () => {
    setTenantRoutingPolicy('ten_B', {
      schemaVersion: 1,
      defaultModel: 'claude-sonnet-5',
      permittedVendors: ['anthropic'],
      permittedRegions: ['eu'],
      deniedModels: ['claude-opus-5'],
    });
    await expect(assertRoutingAllowed('ten_B', 'anthropic', 'claude-opus-5')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await expect(assertRoutingAllowed('ten_B', 'anthropic', 'claude-sonnet-5', 'us')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await expect(assertRoutingAllowed('ten_B', 'anthropic', 'claude-sonnet-5', 'eu')).resolves.toBeDefined();
    await expect(assertRoutingAllowed('ten_A', 'anthropic', 'claude-opus-5')).resolves.toBeDefined(); // other tenants unaffected
  });

  it('regions are checked against the deployment region, and a region list with no region configured fails closed', async () => {
    setTenantRoutingPolicy('ten_R', {
      schemaVersion: 1,
      defaultModel: 'claude-sonnet-5',
      permittedVendors: ['anthropic'],
      permittedRegions: ['eu'],
      deniedModels: [],
    });
    configureModelRegion(null);
    await expect(assertRoutingAllowed('ten_R', 'anthropic', 'claude-sonnet-5')).rejects.toThrow(
      /region is not configured/,
    );
    configureModelRegion('us');
    await expect(assertRoutingAllowed('ten_R', 'anthropic', 'claude-sonnet-5')).rejects.toThrow(
      /Region us is not permitted/,
    );
    configureModelRegion('eu');
    await expect(assertRoutingAllowed('ten_R', 'anthropic', 'claude-sonnet-5')).resolves.toBeDefined();
    // A tenant without a region list is not affected by an unset region.
    configureModelRegion(null);
    await expect(assertRoutingAllowed('ten_A', 'anthropic', DEFAULT_MODEL_ID)).resolves.toBeDefined();
  });

  it('the deployment region is configuration (OREMEDIA_MODEL_REGION)', () => {
    expect(modelRegion({})).toBeNull();
    expect(modelRegion({ OREMEDIA_MODEL_REGION: ' eu ' })).toBe('eu');
    expect(modelRegion({ OREMEDIA_MODEL_REGION: '' })).toBeNull();
  });

  it('a stored document from before retention and data classes were removed still parses, without them', () => {
    const parsed = ModelRoutingPolicy.parse({
      schemaVersion: 1,
      defaultModel: 'claude-sonnet-5',
      permittedVendors: ['anthropic'],
      permittedRegions: [],
      retention: 'zero',
      dataClasses: ['brand_content'],
      deniedModels: [],
    });
    expect(parsed).not.toHaveProperty('retention');
    expect(parsed).not.toHaveProperty('dataClasses');
  });

  it('a registered source replaces the in-memory map', async () => {
    registerRoutingPolicySource(async () => ({
      schemaVersion: 1,
      defaultModel: 'm',
      permittedVendors: ['fake'],
      permittedRegions: [],
      deniedModels: [],
    }));
    await expect(assertRoutingAllowed('ten_C', 'anthropic', 'claude-opus-5')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await expect(assertRoutingAllowed('ten_C', 'fake', 'm')).resolves.toBeDefined();
  });

  it('the model id is configuration: MODEL_ROUTING_POLICY_REF (a JSON file) and OREMEDIA_MODEL_ID', () => {
    expect(routingPolicyFromEnv({}).defaultModel).toBe(DEFAULT_MODEL_ID);
    expect(routingPolicyFromEnv({ OREMEDIA_MODEL_ID: 'claude-sonnet-5' }).defaultModel).toBe(
      'claude-sonnet-5',
    );
    const dir = mkdtempSync(join(tmpdir(), 'oremedia-routing-'));
    const file = join(dir, 'routing.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: 'claude-opus-4-8',
        permittedVendors: ['anthropic'],
      }),
    );
    const policy = routingPolicyFromEnv({ MODEL_ROUTING_POLICY_REF: file });
    expect(policy).toMatchObject({
      defaultModel: 'claude-opus-4-8',
      permittedRegions: [],
    });
    expect(
      modelConfigFromEnv({ MODEL_ROUTING_POLICY_REF: file, OREMEDIA_MODEL_MAX_OUTPUT_TOKENS: '2048' }),
    ).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      maxOutputTokens: 2048,
    });
  });

  it('cost rounds up from the price list', () => {
    const cfg = modelConfigFromEnv({});
    expect(estimateCostMicros(cfg, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      cfg.inputMicrosPerMillionTokens,
    );
    expect(estimateCostMicros(cfg, { inputTokens: 1, outputTokens: 1 })).toBe(
      Math.ceil((cfg.inputMicrosPerMillionTokens + cfg.outputMicrosPerMillionTokens) / 1_000_000),
    );
  });
});
