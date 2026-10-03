import { emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** Every id points at the foreign tenant (brand ids from the base seed, version/fact/objective/policy ids from BRAND_SEED). */
export const BRAND_INPUTS: Record<string, CrossTenantFixture> = {
  'brand.create': {
    buildInput: null,
    reason: "no resource ids; the brand is created in the caller's tenant",
  },
  'brand.completeSetup': { buildInput: (f) => ({ brandId: f['brandId'], expectedVersion: 0 }) },
  'brand.classify': {
    buildInput: (f) => ({ brandId: f['brandId'], classification: 'internal', expectedVersion: 0 }),
  },
  'brand.list': { buildInput: null, reason: "no input; lists only the caller's visible brands" },
  'brand.summary': { buildInput: null, reason: "no input; counts only the caller's visible brands" },
  'brand.get': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'brand.versions.createDraft': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'brand.versions.update': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      versionId: f['brandVersionId'],
      expectedVersion: 0,
      document: emptyBrandSystemDocument(),
    }),
  },
  'brand.versions.submitForReview': {
    buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'], expectedVersion: 0 }),
  },
  'brand.versions.publish': {
    buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'], expectedVersion: 0 }),
  },
  'brand.versions.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'brand.versions.get': { buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'] }) },
  'brand.versions.impact': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'brand.system.save': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      basedOnVersionId: null,
      document: emptyBrandSystemDocument(),
      proposal: { versionId: f['brandVersionId'], expectedVersion: 0 },
    }),
  },
  'brand.sources.add': {
    buildInput: (f) => ({ kind: 'url', brandId: f['brandId'], url: 'https://example.com/' }),
  },
  'brand.sources.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'brand.sources.get': { buildInput: (f) => ({ brandId: f['brandId'], sourceId: f['brandSourceId'] }) },
  'brand.sources.remove': {
    buildInput: (f) => ({ brandId: f['brandId'], sourceId: f['brandSourceId'], expectedVersion: 0 }),
  },
  'brand.assist.estimate': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      kind: 'setup',
      sections: ['voice'],
      sourceIds: [f['brandSourceId']],
    }),
  },
  'brand.assist.start': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      kind: 'setup',
      sections: ['voice'],
      sourceIds: [f['brandSourceId']],
    }),
  },
  'brand.assist.get': { buildInput: (f) => ({ brandId: f['brandId'], jobId: f['brandAssistJobId'] }) },
  'brand.assist.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'brand.assist.cancel': { buildInput: (f) => ({ brandId: f['brandId'], jobId: f['brandAssistJobId'] }) },
  'brand.assist.answer': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      jobId: f['brandAssistJobId'],
      answers: [{ questionId: 'q1', answer: 'x' }],
    }),
  },
  'brand.suggestions.list': {
    buildInput: (f) => ({ brandId: f['brandId'], jobId: f['brandAssistJobId'], page: { limit: 50 } }),
  },
  'brand.suggestions.accept': {
    buildInput: (f) => ({ brandId: f['brandId'], suggestionIds: [f['brandSuggestionId']] }),
  },
  'brand.suggestions.edit': {
    buildInput: (f) => ({ brandId: f['brandId'], suggestionId: f['brandSuggestionId'], value: 'x' }),
  },
  'brand.suggestions.reject': {
    buildInput: (f) => ({ brandId: f['brandId'], suggestionIds: [f['brandSuggestionId']] }),
  },
  'brand.suggestions.acceptAll': {
    buildInput: (f) => ({ brandId: f['brandId'], jobId: f['brandAssistJobId'], section: 'voice' }),
  },
  'brand.suggestions.undo': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'brand.history.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'brand.history.compare': {
    buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'] }),
  },
  'brand.history.restore': {
    buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'], basedOnVersionId: null }),
  },
  'brand.system.discardProposal': {
    buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'], expectedVersion: 0 }),
  },
  'brand.facts.propose': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      kind: 'claim',
      statement: 'x',
      evidence: [{ kind: 'other', ref: 'x' }],
    }),
  },
  'brand.facts.approve': {
    buildInput: (f) => ({ brandId: f['brandId'], factId: f['factId'], expectedVersion: 0 }),
  },
  'brand.facts.revoke': {
    buildInput: (f) => ({ brandId: f['brandId'], factId: f['factId'], expectedVersion: 0, reason: 'x' }),
  },
  'brand.facts.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'brand.facts.update': {
    buildInput: (f) => ({ brandId: f['brandId'], factId: f['factId'], expectedVersion: 0, statement: 'x' }),
  },
  'brand.facts.withdraw': {
    buildInput: (f) => ({ brandId: f['brandId'], factId: f['factId'], expectedVersion: 0, reason: 'x' }),
  },
  'brand.facts.correct': {
    buildInput: (f) => ({ brandId: f['brandId'], factId: f['factId'], expectedVersion: 0, statement: 'x' }),
  },
  'brand.facts.merge': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      keep: { factId: f['factId'], expectedVersion: 0 },
      merge: [{ factId: f['factId2'], expectedVersion: 0 }],
    }),
  },
  'brand.facts.markReviewed': {
    buildInput: (f) => ({ brandId: f['brandId'], factId: f['factId'], expectedVersion: 0 }),
  },
  'brand.facts.resolveConflict': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      factId: f['factId'],
      expectedVersion: 0,
      conflictId: 'c1',
      outcome: 'kept_this',
    }),
  },
  'brand.objectives.set': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      name: 'x',
      primaryMetricKey: 'qualified_enquiries',
      guardrailMetricKeys: [],
      activeFrom: new Date().toISOString(),
    }),
  },
  'brand.objectives.list': {
    buildInput: (f) => ({ brandId: f['brandId'], activeOnly: false, page: { limit: 50 } }),
  },
  'brand.policy.createVersion': {
    buildInput: (f) => ({ brandId: f['brandId'], document: { schemaVersion: 1, reviewThresholds: {} } }),
  },
  'brand.policy.activate': {
    buildInput: (f) => ({ brandId: f['brandId'], policyVersionId: f['policyVersionId'], expectedVersion: 0 }),
  },
  'brand.policy.get': {
    buildInput: (f) => ({ brandId: f['brandId'], policyVersionId: f['policyVersionId'] }),
  },
  'brand.guidelines.import': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      files: [{ path: 'SKILL.md', content: '---\nname: cross-tenant-brand\ndescription: x\n---\n# Brand' }],
    }),
  },
  'brand.onboarding.start': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      versionId: f['brandVersionId'],
      servicePrincipalId: f['servicePrincipalId'],
    }),
  },
};
