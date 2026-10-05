import { z } from 'zod';

/**
 * Spec 6.1: prefixed ULIDs, varchar(32). Prefix + '_' + 26 Crockford base32 chars ≤ 32.
 * Prefixes make ID mix-ups visible in logs and tests.
 */
export const ID_PREFIXES = {
  tenant: 'ten',
  user: 'usr',
  membership: 'mem',
  brandGrant: 'bg',
  servicePrincipal: 'sp',
  apiClient: 'ac',
  session: 'ses',
  externalReviewerLink: 'erl',
  supportSession: 'ss',
  /** D-03: an external OIDC identity (provider + subject) linked to a user. */
  externalIdentity: 'xid',
  /** A pre-tenant authentication outcome (sign-in, refusal, sign-out). */
  authEvent: 'aue',
  /** A one-time password setup link issued by an owner or admin (only its hash is stored). */
  passwordSetupToken: 'pst',
  brand: 'brd',
  brandVersion: 'bv',
  designTokenSet: 'tok',
  approvedFact: 'fact',
  brandObjective: 'obj',
  policyVersion: 'pol',
  /** BSC-4: material a brand supplied (a website, a document, pasted text, one of its assets) and an assist job over it. */
  brandSource: 'bsrc',
  brandAssistJob: 'baj',
  /** BSC-4: one proposed change from an assist job, and the batch a person decided together (undo works per batch). */
  brandSuggestion: 'bsug',
  brandSuggestionBatch: 'bsb',
  asset: 'ast',
  assetVersion: 'av',
  assetDerivative: 'ad',
  usageRights: 'ur',
  assetGrant: 'ag',
  assetUsage: 'au',
  uploadIntent: 'ui',
  collection: 'col',
  creativeDocument: 'doc',
  creativeRevision: 'rev',
  renderedExport: 'exp',
  elementComment: 'cmt',
  template: 'tpl',
  templateVersion: 'tv',
  renderJob: 'rj',
  /** STU-1b: a durable studio generation or refinement job. */
  studioGenerationJob: 'sgj',
  /** STU-3: a durable studio video AI job (storyboard or recut). */
  studioVideoJob: 'svj',
  renderPreview: 'rpv',
  previewExport: 'pvx',
  campaign: 'cmp',
  brief: 'brf',
  planItem: 'pli',
  contentPackage: 'pkg',
  contentRevision: 'pr',
  channelVariant: 'cv',
  creativeAttributes: 'ca',
  reviewRequest: 'rr',
  reviewDecision: 'rd',
  releaseApproval: 'apr',
  publishingMandate: 'man',
  skill: 'skl',
  skillVersion: 'sv',
  skillBinding: 'sb',
  evaluationSuite: 'es',
  evaluationResult: 'er',
  agentRun: 'run',
  agentStep: 'step',
  toolInvocation: 'ti',
  providerJob: 'pj',
  modelRoutingPolicy: 'mrp',
  channelConnection: 'cc',
  credentialRef: 'cr',
  /** A sealed grant waiting for the person to choose which account it connects (spec 14.7, one row per option). */
  pendingChannelGrant: 'pcg',
  publication: 'pub',
  publicationAttempt: 'att',
  remoteEvidence: 're',
  /** An edit or deletion of a published post on its platform, requested through the product. */
  publicationRemoteChange: 'prc',
  /** A brand's non-social destination (analytics property, CMS, webhook; ledger R2-0). */
  destination: 'dst',
  /** A per-kind, per-data-type source-use policy row (D-17). */
  sourceUsePolicy: 'sup',
  /** A sealed source grant waiting for the person to choose which target it connects (R2-1, one row per flow). */
  pendingDestinationGrant: 'pdg',
  /** One day's row of a source report (GA4, Search Console) held for a destination (R2-1 part B). */
  destinationReportRow: 'drr',
  /** One bounded crawl of a website destination and one page it fetched (R2-4 technical SEO audit). */
  seoAuditRun: 'sar',
  seoAuditPage: 'sap',
  /** An SEO finding turned into tracked work, with its provenance (RA-11). */
  seoFindingWork: 'sfw',
  providerCapability: 'pc',
  metricDefinition: 'md',
  metricSnapshot: 'ms',
  trackedLink: 'tl',
  conversion: 'cnv',
  /** D-29: a brand's monthly client report and its per-brand report preferences. */
  report: 'rpt',
  reportPreference: 'rpp',
  insight: 'ins',
  recommendation: 'rec',
  learningRecord: 'lrn',
  playbookEntry: 'pb',
  customerVoiceCluster: 'cvc',
  listeningSource: 'ls',
  anomaly: 'an',
  experiment: 'xp',
  experimentVariant: 'xv',
  experimentAssignment: 'xa',
  experimentResult: 'xr',
  conversation: 'conv',
  message: 'msg',
  communityAssignment: 'asg',
  responseDraft: 'rdft',
  plan: 'pln',
  entitlement: 'ent',
  subscription: 'sub',
  budgetReservation: 'br',
  usageLedger: 'ul',
  spendLimit: 'sl',
  auditEvent: 'aud',
  outboxEvent: 'evt',
  deletionRequest: 'dr',
  retentionPolicy: 'rp',
  incident: 'inc',
  killSwitch: 'ks',
  featureFlag: 'ff',
  element: 'el',
  externalRef: 'xref',
  /** One MCP tools/call (spec 7.6): the dispatcher's run id for a surface call that has no durable agent run. */
  mcpCall: 'mcp',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';

export const prefixedId = (kind: IdKind) =>
  z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_${ULID_BODY}$`), `expected ${kind} id`);

/** Any prefixed id (used where the resource type is dynamic, e.g. audit events). */
export const AnyId = z.string().regex(new RegExp(`^[a-z]{2,5}_${ULID_BODY}$`), 'expected prefixed ULID');

export const ElementId = prefixedId('element');

export const isIdOfKind = (kind: IdKind, value: string): boolean => prefixedId(kind).safeParse(value).success;
