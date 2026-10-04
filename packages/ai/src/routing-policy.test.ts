import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRoutingPolicy } from '@oremedia/contracts/agents';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { brandAssistModelGate } from './brand-assist';
import { estimateCostMicros, modelConfigFromEnv } from './model-adapter';
import {
  DEFAULT_MODEL_ID,
  assertRoutingAllowed,
  configureModelRegion,
  modelRegion,
  modelRouteConfigured,
  registerRoutingPolicySource,
  routeDenial,
  resetRoutingPolicies,
  routingPolicyFromEnv,
  setTenantRoutingPolicy,
} from './routing-policy';

afterEach(() => {
  resetRoutingPolicies();
  vi.unstubAllEnvs();
});

describe('model routing policy (spec 12.7)', () => {
  it('the built-in policy permits the configured Anthropic model and denies other vendors', async () => {
    await expect(assertRoutingAllowed('ten_A', 'anthropic', DEFAULT_MODEL_ID)).resolves.toMatchObject({
      defaultModel: DEFAULT_MODEL_ID,
    });
    await expect(assertRoutingAllowed('ten_A', 'fake', 'x')).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(assertRoutingAllowed('ten_A', 'openai', 'gpt')).rejects.toThrow(/not permitted/);
  });

  it('a company with no stored policy runs under the deployment policy: an OpenRouter deployment permits its gateway', async () => {
    // Staging and production worker-core: OPENROUTER_API_KEY_REF with OREMEDIA_MODEL_ID, no MODEL_ROUTING_POLICY_REF.
    vi.stubEnv('OPENROUTER_API_KEY_REF', 'or-key');
    vi.stubEnv('OREMEDIA_MODEL_ID', 'vendor/model-x');
    resetRoutingPolicies();
    const cfg = modelConfigFromEnv();
    expect(cfg).toMatchObject({ provider: 'openrouter', model: 'vendor/model-x' });
    await expect(assertRoutingAllowed('ten_A', cfg.provider, cfg.model)).resolves.toMatchObject({
      permittedVendors: ['openrouter'],
    });
    // The gate an assist job's prepare step and start read (BSC-4) passes for the configured route.
    await expect(brandAssistModelGate().assertRouting('ten_A')).resolves.toBeUndefined();
    // The deployment policy still names only its own gateway.
    await expect(assertRoutingAllowed('ten_A', 'anthropic', DEFAULT_MODEL_ID)).rejects.toThrow(
      /vendor anthropic is not permitted/,
    );
  });

  it('a service that holds no key names the gateway with OREMEDIA_MODEL_PROVIDER, and its policy agrees with its route', async () => {
    // The api: no OPENROUTER_API_KEY_REF (it makes no model call), the deployment's route named in configuration.
    const env = { OREMEDIA_MODEL_PROVIDER: 'openrouter', OREMEDIA_MODEL_ID: 'vendor/model-x' };
    const cfg = modelConfigFromEnv(env);
    expect(cfg).toMatchObject({ provider: 'openrouter', model: 'vendor/model-x' });
    expect(routingPolicyFromEnv(env).permittedVendors).toEqual([cfg.provider]);
    expect(() => routingPolicyFromEnv({ OREMEDIA_MODEL_PROVIDER: 'openrouter' })).toThrow(
      /OREMEDIA_MODEL_ID is required on the OpenRouter gateway/,
    );
    vi.stubEnv('OREMEDIA_MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OREMEDIA_MODEL_ID', 'vendor/model-x');
    resetRoutingPolicies();
    await expect(assertRoutingAllowed('ten_A', 'openrouter', 'vendor/model-x')).resolves.toMatchObject({
      permittedVendors: ['openrouter'],
    });
  });

  it('a process knows the deployment’s route only when it is configured: a key, the gateway name or a mounted policy', () => {
    expect(modelRouteConfigured({})).toBe(false);
    expect(modelRouteConfigured({ OREMEDIA_MODEL_ID: 'vendor/model-x' })).toBe(false);
    expect(modelRouteConfigured({ MODEL_ROUTING_POLICY_REF: '/nonexistent/routing.json' })).toBe(false);
    expect(modelRouteConfigured({ OPENROUTER_API_KEY_REF: 'k', OREMEDIA_MODEL_ID: 'v/m' })).toBe(true);
    expect(modelRouteConfigured({ ANTHROPIC_API_KEY_REF: 'k' })).toBe(true);
    expect(modelRouteConfigured({ OREMEDIA_MODEL_PROVIDER: 'openrouter' })).toBe(true);
  });

  it('routeDenial names what a policy refuses of a route, as assertRoutingAllowed enforces it', () => {
    const anthropicOnly = ModelRoutingPolicy.parse({
      schemaVersion: 1,
      defaultModel: 'claude-opus-5',
      permittedVendors: ['anthropic'],
    });
    expect(routeDenial(anthropicOnly, 'openrouter', 'vendor/model-x', null)).toBe(
      'Model vendor openrouter is not permitted for this company',
    );
    expect(routeDenial(anthropicOnly, 'anthropic', 'claude-opus-5', null)).toBeNull();
    expect(
      routeDenial({ ...anthropicOnly, deniedModels: ['claude-opus-5'] }, 'anthropic', 'claude-opus-5', null),
    ).toBe('Model claude-opus-5 is not permitted for this company');
    expect(routeDenial({ ...anthropicOnly, permittedRegions: ['eu'] }, 'anthropic', 'm', null)).toMatch(
      /region is not configured/,
    );
    expect(routeDenial({ ...anthropicOnly, permittedRegions: ['eu'] }, 'anthropic', 'm', 'us')).toBe(
      'Region us is not permitted for this company',
    );
  });

  it('a stored company policy still decides over the deployment policy', async () => {
    vi.stubEnv('OPENROUTER_API_KEY_REF', 'or-key');
    vi.stubEnv('OREMEDIA_MODEL_ID', 'vendor/model-x');
    resetRoutingPolicies();
    registerRoutingPolicySource(async (tenantId) =>
      tenantId === 'ten_S'
        ? {
            schemaVersion: 1,
            defaultModel: 'claude-opus-5',
            permittedVendors: ['anthropic'],
            permittedRegions: [],
            deniedModels: [],
          }
        : null,
    );
    await expect(assertRoutingAllowed('ten_S', 'openrouter', 'vendor/model-x')).rejects.toThrow(
      /vendor openrouter is not permitted/,
    );
    await expect(assertRoutingAllowed('ten_A', 'openrouter', 'vendor/model-x')).resolves.toBeDefined();
  });

  it('a mounted MODEL_ROUTING_POLICY_REF is the deployment policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oremedia-routing-'));
    const file = join(dir, 'routing.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: 'm',
        permittedVendors: ['openrouter'],
        deniedModels: ['bad'],
      }),
    );
    vi.stubEnv('MODEL_ROUTING_POLICY_REF', file);
    resetRoutingPolicies();
    await expect(assertRoutingAllowed('ten_A', 'openrouter', 'm')).resolves.toBeDefined();
    await expect(assertRoutingAllowed('ten_A', 'openrouter', 'bad')).rejects.toThrow(/Model bad/);
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
