import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { initTRPC, TRPCError } from '@trpc/server';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import superjson from 'superjson';
import { z } from 'zod';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import {
  CommentAdd,
  CommentList,
  CommentResolve,
  DocumentCreate,
  DocumentGet,
  DocumentList,
  OperationsApply,
  OperationsPropose,
  RenderGet,
  RenderRequest,
  RevisionGet,
  RevisionList,
  TemplateGet,
  TemplateList,
  type Operation,
  type OperationBatch,
} from '@oremedia/contracts/creative';
import {
  BudgetRead,
  BudgetSetLimit,
  RoutingPolicySet,
  RunApproveProposal,
  RunCancel,
  RunGet,
  RunList,
  RunPendingProposals,
  RunStart,
  RunSteps,
  type ModelRoutingPolicy,
} from '@oremedia/contracts/agents';
import {
  AssetApprove,
  AssetGet,
  AssetList,
  AssetRetire,
  AssetSearch,
  BrandFontsList,
  UploadIntentGet,
  UsageRightsInput,
  GOOGLE_FONTS_LICENCE_NOTE,
  GoogleFontImport,
  MediaSignedUrlRequest,
  UploadIntentComplete,
  UploadIntentCreate,
  type BrandFontFace,
} from '@oremedia/contracts/assets';
import {
  BrandClassify,
  BrandVersionGet,
  BrandVersionImpact,
  BrandVersionList,
  BrandVersionUpdate,
  FactList,
  ObjectiveList,
  OnboardingStart,
  PolicyGet,
  PolicyVersionActivate,
  PolicyVersionCreate,
  PolicyDocumentV1,
} from '@oremedia/contracts/brand';
import {
  ConflictError,
  isOremediaError,
  NotFoundError,
  PolicyDeniedError,
  StaleRevisionError,
  toErrorEnvelope,
  ValidationFailedError,
  type ErrorEnvelope,
} from '@oremedia/contracts/errors';
import { applyBatch, changedElementIds, guardProtected, validateAgainstBrand } from '@oremedia/editor';
import { fixtureDocument, fixtureSnapshot, ids } from '@oremedia/editor/fixtures';
import { AuditQuery } from '@oremedia/contracts/operations';
import { PageRequest } from '@oremedia/contracts/pagination';
import {
  SkillBindingSet,
  SkillExport,
  SkillGet,
  SkillImport,
  SkillList,
  SkillTaskKinds,
  SkillVersionEvaluate,
  SkillVersionPublish,
  TaskKind,
} from '@oremedia/contracts/skills';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import {
  passwordPolicyIssue,
  PasswordSetup,
  PasswordSignIn,
  ServicePrincipalList,
  type PasswordAuthResponse,
} from '@oremedia/contracts/access';
import { Phase5Backend, phase5Routers, type ReviewerLink } from './mock-phase5';
import { deniedError, Phase6Backend, phase6Routers } from './mock-phase6';
import { CommunityBackend, communityRouters } from './mock-community';

/**
 * A UI-only transport for the studio smoke test: the same procedure paths, input DTOs, error envelope and header
 * contract as apps/api (bearer session, X-Oremedia-Tenant, Idempotency-Key with replay, STALE_REVISION on a stale
 * base), backed by an in-memory operation engine built from the real reducer and validator. It is a test double,
 * never a second implementation of the API.
 */
export const E2E = {
  token: 'ses_e2e_token',
  tenantId: 'ten_e2e',
  brandId: 'brd_e2e',
  brandVersionId: 'bv_e2e',
  companyName: 'E2E company',
  brandName: 'E2E brand',
};

/** A company as the mock serves it: one tenant with its brands; every row it holds carries these ids. */
export interface CompanyIdentity {
  tenantId: string;
  brandId: string;
  companyName: string;
  brandName: string;
}

/** The second company of the two-company suite (journey.e2e.test.ts): its own tenant, brand and stores. */
export const E2E_B: CompanyIdentity = {
  tenantId: 'ten_e2e_b',
  brandId: 'brd_e2e_b',
  companyName: 'Beta company',
  brandName: 'Beta brand',
};

/** A person's membership in one company (spec 5.1): role, and the brands granted (null = all brands). */
export interface MockMembership {
  role: MembershipRole;
  brandIds: string[] | null;
}
/** A signed-in person other than the default E2E session: bearer token → user and memberships by tenant. */
export interface MockSession {
  userId: string;
  memberships: Record<string, MockMembership>;
}
/** The resolved membership of the caller in the company a tenant-scoped procedure runs in. */
export interface MockMember extends MockMembership {
  userId: string;
}

interface BrandRow {
  id: string;
  name: string;
  publishedVersionId: string | null;
  classification?: 'client' | 'internal';
  version?: number;
}

/** Agent runs as agents.runs.get returns them (the steps are served by agents.runs.steps). */
interface AgentRunRow {
  id: string;
  brandId: string;
  state: 'planned' | 'running' | 'waiting_for_review' | 'completed' | 'failed' | 'cancelled';
  taskKind: string;
  autonomyMode: 'assist' | 'create' | 'prepare_release' | 'managed_autopublish';
  servicePrincipalId: string;
  initiatorKind: 'user' | 'system' | 'recommendation';
  initiatorId: string;
  brief: Record<string, unknown>;
  contextSnapshotHash: string | null;
  skillVersionIds: string[];
  modelConfig: Record<string, string>;
  budgetReservationId: string | null;
  costMicros: number;
  deadlineAt: string;
  workflowId: string;
  correlationId: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  steps: Array<{
    id: string;
    index: number;
    kind: 'plan' | 'model_call' | 'tool_call' | 'validation';
    summary: string;
    tokensIn: number;
    tokensOut: number;
    costMicros: number;
    durationMs: number;
    createdAt: string;
    invocations: never[];
  }>;
}

interface Rev {
  id: string;
  documentId: string;
  parentRevisionId: string | null;
  number: number;
  brandVersionId: string;
  agentRunId: string | null;
  authorKind: 'user' | 'agent';
  authorId: string;
  changeSummary: string;
  operations: OperationBatch;
  snapshot: CreativeDocumentV1;
  contentHash: string;
  createdAt: string;
}
interface Doc {
  id: string;
  brandId: string;
  contentPackageId: null;
  title: string;
  currentRevisionId: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  version: number;
  revisions: Rev[];
}
interface Comment {
  id: string;
  documentId: string;
  revisionId: string;
  elementId: string;
  body: string;
  authorKind: 'user';
  authorId: string;
  state: 'open' | 'resolved' | 'outdated';
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface RenderJob {
  id: string;
  revisionId: string;
  formatKeys: string[];
  state: 'pending' | 'rendering' | 'ready' | 'failed';
  attempts: number;
  error: string | null;
  requestedByKind: 'user';
  requestedById: string;
  exportIds: string[];
  exports: never[];
  createdAt: string;
  updatedAt: string;
  version: number;
  polls: number;
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
/** Spec 7.4 cursor paging over an in-memory list: the cursor is the offset of the next row. */
const paged = <T>(rows: T[], page: { cursor?: string | undefined; limit: number }) => {
  const from = page.cursor ? Number(page.cursor) : 0;
  const items = rows.slice(from, from + page.limit);
  return { items, nextCursor: from + page.limit < rows.length ? String(from + page.limit) : null };
};

const fontFace = (
  assetId: string,
  family: string,
  weight: number,
  source: BrandFontFace['source'],
  subsets: Array<[string | null, string | null]> = [[null, null]],
  weightRange: { min: number; max: number } | null = null,
): BrandFontFace => ({
  key:
    source === 'google_fonts' ? `google_fonts:${family.toLowerCase()}:${weight}:normal` : `asset:${assetId}`,
  assetId,
  assetVersionId: `av_font_${assetId}`,
  name: `${family}.woff2`,
  state: 'approved',
  family,
  subfamily: 'Regular',
  weight,
  weightRange,
  style: 'normal',
  format: source === 'google_fonts' ? 'woff2' : 'ttf',
  source,
  licence: source === 'google_fonts' ? GOOGLE_FONTS_LICENCE_NOTE : 'SIL Open Font License 1.1',
  files: subsets.map(([subset, unicodeRange], i) => ({
    assetId: i === 0 ? assetId : `${assetId}_${subset}`,
    assetVersionId: i === 0 ? `av_font_${assetId}` : `av_font_${assetId}_${subset}`,
    mime: source === 'google_fonts' ? 'font/woff2' : 'font/ttf',
    bytes: 94016,
    subset,
    unicodeRange,
  })),
});

interface MockAsset {
  id: string;
  kind: 'photo' | 'logo' | 'illustration' | 'font';
  name: string;
  state: 'pending_review' | 'approved' | 'rejected' | 'retired';
  rights: { owner: string; licenceRef: string | null; expiresAt: string | null } | null;
  version: number;
  createdAt: string;
}
const mockAsset = (
  id: string,
  kind: MockAsset['kind'],
  name: string,
  state: MockAsset['state'],
  rights: { owner: string; expiresAt: string | null } | null,
): MockAsset => ({
  id,
  kind,
  name,
  state,
  rights: rights ? { licenceRef: null, ...rights } : null,
  version: 1,
  createdAt: now(),
});
/** Mirrors packages/modules/assets assetIssues. */
const assetIssues = (a: MockAsset): string[] => {
  const out: string[] = [];
  if (a.state !== 'approved') out.push(a.state);
  if (!a.rights) out.push('rights_unknown');
  else if (a.rights.expiresAt && new Date(a.rights.expiresAt).getTime() < Date.now())
    out.push('rights_expired');
  else if (a.rights.expiresAt && new Date(a.rights.expiresAt).getTime() < Date.now() + 30 * 86_400_000)
    out.push('rights_expiring');
  return out;
};
const assetVersionOf = (a: MockAsset) => ({
  id: 'av_photo',
  assetId: a.id,
  number: 1,
  mime: 'image/png',
  bytes: 68,
  width: 2,
  height: 2,
  altText: a.kind === 'photo' ? 'Sample photo' : null,
  contentHash: hash(a.id),
  provenance: { kind: 'upload' as const },
  createdAt: now(),
});

interface MockSkillVersion {
  id: string;
  skillId: string;
  number: number;
  state: 'draft' | 'sandbox_evaluation' | 'in_review' | 'published' | 'retired';
  rolloutPercent: number;
  packageHash: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
const mockSkillVersion = (
  id: string,
  skillId: string,
  number: number,
  state: MockSkillVersion['state'],
): MockSkillVersion => ({
  id,
  skillId,
  number,
  state,
  rolloutPercent: state === 'published' ? 100 : 0,
  packageHash: hash(id),
  publishedAt: state === 'published' ? '2026-09-01T09:00:00.000Z' : null,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  version: 0,
});

export class MockBackend {
  /**
   * The brand's font faces (assets.fonts.list): the fixture brand's type roles name `ast_font`. Uploads and Google
   * Fonts imports are catalogued at once here (the real ingest runs in a worker).
   */
  readonly fonts: BrandFontFace[] = [fontFace('ast_font', 'Karla', 400, 'upload')];
  /**
   * The object store's origin in the signed URLs this mock issues (upload PUTs and font files): '' is the web server's
   * own stand-in (static-server.ts); a test sets a fake store's origin to exercise the production CSP (connect-src and
   * font-src) and the store's CORS.
   */
  objectStoreOrigin = '';
  /** Upload intents issued through assets.uploads.createIntent, by id, with how often their status was read. */
  readonly fontIntents = new Map<
    string,
    { originalFilename: string; declaredMime: string; kind: string; polls: number; assetId: string | null }
  >();
  /**
   * The brand's assets as assets.list and assets.get report them (spec 21.2 states): the sample photo (usable), the
   * fixture logo (no rights yet), one pending review and one retired. Approve, retire and rights.set change them.
   */
  readonly assets: MockAsset[] = [
    mockAsset('ast_e2e', 'photo', 'Sample photo', 'approved', { owner: 'Studio', expiresAt: null }),
    mockAsset('ast_logo', 'logo', 'E2E wordmark.svg', 'approved', null),
    mockAsset('ast_pending', 'photo', 'Autumn hero.png', 'pending_review', null),
    mockAsset('ast_retired', 'illustration', 'Old campaign art.png', 'retired', {
      owner: 'Studio',
      expiresAt: null,
    }),
  ];
  asset(id: string): MockAsset {
    const a = this.assets.find((x) => x.id === id);
    if (!a) throw new NotFoundError('Asset', id);
    return a;
  }
  /** Google Fonts imports received (tests read what the editor asked for). */
  readonly googleImports: unknown[] = [];
  /** The last brand draft document saved through brand.versions.update (tests read what the editor sent). */
  brandDraftDocument: { voice?: unknown } | null = null;
  lastBrandDraftVoice(): unknown {
    return this.brandDraftDocument?.voice ?? null;
  }
  lastBrandDraftTypeRoles(): unknown {
    return (
      (this.brandDraftDocument as { tokens?: { typeRoles?: unknown } } | null)?.tokens?.typeRoles ?? null
    );
  }
  readonly tenantId: string;
  readonly brandId: string;
  readonly companyName: string;
  readonly brandName: string;
  /** Phase 5: calendar, publications, channels, review requests and reviewer links (mock-phase5.ts). */
  readonly phase5: Phase5Backend;
  /** Phase 6: intelligence, experiments, campaigns, briefs, packages and channel connections (mock-phase6.ts). */
  readonly phase6: Phase6Backend;
  /** Comment inbox: conversations, threaded comments and replies (mock-community.ts). */
  readonly community: CommunityBackend;
  /** The company's brands (brand.list / brand.get); the first is the brand every seeded row belongs to. */
  readonly brands: BrandRow[];
  /** Agent runs of this company (agents.runs.*; the brand's list is agents.runs.list, newest first). */
  readonly runs = new Map<string, AgentRunRow>();
  /**
   * UX-07: the proposal a studio-started layout run parks on (as tool_invocations.proposal_payload); produced on
   * the second read of the run, decided through agents.runs.approveProposal.
   */
  readonly runProposals = new Map<
    string,
    {
      stepId: string;
      documentId: string;
      baseRevisionId: string;
      operations: Operation[];
      summary: string;
      contentHash: string;
      findings: unknown[];
      createdAt: string;
      reads: number;
      /** A decision a person recorded; the run applies it on its next read, as the workflow does. */
      decision: { decision: 'accept' | 'reject' | 'modify'; stepId: string } | null;
    }
  >();
  /** Skills visible to the company (skills.list): built in, company-wide and this brand's own. */
  readonly skills = [
    ['sk_onboarding', 'platform', null, 'brand-onboarding', 'Brand onboarding', 'skv_onboarding_1'],
    ['sk_copy', 'tenant', null, 'brand-copywriting', 'Brand copywriting', 'skv_copy_3'],
    ['sk_voice', 'brand', 'brand', 'acme-voice', 'Acme voice (imported)', null],
  ].map(([id, scope, brand, key, title, activeVersionId]) => ({
    id: id as string,
    scope: scope as 'platform' | 'tenant' | 'brand',
    brandId: brand ? E2E.brandId : null,
    key: key as string,
    title: title as string,
    state: 'active' as const,
    activeVersionId,
    ownerUserId: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    version: 1,
  }));
  /**
   * Skill versions by skill (skills.get): the imported brand skill has one draft; evaluate moves it to the sandbox
   * and, as the worker would, straight on to in_review with a passed result; publish activates it. Bindings by
   * `${brandId}:${skillId}` (skills.bindings.set).
   */
  readonly skillVersions = new Map<string, MockSkillVersion[]>([
    ['sk_onboarding', [mockSkillVersion('skv_onboarding_1', 'sk_onboarding', 1, 'published')]],
    ['sk_copy', [mockSkillVersion('skv_copy_3', 'sk_copy', 3, 'published')]],
    ['sk_voice', [mockSkillVersion('skv_voice_1', 'sk_voice', 1, 'draft')]],
  ]);
  readonly skillEvaluations: Array<{
    id: string;
    suiteId: string;
    skillVersionId: string;
    modelVersion: string;
    runs: number;
    scores: Record<string, number>;
    variance: Record<string, number>;
    deterministicChecks: Record<string, boolean>;
    passed: boolean;
    createdAt: string;
  }> = [];
  readonly skillBindings = new Map<string, { id: string; skillVersionId: string; skillId: string }>();
  /** Spend limits and the ledger (agents.budgets): the company's month row is brandId ''. */
  readonly spendLimits = new Map<string, number>([['', 100_000_000]]);
  /** UX-20: the brand's policy versions (brand.policy.*); none until the settings screen writes one. */
  readonly policyVersions: Array<{
    id: string;
    brandId: string;
    number: number;
    state: 'draft' | 'active' | 'retired';
    document: PolicyDocumentV1;
    createdByUserId: string;
    createdAt: string;
    updatedAt: string;
    version: number;
  }> = [];
  /** Kill switches by `${scope}:${brandId ?? ''}` (operations.killSwitch); '' is the company-wide row. */
  readonly killSwitches = new Map<string, { engaged: boolean; reason: string | null }>();
  /** The company's stored model-routing policy (agents.routingPolicy); null = none stored, the platform default. */
  routingPolicy: { policy: ModelRoutingPolicy; version: number } | null = {
    policy: {
      schemaVersion: 1,
      defaultModel: 'anthropic/claude-sonnet',
      permittedVendors: ['anthropic', 'openrouter'],
      permittedRegions: ['eu'],
      deniedModels: [],
    },
    version: 2,
  };
  /** The route this deployment starts runs with (agents.routingPolicy.get inUse). */
  readonly modelInUse = {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet',
    region: 'eu' as string | null,
  };
  /** The signed-in person's role in the company (access.listCompanies); the server still decides every call. */
  role: MembershipRole = 'owner';
  /**
   * Other people who can sign in (bearer token → session), shared by every company of the group so one person can
   * belong to several. The default `E2E.token` session stays the single-company owner the other suites use.
   */
  sessions = new Map<string, MockSession>();
  /** The other companies served next to this one; requests are routed by their X-Oremedia-Tenant header. */
  readonly companies: MockBackend[] = [];
  /** Procedure paths the policy engine refuses for this person (FORBIDDEN envelope), e.g. `publishing.channels.list`. */
  readonly denied = new Set<string>();
  /** Procedure paths whose next N calls fail with an INTERNAL envelope, to exercise error states and retries. */
  readonly failNext = new Map<string, number>();
  /** Procedure paths answered after a delay (ms), to observe loading states. */
  readonly delays = new Map<string, number>();
  readonly docs = new Map<string, Doc>();
  readonly comments: Comment[] = [];
  readonly jobs = new Map<string, RenderJob>();
  readonly replays = new Map<string, unknown>();
  /** Test hooks: fail the next applyBatch with an INTERNAL envelope; fail the next render job. */
  failNextApply = false;
  failNextRender = false;
  readonly requests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  /**
   * Password sign-in as apps/api/src/auth/router.ts answers it, in memory: address → password and the session token
   * a sign-in opens (set as the `oremedia_session` cookie, which the tRPC mock accepts like a bearer).
   */
  readonly passwords = new Map<string, { password: string; sessionToken: string }>();
  /** Setup links issued through access.members.issuePasswordSetup: token → the member it is for. */
  readonly setupLinks = new Map<string, { email: string; sessionToken: string; used: boolean }>();
  /** Whether the default E2E person has a linked Google identity (access.account.signInMethods). */
  hasGoogle = true;
  /** Whether the E2E session was signed in within the last 15 minutes (a first password requires it). */
  recentSignIn = true;
  /** Every body the password routes received (tests assert what the pages sent). */
  readonly authRequests: Array<{ path: string; origin: string | undefined; body: unknown }> = [];

  /** `seed: false` starts the company empty apart from its brand (a second company seeds its own few rows). */
  constructor(company: CompanyIdentity = E2E, seed = true) {
    this.tenantId = company.tenantId;
    this.brandId = company.brandId;
    this.companyName = company.companyName;
    this.brandName = company.brandName;
    this.phase5 = new Phase5Backend(company.tenantId, company.brandId, seed);
    this.phase6 = new Phase6Backend(this.phase5, seed);
    this.phase6.documentOf = (documentId) => {
      const doc = this.docs.get(documentId);
      return doc ? { title: doc.title, currentRevisionId: doc.currentRevisionId } : null;
    };
    this.community = new CommunityBackend(company.brandId, () => this.role, seed);
    this.brands = [{ id: company.brandId, name: company.brandName, publishedVersionId: E2E.brandVersionId }];
    if (seed) this.addRun('run_e2e_copy', 'copywriting', 'completed', 9_990);
  }

  /** Serves `other` next to this company for the same people (one sign-in, two tenants, spec 5.1). */
  addCompany(other: MockBackend): void {
    other.sessions = this.sessions;
    this.companies.push(other);
  }

  /** A further brand in this company (a creator's grant can leave it out). */
  addBrand(id: string, name: string): void {
    this.brands.push({ id, name, publishedVersionId: E2E.brandVersionId });
  }

  /** A finished agent run of this company's brand, as the audit log and agents.runs.get report it. */
  addRun(id: string, taskKind: string, state: AgentRunRow['state'], costMicros: number): AgentRunRow {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const run: AgentRunRow = {
      id,
      brandId: this.brandId,
      state,
      taskKind,
      autonomyMode: 'create',
      servicePrincipalId: 'sp_e2e_agent',
      initiatorKind: 'user',
      initiatorId: 'usr_e2e',
      brief: { goal: taskKind },
      contextSnapshotHash: null,
      skillVersionIds: [],
      modelConfig: { provider: 'anthropic', model: 'model-e2e' },
      budgetReservationId: null,
      costMicros,
      deadlineAt: at(-30),
      workflowId: `run:${id}`,
      correlationId: `corr_${id}`,
      finishedAt: ['planned', 'running', 'waiting_for_review'].includes(state) ? null : at(1),
      createdAt: at(10),
      updatedAt: at(1),
      version: 1,
      steps: [
        {
          id: `st_${id}`,
          index: 0,
          kind: 'model_call',
          summary: 'final (end_turn): done',
          tokensIn: 900,
          tokensOut: 200,
          costMicros,
          durationMs: 1_200,
          createdAt: at(5),
          invocations: [],
        },
      ],
    };
    this.runs.set(id, run);
    return run;
  }

  /** The caller's membership in this company, or null when the bearer is not a member of it. */
  memberFor(bearer: string | undefined): MockMember | null {
    if (bearer === `Bearer ${E2E.token}`)
      return this.tenantId === E2E.tenantId ? { userId: 'usr_e2e', role: this.role, brandIds: null } : null;
    const session = bearer?.startsWith('Bearer ') ? this.sessions.get(bearer.slice(7)) : undefined;
    const membership = session?.memberships[this.tenantId];
    return session && membership ? { userId: session.userId, ...membership } : null;
  }

  createDocument(title: string, snapshot = fixtureDocument()): Doc {
    const id = rid('doc');
    const revision = this.revision(
      id,
      null,
      1,
      {
        baseRevisionId: '',
        operations: snapshot.pages.map((page, index) => ({ op: 'addPage', page, index })),
        summary: 'Initial document',
        origin: 'user',
      },
      snapshot,
    );
    const doc: Doc = {
      id,
      brandId: this.brandId,
      contentPackageId: null,
      title,
      currentRevisionId: revision.id,
      schemaVersion: 1,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
      revisions: [revision],
    };
    this.docs.set(id, doc);
    return doc;
  }

  private revision(
    documentId: string,
    parent: Rev | null,
    number: number,
    batch: OperationBatch,
    snapshot: CreativeDocumentV1,
  ): Rev {
    return {
      id: rid('rev'),
      documentId,
      parentRevisionId: parent?.id ?? null,
      number,
      brandVersionId: E2E.brandVersionId,
      agentRunId: batch.agentRunId ?? null,
      authorKind: batch.origin,
      authorId: 'usr_e2e',
      changeSummary: batch.summary,
      operations: batch,
      snapshot,
      contentHash: hash(snapshot),
      createdAt: now(),
    };
  }

  doc(documentId: string): Doc {
    const doc = this.docs.get(documentId);
    if (!doc) throw new NotFoundError('CreativeDocument', documentId);
    return doc;
  }

  head(documentId: string): Rev {
    const doc = this.doc(documentId);
    return doc.revisions.find((r) => r.id === doc.currentRevisionId) as Rev;
  }

  /** Spec 11.4 applyOperations, in memory: stale check, guards, reduce, validate, new revision, comment outdating. */
  apply(input: z.infer<typeof OperationsApply>) {
    const { documentId, ...batch } = input;
    const doc = this.doc(documentId);
    if (doc.currentRevisionId !== batch.baseRevisionId) throw new StaleRevisionError(doc.currentRevisionId);
    const base = this.head(documentId);
    const evaluated = this.evaluate(base, batch);
    const revision = this.revision(documentId, base, base.number + 1, batch, evaluated.snapshot);
    doc.revisions.push(revision);
    doc.currentRevisionId = revision.id;
    doc.version += 1;
    doc.updatedAt = now();
    const changed = new Set(changedElementIds(batch));
    let outdated = 0;
    for (const c of this.comments)
      if (c.documentId === documentId && c.state === 'open' && changed.has(c.elementId)) {
        c.state = 'outdated';
        c.version += 1;
        outdated += 1;
      }
    return { revision, findings: evaluated.findings, outdatedComments: outdated, version: doc.version };
  }

  evaluate(base: Rev, batch: Omit<OperationBatch, 'baseRevisionId'> & { baseRevisionId?: string }) {
    let next = base.snapshot;
    batch.operations.forEach((op, index) => {
      guardProtected(next, op, batch.origin);
      try {
        next = applyBatch(next, { operations: [op] });
      } catch (err) {
        throw new ValidationFailedError([
          { path: `operations.${index}`, issue: err instanceof Error ? err.message : String(err) },
        ]);
      }
    });
    const findings = validateAgainstBrand(next, fixtureSnapshot());
    return {
      snapshot: next,
      findings,
      contentHash: hash(next),
      changedElementIds: changedElementIds(batch),
      blocking: findings.some((f) => f.severity === 'blocking'),
    };
  }

  /** Test backdoor: another actor commits on the head (what makes the UI's next save stale). */
  applyOutOfBand(documentId: string, operations: Operation[], summary = 'Out-of-band edit'): Rev {
    return this.apply({
      documentId,
      baseRevisionId: this.head(documentId).id,
      operations,
      summary,
      origin: 'user',
    }).revision;
  }
}

/**
 * Company B of the two-company suite: its own tenant, brand and stores, seeded with a few rows of its own (a channel,
 * a campaign, an agent run) and none of company A's, so any row of A that appears while B is selected is a leak.
 */
export function createSecondCompany(): MockBackend {
  const b = new MockBackend(E2E_B, false);
  b.phase5.addChannel(
    'cc_beta_linkedin',
    'linkedin',
    'Beta LinkedIn',
    'active',
    new Date(Date.now() + 30 * 86_400_000).toISOString(),
  );
  b.phase6.addCampaign('cmp_beta_harvest', 'Beta harvest', -2, 20);
  b.addRun('run_beta_layout', 'layout', 'completed', 4_200);
  return b;
}

interface Ctx {
  headers: IncomingHttpHeaders;
  correlationId: string;
  /** Set when the bearer was an external reviewer link token (`rl_…`), spec 5.6. */
  reviewer?: ReviewerLink | null;
  /** Set for a member session once the company is resolved (tenant-scoped procedures). */
  member?: MockMember | null;
}

export const t = initTRPC.context<Ctx>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error, ctx }) => {
    const correlationId = ctx?.correlationId ?? 'unknown';
    let envelope: ErrorEnvelope;
    if (isOremediaError(error.cause)) envelope = toErrorEnvelope(error.cause, correlationId);
    else if (error.code === 'UNAUTHORIZED')
      envelope = { code: 'UNAUTHENTICATED', message: 'Authentication required', correlationId };
    else if (error.code === 'FORBIDDEN')
      envelope = {
        code: 'FORBIDDEN',
        message: error.message || 'You are not allowed to perform this action',
        correlationId,
      };
    else if (error.code === 'BAD_REQUEST')
      envelope = {
        code: 'VALIDATION_FAILED',
        message:
          error.message === 'IDEMPOTENCY_KEY_REQUIRED' ? 'Idempotency-Key header is required' : 'Bad request',
        correlationId,
      };
    else envelope = { code: 'INTERNAL', message: 'Something went wrong', correlationId };
    return { ...shape, message: envelope.message, data: { ...shape.data, envelope } };
  },
});

const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);

/** The E2E person's address (access.session) and the members' (access.members.list). */
export const E2E_EMAIL = 'e2e.person@example.test';
const MEMBER_ACCOUNTS: Record<string, { email: string; userId: string; role: MembershipRole }> = {
  mem_owner: { email: E2E_EMAIL, userId: 'usr_e2e', role: 'owner' },
  mem_creator: { email: 'kofi@example.test', userId: 'usr_creator', role: 'creator' },
  mem_invited: { email: 'lina@example.test', userId: 'usr_invited', role: 'reviewer' },
};

/**
 * The caller's credential as the API reads it (apps/api/src/context.ts): an Authorization bearer, else the session
 * cookie a password sign-in set, presented the same way.
 */
function credentialOf(headers: IncomingHttpHeaders): string | undefined {
  const bearer = first(headers['authorization']);
  if (bearer) return bearer;
  const cookie = /(?:^|;\s*)oremedia_session=([^;]+)/.exec(first(headers['cookie']) ?? '');
  return cookie ? `Bearer ${decodeURIComponent(cookie[1] as string)}` : undefined;
}

const domainErrors = t.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (isOremediaError(err))
      throw new TRPCError({
        code:
          err.code === 'STALE_REVISION' || err.code === 'CONFLICT'
            ? 'CONFLICT'
            : err.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : err.code === 'FORBIDDEN'
                ? 'FORBIDDEN'
                : err.code === 'VALIDATION_FAILED'
                  ? 'BAD_REQUEST'
                  : 'INTERNAL_SERVER_ERROR',
        message: err.message,
        cause: err,
      });
    throw err;
  }
});
/**
 * The shared middlewares as apps/api applies them: bearer authentication (a session token, or an `rl_…` reviewer
 * link token that resolves to a stored link), tenant scoping from the X-Oremedia-Tenant header against the caller's
 * memberships (an external reviewer is bound to its link's tenant and sends none), the brand grant of a member
 * restricted to some brands (any other brand id is NOT_FOUND, spec 5.4: never reveal it exists), and
 * Idempotency-Key replay on every mutation.
 */
export function createBuilders(backend: MockBackend) {
  const authed = t.middleware(({ ctx, next }) => {
    const bearer = credentialOf(ctx.headers);
    let reviewer: ReviewerLink | null = null;
    const session = bearer?.startsWith('Bearer ') && backend.sessions.has(bearer.slice(7));
    if (bearer !== `Bearer ${E2E.token}` && !session) {
      reviewer = bearer?.startsWith('Bearer rl_') ? backend.phase5.linkByToken(bearer.slice(7)) : null;
      if (!reviewer) throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    return next({ ctx: { ...ctx, reviewer } });
  });
  const tenantScoped = t.middleware(({ ctx, next }) => {
    if (ctx.reviewer) return next();
    const tenant = first(ctx.headers['x-oremedia-tenant']);
    if (!tenant) throw new TRPCError({ code: 'FORBIDDEN', message: 'Select a company first' });
    const member = tenant === backend.tenantId ? backend.memberFor(credentialOf(ctx.headers)) : null;
    if (!member) throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not a member of this company' });
    return next({ ctx: { ...ctx, member } });
  });
  const policy = t.middleware(async ({ ctx, path, getRawInput, next }) => {
    const delay = backend.delays.get(path);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (backend.denied.has(path)) throw deniedError(path);
    const raw = (await getRawInput()) as { brandId?: unknown } | undefined;
    const grants = ctx.member?.brandIds ?? null;
    if (grants && typeof raw?.brandId === 'string' && !grants.includes(raw.brandId))
      throw new NotFoundError('Brand', raw.brandId);
    const failures = backend.failNext.get(path) ?? 0;
    if (failures > 0) {
      if (failures === 1) backend.failNext.delete(path);
      else backend.failNext.set(path, failures - 1);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'simulated outage' });
    }
    return next();
  });
  const idempotent = t.middleware(async ({ ctx, path, next }) => {
    const key = first(ctx.headers['idempotency-key']);
    if (!key) throw new TRPCError({ code: 'BAD_REQUEST', message: 'IDEMPOTENCY_KEY_REQUIRED' });
    const replayKey = `${path}:${key}`;
    if (backend.replays.has(replayKey))
      return {
        ok: true as const,
        data: backend.replays.get(replayKey),
        ctx,
        marker: 'replay' as const,
      } as never;
    const result = await next();
    if (result.ok) backend.replays.set(replayKey, result.data);
    return result;
  });
  const query = t.procedure.use(domainErrors).use(authed).use(tenantScoped).use(policy);
  const mutation = query.use(idempotent);
  const authedOnly = t.procedure.use(domainErrors).use(authed);
  return { query, mutation, authedOnly };
}
export type MockBuilders = ReturnType<typeof createBuilders>;

export function createMockRouter(backend: MockBackend) {
  const { query, mutation, authedOnly } = createBuilders(backend);
  const brandDoc = fixtureSnapshot().document;
  const brandVersion = {
    id: E2E.brandVersionId,
    brandId: backend.brandId,
    number: 1,
    state: 'published' as const,
    document: brandDoc,
    contentHash: hash(brandDoc),
    publishedAt: now(),
    publishedByUserId: 'usr_e2e',
    createdAt: now(),
    updatedAt: now(),
    version: 1,
  };
  const { document: _d, ...brandVersionSummary } = brandVersion;
  /** A draft with a palette and selected reference imagery, so the brand kit editor opens with content. */
  const brandDraftDoc = {
    ...brandDoc,
    patterns: [
      {
        key: 'reference-imagery',
        description: 'Natural light on raw materials.',
        exampleAssetIds: ['ast_e2e'],
        templateVersionIds: [],
      },
    ],
    guidelines: {
      source: { name: 'e2e-brand', description: 'The E2E brand system.', packageHash: hash('e2e-brand') },
      documents: [
        { path: 'SKILL.md', content: '# E2E brand\nDirect and precise.' },
        { path: 'references/tone.md', content: '# Tone\nNever loud.' },
      ],
    },
  };
  let brandDraft = {
    ...brandVersion,
    id: 'bv_e2e_draft',
    number: 2,
    state: 'draft' as const,
    document: brandDraftDoc,
    contentHash: hash(brandDraftDoc),
    publishedAt: null,
    publishedByUserId: null,
  };
  const summaryOf = ({ document: _doc, ...rest }: typeof brandDraft) => rest;
  const pngDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQIW2NkYPj/n4GBgYGJgYEBAAgQAgHfTMWQAAAAAElFTkSuQmCC';

  const p6 = phase6Routers(backend.phase6, { router: t.router, query, mutation });
  const p5 = phase5Routers(
    backend.phase5,
    { router: t.router, query, mutation },
    { variants: p6.variants, channels: p6.channels },
  );

  return t.router({
    content: t.mergeRouters(p5.content, p6.content),
    publishing: p5.publishing,
    review: p5.review,
    intelligence: p6.intelligence,
    experiments: p6.experiments,
    measurement: p6.measurement,
    community: communityRouters(backend.community, { router: t.router, query, mutation }),
    access: t.router({
      /** UX-08: the agent principals a run on the brand can start under; gated as the API gates it (agent.start_run). */
      servicePrincipals: t.router({
        list: query.input(ServicePrincipalList).query(({ ctx, input }) => {
          // agent.start_run: managers, creator and analyst (role-grants); a reviewer or publisher is refused.
          if (ctx.member?.role === 'reviewer' || ctx.member?.role === 'publisher')
            throw new PolicyDeniedError(
              'role_missing',
              'Your role does not include agent.start_run for this brand',
            );
          if (input.brandId !== backend.brandId) throw new NotFoundError('Brand', input.brandId);
          return {
            items: [
              {
                id: 'sp_e2e_agent',
                name: 'E2E agent',
                kind: 'agent' as const,
                maxAutonomy: 'prepare_release' as const,
                actions: ['brand.read', 'content.plan', 'creative.edit'],
                createdAt: '2026-09-01T09:00:00.000Z',
              },
            ],
            nextCursor: null,
          };
        }),
      }),
      members: t.router({
        list: query.query(({ ctx }) => {
          if (ctx.member?.role !== 'owner' && ctx.member?.role !== 'admin')
            throw new PolicyDeniedError('membership.manage');
          return {
            items: [
              ['mem_owner', 'usr_e2e', 'E2E person', 'e2e.person@example.test', 'owner', 'active', true, []],
              [
                'mem_creator',
                'usr_creator',
                'Kofi Asare',
                'kofi@example.test',
                'creator',
                'active',
                false,
                [E2E.brandId],
              ],
              ['mem_invited', 'usr_invited', null, 'lina@example.test', 'reviewer', 'invited', false, []],
            ].map(([membershipId, userId, name, email, role, status, allBrands, brandIds]) => ({
              membershipId: membershipId as string,
              userId: userId as string,
              name: name as string | null,
              email: email as string,
              role: role as MembershipRole,
              status: status as 'active' | 'invited' | 'disabled',
              allBrands: allBrands as boolean,
              brandIds: brandIds as string[],
              createdAt: '2026-09-01T09:00:00.000Z',
              version: 0,
            })),
          };
        }),
        invite: mutation
          .input(
            z.object({ email: z.string().email(), role: z.string(), allBrands: z.boolean().default(false) }),
          )
          .mutation(({ ctx }) => {
            if (ctx.member?.role !== 'owner' && ctx.member?.role !== 'admin')
              throw new PolicyDeniedError('membership.manage');
            return { membershipId: rid('mem') };
          }),
        // As the API: owners and admins; an owner's link only from an owner; shown once (fragment URL).
        issuePasswordSetup: mutation
          .input(z.object({ membershipId: z.string() }))
          .mutation(({ ctx, input }) => {
            if (ctx.member?.role !== 'owner' && ctx.member?.role !== 'admin')
              throw new PolicyDeniedError('membership.manage');
            const account = MEMBER_ACCOUNTS[input.membershipId];
            if (!account) throw new NotFoundError('Membership', input.membershipId);
            if (account.userId === ctx.member.userId)
              throw new PolicyDeniedError(
                'self_setup_link',
                'Set your own password in Settings → Account, not with a setup link',
              );
            if ((account.role === 'owner' || account.role === 'admin') && ctx.member.role !== 'owner')
              throw new PolicyDeniedError(
                'owner_required',
                'Only an owner can issue a password setup link for an owner or admin',
              );
            for (const link of backend.setupLinks.values())
              if (link.email === account.email) link.used = true;
            const token = `pst_e2e_${randomUUID().replace(/-/g, '')}`;
            const sessionToken = account.userId === 'usr_e2e' ? E2E.token : `ses_e2e_${account.userId}`;
            backend.setupLinks.set(token, { email: account.email, sessionToken, used: false });
            if (sessionToken !== E2E.token)
              backend.sessions.set(sessionToken, {
                userId: account.userId,
                memberships: { [backend.tenantId]: { role: account.role, brandIds: null } },
              });
            return {
              url: `/set-password#token=${token}`,
              expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
            };
          }),
      }),
      account: t.router({
        signInMethods: authedOnly.query(() => ({
          hasPassword: backend.passwords.has(E2E_EMAIL),
          hasGoogle: backend.hasGoogle,
        })),
        setPassword: authedOnly
          .input(z.object({ currentPassword: z.string().optional(), newPassword: z.string() }))
          .mutation(({ input }) => {
            const stored = backend.passwords.get(E2E_EMAIL);
            if (!stored && !backend.recentSignIn)
              throw new ValidationFailedError(
                [{ path: 'session', issue: 'recent_sign_in_required' }],
                'Sign in again to set a password',
              );
            if (stored && !input.currentPassword)
              throw new ValidationFailedError([{ path: 'currentPassword', issue: 'required' }]);
            if (stored && stored.password !== input.currentPassword)
              throw new ValidationFailedError([{ path: 'currentPassword', issue: 'incorrect' }]);
            const issue = passwordPolicyIssue(input.newPassword, E2E_EMAIL);
            if (issue) throw new ValidationFailedError([{ path: 'newPassword', issue }]);
            backend.passwords.set(E2E_EMAIL, { password: input.newPassword, sessionToken: E2E.token });
            return { ok: true as const };
          }),
        removePassword: authedOnly.input(z.object({ currentPassword: z.string() })).mutation(({ input }) => {
          if (backend.passwords.get(E2E_EMAIL)?.password !== input.currentPassword)
            throw new ValidationFailedError([{ path: 'currentPassword', issue: 'incorrect' }]);
          if (!backend.hasGoogle)
            throw new ValidationFailedError([{ path: 'password', issue: 'only_sign_in_method' }]);
          backend.passwords.delete(E2E_EMAIL);
          return { ok: true as const };
        }),
      }),
      session: authedOnly.query(() => ({
        userId: 'usr_e2e',
        name: 'E2E person',
        email: E2E_EMAIL,
      })),
      listCompanies: authedOnly.query(({ ctx }) => {
        const bearer = credentialOf(ctx.headers);
        // Every company of the group the caller belongs to, with the role and brand scope of that membership.
        return [backend, ...backend.companies].flatMap((company) => {
          const member = company.memberFor(bearer);
          return member
            ? [
                {
                  tenantId: company.tenantId,
                  name: company.companyName,
                  slug: company.tenantId.replace(/^ten_/, ''),
                  role: member.role,
                  allBrands: member.brandIds === null,
                },
              ]
            : [];
        });
      }),
    }),
    skills: t.router({
      /** UX-08: copywriting is served by the brand copywriting skill; the other kinds have no published skill here. */
      taskKinds: query.input(SkillTaskKinds).query(({ input }) => {
        if (input.brandId !== backend.brandId) throw new NotFoundError('Brand', input.brandId);
        return {
          items: TaskKind.options.map((taskKind) => ({
            taskKind,
            skills:
              taskKind === 'copywriting'
                ? [
                    {
                      skillVersionId: 'skv_copy_3',
                      skillId: 'sk_copy',
                      key: 'brand-copywriting',
                      title: 'Brand copywriting',
                      description: 'Drafts on-brand copy for the brief.',
                      versionNumber: 3,
                      inputSchema: {
                        type: 'object',
                        properties: {
                          goal: {
                            type: 'string',
                            maxLength: 1000,
                            description: 'What the copy must achieve.',
                          },
                          channels: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
                          tone: { type: 'string', enum: ['warm', 'direct'] },
                        },
                        required: ['goal'],
                        additionalProperties: false,
                      },
                    },
                  ]
                : taskKind === 'campaign_planning'
                  ? [
                      {
                        skillVersionId: 'skv_plan_1',
                        skillId: 'sk_plan',
                        key: 'campaign-planning',
                        title: 'Campaign planning',
                        description: 'Produces a brief and a content calendar; a person accepts the plan.',
                        versionNumber: 1,
                        inputSchema: {
                          type: 'object',
                          properties: {
                            objective: { type: 'string', maxLength: 1000 },
                            audience: { type: 'string', maxLength: 1000 },
                            offerFactIds: { type: 'array', items: { type: 'string' }, maxItems: 20 },
                            startDate: { type: 'string', format: 'date' },
                            endDate: { type: 'string', format: 'date' },
                            channels: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
                            notes: { type: 'string', maxLength: 4000 },
                            briefId: { type: 'string' },
                          },
                          required: ['objective', 'audience', 'startDate', 'endDate', 'channels'],
                          additionalProperties: false,
                        },
                      },
                    ]
                  : [],
          })),
        };
      }),
      list: query.input(SkillList).query(({ input }) => ({
        items: backend.skills.filter(
          (k) => (!input.scope || k.scope === input.scope) && (!input.brandId || k.brandId === input.brandId),
        ),
        nextCursor: null,
      })),
      /** UX-17: the skill with its versions, evaluations and bindings. */
      get: query.input(SkillGet).query(({ input }) => {
        const skill = backend.skills.find((k) => k.id === input.skillId);
        if (!skill) throw new NotFoundError('Skill', input.skillId);
        const versions = backend.skillVersions.get(skill.id) ?? [];
        // The sandbox has reported by the time the client polls again: in_review, its result already recorded.
        for (const v of versions)
          if (v.state === 'sandbox_evaluation') {
            v.state = 'in_review';
            v.version += 1;
          }
        return {
          ...skill,
          versions,
          bindings: [...backend.skillBindings.entries()]
            .filter(([, b]) => b.skillId === skill.id)
            .map(([key, b]) => ({
              id: b.id,
              scope: 'brand' as const,
              brandId: key.split(':')[0] ?? null,
              skillVersionId: b.skillVersionId,
              taskKind: 'copywriting' as const,
              priority: 0,
              createdAt: now(),
              version: 0,
            })),
          evaluations: backend.skillEvaluations.filter((r) =>
            versions.some((v) => v.id === r.skillVersionId),
          ),
        };
      }),
      versions: t.router({
        /** As the API plus the worker: the version goes to the sandbox and the suite reports a pass at once. */
        evaluate: mutation.input(SkillVersionEvaluate).mutation(({ ctx, input }) => {
          if (ctx.member?.role === 'creator' || ctx.member?.role === 'reviewer')
            throw new PolicyDeniedError('skill.author');
          const v = [...backend.skillVersions.values()].flat().find((x) => x.id === input.skillVersionId);
          if (!v) throw new NotFoundError('SkillVersion', input.skillVersionId);
          if (v.version !== input.expectedVersion)
            throw new ConflictError('SkillVersion', v.id, input.expectedVersion);
          // As the server: the version waits in the sandbox; the worker's report (here: the next read) moves it on.
          v.state = 'sandbox_evaluation';
          v.version += 1;
          backend.skillEvaluations.push({
            id: rid('ser'),
            suiteId: rid('ses'),
            skillVersionId: v.id,
            modelVersion: 'mock-model',
            runs: input.runs,
            scores: { brand_fit: 0.92 },
            variance: { brand_fit: 0.01 },
            deterministicChecks: { schema: true },
            passed: true,
            createdAt: now(),
          });
          return {
            skillVersionId: v.id,
            suiteId: 'ses_mock',
            state: 'sandbox_evaluation' as const,
            version: v.version,
          };
        }),
        publish: mutation.input(SkillVersionPublish).mutation(({ ctx, input }) => {
          if (ctx.member?.role !== 'owner' && ctx.member?.role !== 'admin')
            throw new PolicyDeniedError('skill.publish');
          const v = [...backend.skillVersions.values()].flat().find((x) => x.id === input.skillVersionId);
          if (!v) throw new NotFoundError('SkillVersion', input.skillVersionId);
          if (v.version !== input.expectedVersion)
            throw new ConflictError('SkillVersion', v.id, input.expectedVersion);
          if (v.state !== 'in_review')
            throw new ValidationFailedError([{ path: 'skillVersionId', issue: `version_${v.state}` }]);
          v.state = 'published';
          v.rolloutPercent = input.rolloutPercent;
          v.publishedAt = now();
          v.version += 1;
          const skill = backend.skills.find((k) => k.id === v.skillId);
          if (skill) skill.activeVersionId = v.id;
          return { skillVersionId: v.id, state: 'published' as const, version: v.version };
        }),
      }),
      bindings: t.router({
        set: mutation.input(SkillBindingSet).mutation(({ input }) => {
          const key = `${input.brandId ?? ''}:${input.skillId}`;
          if (input.skillVersionId === null) backend.skillBindings.delete(key);
          else
            backend.skillBindings.set(key, {
              id: rid('skb'),
              skillVersionId: input.skillVersionId,
              skillId: input.skillId,
            });
          return { ok: true as const };
        }),
      }),
      /** A package's manifest.json names the skill; it lands as the next draft version of that key. */
      import: mutation.input(SkillImport).mutation(({ input }) => {
        const manifestFile = input.files.find((f) => f.path === 'manifest.json');
        if (!manifestFile)
          throw new ValidationFailedError([{ path: 'files', issue: 'manifest.json is required' }]);
        const manifest = JSON.parse(manifestFile.content) as {
          key?: string;
          title?: string;
          scripts?: unknown;
        };
        if (manifest.scripts)
          throw new ValidationFailedError([{ path: 'manifest.scripts', issue: 'declarative_only' }]);
        if (!manifest.key) throw new ValidationFailedError([{ path: 'manifest.key', issue: 'required' }]);
        let skill = backend.skills.find((k) => k.key === manifest.key);
        if (!skill) {
          skill = {
            id: rid('sk'),
            scope: input.scope,
            brandId: input.scope === 'brand' ? (input.brandId ?? E2E.brandId) : null,
            key: manifest.key,
            title: manifest.title ?? manifest.key,
            state: 'active' as const,
            activeVersionId: null,
            ownerUserId: null,
            createdAt: now(),
            updatedAt: now(),
            version: 1,
          };
          backend.skills.push(skill);
        }
        const versions = backend.skillVersions.get(skill.id) ?? [];
        const number = (versions.at(-1)?.number ?? 0) + 1;
        const v = mockSkillVersion(rid('skv'), skill.id, number, 'draft');
        backend.skillVersions.set(skill.id, [...versions, v]);
        return {
          skillVersionId: v.id,
          skillId: skill.id,
          key: skill.key,
          number,
          packageHash: v.packageHash,
        };
      }),
      export: query.input(SkillExport).query(({ input }) => {
        const v = [...backend.skillVersions.values()].flat().find((x) => x.id === input.skillVersionId);
        if (!v) throw new NotFoundError('SkillVersion', input.skillVersionId);
        const skill = backend.skills.find((k) => k.id === v.skillId);
        return {
          skillVersionId: v.id,
          skillId: v.skillId,
          key: skill?.key ?? 'unknown',
          number: v.number,
          packageHash: v.packageHash,
          files: [
            { path: 'manifest.json', content: JSON.stringify({ schemaVersion: 1, key: skill?.key }) },
            { path: 'SKILL.md', content: '# Skill\n' },
          ],
        };
      }),
    }),
    agents: t.router({
      /** UX-16: the spend position and limits; owners and admins only (billing.manage), as the API. */
      budgets: t.router({
        read: query.input(BudgetRead).query(({ ctx, input }) => {
          if (ctx.member?.role !== 'owner' && ctx.member?.role !== 'admin')
            throw new PolicyDeniedError('billing.manage');
          if (input.brandId !== backend.brandId) throw new NotFoundError('Brand', input.brandId);
          const monthStored = backend.spendLimits.get('') ?? null;
          const dayStored = backend.spendLimits.get(input.brandId) ?? null;
          const entitlement = 250_000_000;
          const monthLimit = monthStored === null ? entitlement : Math.min(monthStored, entitlement);
          const dayLimit = dayStored ?? 20_000_000;
          return {
            brandId: input.brandId,
            month: {
              periodKey: '2026-09',
              storedLimitMicros: monthStored,
              entitlementMicros: entitlement,
              limitMicros: monthLimit,
              committedMicros: 42_500_000,
              remainingMicros: Math.max(0, monthLimit - 42_500_000),
            },
            day: {
              dayKey: '2026-09-30',
              limitMicros: dayLimit,
              storedLimitMicros: dayStored,
              committedMicros: 3_100_000,
              remainingMicros: Math.max(0, dayLimit - 3_100_000),
            },
            ledger: [
              {
                kind: 'model_tokens' as const,
                unit: 'tokens',
                quantity: 1_250_000,
                costMicros: 38_000_000,
                entries: 41,
              },
              {
                kind: 'image_generation' as const,
                unit: 'images',
                quantity: 12,
                costMicros: 4_500_000,
                entries: 12,
              },
            ],
            reservations: [
              {
                id: 'bres_1',
                runId: 'run_done',
                reservedMicros: 2_000_000,
                consumedMicros: 990_000,
                state: 'settled' as const,
                dayKey: '2026-09-30',
                createdAt: now(),
              },
            ],
          };
        }),
        setLimit: mutation.input(BudgetSetLimit).mutation(({ ctx, input }) => {
          if (ctx.member?.role !== 'owner' && ctx.member?.role !== 'admin')
            throw new PolicyDeniedError('billing.manage');
          backend.spendLimits.set(input.period === 'month' ? '' : input.brandId, input.limitMicros);
          return { brandId: input.brandId, period: input.period, limitMicros: input.limitMicros };
        }),
      }),
      routingPolicy: t.router({
        get: query.query(() => {
          if (backend.role !== 'owner' && backend.role !== 'admin')
            throw new PolicyDeniedError('billing.manage');
          const stored = backend.routingPolicy;
          return stored
            ? { ...stored, stored: true as const, inUse: backend.modelInUse }
            : { policy: null, version: null, stored: false as const, inUse: backend.modelInUse };
        }),
        // As the API: owners and admins, the stored version required once a policy exists, stale is CONFLICT.
        set: mutation.input(RoutingPolicySet).mutation(({ input }) => {
          if (backend.role !== 'owner' && backend.role !== 'admin')
            throw new PolicyDeniedError('billing.manage');
          const stored = backend.routingPolicy;
          const expected = input.expectedVersion;
          if (stored && expected === undefined)
            throw new ValidationFailedError([{ path: 'expectedVersion', issue: 'required' }]);
          if (stored && expected !== undefined && expected !== stored.version)
            throw new ConflictError('ModelRoutingPolicy', 'current', expected);
          const version = stored ? stored.version + 1 : 0;
          backend.routingPolicy = { policy: input.policy, version };
          return { policy: input.policy, version };
        }),
      }),
      runs: t.router({
        /** UX-07: a layout run on a document; as the server it is accepted at once and works on its own. */
        start: mutation.input(RunStart).mutation(({ input }) => {
          if (input.brandId !== backend.brandId) throw new NotFoundError('Brand', input.brandId);
          if (input.servicePrincipalId !== 'sp_e2e_agent')
            throw new NotFoundError('ServicePrincipal', input.servicePrincipalId);
          const id = rid('run');
          const run = backend.addRun(id, input.taskKind, 'running', 0);
          run.brief = input.brief;
          run.autonomyMode = input.requestedAutonomy;
          run.steps = [
            {
              id: `st_${id}_0`,
              index: 0,
              kind: 'plan',
              summary: 'reading the document and the brand snapshot',
              tokensIn: 0,
              tokensOut: 0,
              costMicros: 0,
              durationMs: 10,
              createdAt: now(),
              invocations: [],
            },
          ];
          const documentId = typeof input.brief['documentId'] === 'string' ? input.brief['documentId'] : null;
          if (documentId && input.taskKind === 'layout') {
            const doc = backend.doc(documentId);
            const head = backend.head(documentId);
            const firstPage = head.snapshot.pages[0];
            const text = firstPage?.elements.find((e) => e.type === 'text' && !e.locked && !e.protected);
            if (firstPage && text && text.type === 'text') {
              const operations: Operation[] = [
                {
                  op: 'setText',
                  pageId: firstPage.id,
                  elementId: text.id,
                  text: `${text.text} — proposed by the agent`,
                },
              ];
              const e = backend.evaluate(head, { operations, summary: 'x', origin: 'agent' });
              backend.runProposals.set(id, {
                stepId: `st_${id}_1`,
                documentId: doc.id,
                baseRevisionId: head.id,
                operations,
                summary: `Layout proposal: ${String(input.brief['notes'] ?? '').slice(0, 80) || 'tighten the headline'}`,
                contentHash: e.contentHash,
                findings: e.findings,
                createdAt: now(),
                reads: 0,
                decision: null,
              });
            }
          }
          return { runId: id, state: 'planned' as const, autonomyMode: input.requestedAutonomy };
        }),
        cancel: mutation.input(RunCancel).mutation(({ input }) => {
          const run = backend.runs.get(input.runId);
          if (!run) throw new NotFoundError('AgentRun', input.runId);
          Object.assign(run, {
            state: 'cancelled',
            finishedAt: now(),
            updatedAt: now(),
            version: run.version + 1,
          });
          backend.runProposals.delete(run.id);
          return { runId: run.id, state: 'cancelled' as const };
        }),
        pendingProposals: query.input(RunPendingProposals).query(({ input }) => {
          if (input.brandId !== backend.brandId) throw new NotFoundError('Brand', input.brandId);
          return {
            items: [...backend.runProposals.entries()]
              .flatMap(([runId, p]) => {
                const run = backend.runs.get(runId);
                return run &&
                  run.state === 'waiting_for_review' &&
                  p.documentId === input.documentId &&
                  !p.decision
                  ? [{ run, p }]
                  : [];
              })
              .map(({ run, p }) => {
                const runId = run.id;
                return {
                  runId,
                  stepId: p.stepId,
                  taskKind: run.taskKind,
                  brief: run.brief,
                  createdAt: p.createdAt,
                  proposal: {
                    documentId: p.documentId,
                    baseRevisionId: p.baseRevisionId,
                    operations: p.operations,
                    summary: p.summary,
                    contentHash: p.contentHash,
                    findings: p.findings,
                  },
                };
              }),
          };
        }),
        /** As the server: the batch is applied from the stored payload on accept (refused when the head moved). */
        approveProposal: mutation.input(RunApproveProposal).mutation(({ input }) => {
          const run = backend.runs.get(input.runId);
          if (!run) throw new NotFoundError('AgentRun', input.runId);
          const p = backend.runProposals.get(run.id);
          if (!p || p.stepId !== input.stepId) throw new NotFoundError('Proposal', input.stepId);
          if (run.state !== 'waiting_for_review')
            throw new ValidationFailedError([
              { path: 'runId', issue: `run is ${run.state}, not waiting_for_review` },
            ]);
          if (p.decision)
            throw new ValidationFailedError([{ path: 'stepId', issue: 'proposal_already_decided' }]);
          let appliedRevisionId: string | null = null;
          const note = `proposal ${input.stepId} ${input.decision} by user usr_e2e`;
          if (input.decision === 'modify') {
            const batch = (input.batch ?? {}) as {
              baseRevisionId: string;
              operations: Operation[];
              summary: string;
            };
            const applied = backend.apply({
              documentId: p.documentId,
              baseRevisionId: batch.baseRevisionId,
              operations: batch.operations,
              summary: batch.summary,
              origin: 'user',
            });
            appliedRevisionId = applied.revision.id;
          }
          // As the server: the decision is recorded and relayed; the run stays parked until it records it.
          p.decision = { decision: input.decision, stepId: input.stepId };
          run.steps.push({
            id: `st_${run.id}_${run.steps.length}`,
            index: run.steps.length,
            kind: 'validation',
            summary: appliedRevisionId ? `${note}: revision ${appliedRevisionId}` : note,
            tokensIn: 0,
            tokensOut: 0,
            costMicros: 0,
            durationMs: 5,
            createdAt: now(),
            invocations: [],
          });
          Object.assign(run, { updatedAt: now(), version: run.version + 1 });
          return { runId: run.id, stepId: input.stepId, decision: input.decision, appliedRevisionId };
        }),
        list: query.input(RunList).query(({ input }) =>
          paged(
            [...backend.runs.values()]
              .filter((r) => r.brandId === input.brandId)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
              .map(({ steps: _s, ...dto }) => dto),
            input.page,
          ),
        ),
        get: query.input(RunGet).query(({ input }) => {
          const run = backend.runs.get(input.runId);
          if (!run) throw new NotFoundError('AgentRun', input.runId);
          // A studio-started run parks on its proposal on the second read (the worker has produced it by then).
          const p = backend.runProposals.get(run.id);
          if (p && p.decision && run.state === 'waiting_for_review') {
            // The workflow records the decision: an accepted batch is applied from the stored payload (refused
            // when the head moved), then the run finishes.
            let note = `decision ${p.decision.decision} recorded`;
            if (p.decision.decision === 'accept') {
              try {
                const applied = backend.apply({
                  documentId: p.documentId,
                  baseRevisionId: p.baseRevisionId,
                  operations: p.operations,
                  summary: p.summary,
                  origin: 'agent',
                  agentRunId: run.id,
                });
                note += `: revision ${applied.revision.id} created`;
              } catch (err) {
                note += `: apply failed (${err instanceof StaleRevisionError ? 'stale_revision' : 'error'})`;
              }
            }
            backend.runProposals.delete(run.id);
            run.steps.push({
              id: `st_${run.id}_${run.steps.length}`,
              index: run.steps.length,
              kind: 'validation',
              summary: note,
              tokensIn: 0,
              tokensOut: 0,
              costMicros: 0,
              durationMs: 5,
              createdAt: now(),
              invocations: [],
            });
            Object.assign(run, {
              state: 'completed',
              finishedAt: now(),
              updatedAt: now(),
              version: run.version + 1,
            });
          } else if (p && run.state === 'running') {
            p.reads += 1;
            if (p.reads >= 2) {
              run.steps.push({
                id: p.stepId,
                index: run.steps.length,
                kind: 'tool_call',
                summary: 'creative.proposeOperations: proposal awaits a person',
                tokensIn: 400,
                tokensOut: 120,
                costMicros: 1_200,
                durationMs: 900,
                createdAt: now(),
                invocations: [],
              });
              Object.assign(run, { state: 'waiting_for_review', updatedAt: now(), version: run.version + 1 });
            }
          }
          const { steps: _s, ...dto } = run;
          return dto;
        }),
        steps: query.input(RunSteps).query(({ input }) => {
          const run = backend.runs.get(input.runId);
          if (!run) throw new NotFoundError('AgentRun', input.runId);
          return { items: run.steps, nextCursor: null };
        }),
      }),
    }),
    operations: t.router({
      killSwitch: t.router({
        // As the server: engaged when the company-wide row is, or the brand's own row.
        get: query
          .input(
            z.object({ scope: z.enum(['agent_starts', 'release_dispatch']), brandId: z.string().optional() }),
          )
          .query(({ input }) => {
            if (backend.role !== 'owner' && backend.role !== 'admin')
              throw new PolicyDeniedError('audit.read');
            const on = (b: string) => backend.killSwitches.get(`${input.scope}:${b}`)?.engaged === true;
            return { engaged: on('') || (input.brandId ? on(input.brandId) : false) };
          }),
        set: mutation
          .input(
            z.object({
              scope: z.enum(['agent_starts', 'release_dispatch']),
              brandId: z.string().nullable(),
              engaged: z.boolean(),
              reason: z.string().max(500).nullable(),
            }),
          )
          .mutation(({ input }) => {
            if (backend.role !== 'owner' && backend.role !== 'admin')
              throw new PolicyDeniedError('billing.manage');
            backend.killSwitches.set(`${input.scope}:${input.brandId ?? ''}`, {
              engaged: input.engaged,
              reason: input.reason,
            });
            return { ok: true };
          }),
      }),
      audit: t.router({
        /** The run history the agents screen reads: one `agent.run.request` event per run of this company. */
        query: query.input(z.object({ query: AuditQuery, page: PageRequest })).query(({ input }) => ({
          items: [...backend.runs.values()]
            .filter(() => input.query.resourceType === undefined || input.query.resourceType === 'agent_run')
            .map((r, i) => ({
              id: `aud_${String(1000 - i).padStart(4, '0')}`,
              tenantId: backend.tenantId,
              actorKind: 'user',
              actorId: r.initiatorId,
              supportSessionId: null,
              action: 'agent.run.request',
              resourceType: 'agent_run',
              resourceId: r.id,
              decision: 'allowed' as const,
              reason: null,
              correlationId: r.correlationId,
              metadata: { brandId: r.brandId, runId: r.id, toState: 'planned' },
              createdAt: new Date(r.createdAt),
            })),
          nextCursor: null,
        })),
      }),
    }),
    brand: t.router({
      policy: t.router({
        // No policy version is activated until the screen creates and activates one (UX-20); until then the
        // defaults are in force, as the API answers NOT_FOUND.
        get: query.input(PolicyGet).query(({ input }) => {
          const mine = backend.policyVersions.filter((p) => p.brandId === input.brandId);
          const found = input.policyVersionId
            ? mine.find((p) => p.id === input.policyVersionId)
            : mine.find((p) => p.state === 'active');
          if (!found) throw new NotFoundError('PolicyVersion', input.policyVersionId ?? 'active');
          return found;
        }),
        createVersion: mutation.input(PolicyVersionCreate).mutation(({ input }) => {
          // D-13: `flag` is refused as the server refuses it, until approval binding v2.
          if (input.document.onBrandVersionPublished === 'flag')
            throw new ValidationFailedError([
              { path: 'document.onBrandVersionPublished', issue: 'flag is designed but not enabled' },
            ]);
          const id = `pv_${backend.policyVersions.length + 1}`;
          backend.policyVersions.push({
            id,
            brandId: input.brandId,
            number: backend.policyVersions.length + 1,
            state: 'draft',
            document: PolicyDocumentV1.parse({
              ...input.document,
              // D-11 as the API: a client brand needs a distinct approver unless the document says otherwise.
              requireDistinctApprover:
                input.document.requireDistinctApprover ??
                (backend.brands.find((b) => b.id === input.brandId)?.classification ?? 'client') === 'client',
            }),
            createdByUserId: 'usr_e2e',
            createdAt: now(),
            updatedAt: now(),
            version: 0,
          });
          return { policyVersionId: id, number: backend.policyVersions.length, version: 0 };
        }),
        activate: mutation.input(PolicyVersionActivate).mutation(({ input }) => {
          const pv = backend.policyVersions.find((p) => p.id === input.policyVersionId);
          if (!pv) throw new NotFoundError('PolicyVersion', input.policyVersionId);
          if (pv.version !== input.expectedVersion)
            throw new ConflictError('PolicyVersion', input.policyVersionId, pv.version);
          for (const other of backend.policyVersions)
            if (other.brandId === pv.brandId && other.state === 'active') other.state = 'retired';
          pv.state = 'active';
          pv.version += 1;
          return { policyVersionId: pv.id, state: 'active' as const, version: pv.version };
        }),
      }),
      list: query.query(({ ctx }) =>
        backend.brands
          .filter((b) => !ctx.member?.brandIds || ctx.member.brandIds.includes(b.id))
          .map((b) => ({
            id: b.id,
            name: b.name,
            timezone: 'UTC',
            defaultLocale: 'en',
            status: 'active' as const,
            classification: b.classification ?? ('client' as const),
            publishedVersionId: b.publishedVersionId,
            version: b.version ?? 1,
          })),
      ),
      // As the API: per visible brand, open requests past due, publications needing a person, and those due this week.
      summary: query.query(({ ctx }) => {
        const now = Date.now();
        const until = now + 7 * 24 * 3600 * 1000;
        const pubs = [...backend.phase5.publications.values()];
        const reqs = [...backend.phase5.requests.values()];
        return {
          upcomingDays: 7,
          brands: backend.brands
            .filter((b) => !ctx.member?.brandIds || ctx.member.brandIds.includes(b.id))
            .map((b) => ({
              brandId: b.id,
              overdueApprovals: reqs.filter(
                (r) => r.brandId === b.id && r.state === 'open' && r.dueAt && Date.parse(r.dueAt) < now,
              ).length,
              publicationsNeedingPerson: pubs.filter(
                (p) => p.brandId === b.id && ['failed', 'outcome_unknown', 'held'].includes(p.state),
              ).length,
              upcomingPublications: pubs.filter((p) => {
                const at = Date.parse(p.scheduledFor);
                return p.brandId === b.id && p.state === 'scheduled' && at >= now && at < until;
              }).length,
            })),
        };
      }),
      get: query.input(z.object({ brandId: z.string() })).query(({ input }) => {
        const b = backend.brands.find((x) => x.id === input.brandId);
        if (!b) throw new NotFoundError('Brand', input.brandId);
        return {
          id: b.id,
          name: b.name,
          timezone: 'UTC',
          defaultLocale: 'en',
          status: 'active' as const,
          classification: b.classification ?? ('client' as const),
          publishedVersionId: b.publishedVersionId,
          activePolicyVersionId: null,
          version: b.version ?? 1,
        };
      }),
      // As the API: optimistic on the brand's version (the mock does not check who may reclassify).
      classify: mutation.input(BrandClassify).mutation(({ input }) => {
        const b = backend.brands.find((x) => x.id === input.brandId);
        if (!b) throw new NotFoundError('Brand', input.brandId);
        if (input.expectedVersion !== (b.version ?? 1))
          throw new ConflictError('Brand', b.id, input.expectedVersion);
        b.classification = input.classification;
        b.version = (b.version ?? 1) + 1;
        return { brandId: b.id, classification: input.classification, version: b.version };
      }),
      versions: t.router({
        list: query
          .input(BrandVersionList)
          .query(() => ({ items: [summaryOf(brandDraft), brandVersionSummary], nextCursor: null })),
        get: query
          .input(BrandVersionGet)
          .query(({ input }) => (input.versionId === brandDraft.id ? brandDraft : brandVersion)),
        /** UX-20: what a publish reaches now, from the review and publishing stores as the API composes them. */
        impact: query.input(BrandVersionImpact).query(({ input }) => {
          const requests = [...backend.phase5.requests.values()].filter(
            (r) => r.brandId === input.brandId && r.state === 'open',
          );
          const approvals = backend.phase5.approvals.filter(
            (a) => a.brandId === input.brandId && a.state === 'valid',
          ).length;
          const publications = [...backend.phase5.publications.values()].filter(
            (p) => p.brandId === input.brandId && p.state === 'scheduled',
          );
          const active = backend.policyVersions.find((p) => p.state === 'active');
          return {
            brandId: input.brandId,
            available: true,
            policy: {
              configured: active?.document.onBrandVersionPublished ?? null,
              effective: 'invalidate_and_hold' as const,
            },
            requests: requests.map((r) => ({
              id: r.id,
              contentRevisionId: r.contentRevisionId,
              dueAt: r.dueAt,
              assignees: r.assignees.length,
            })),
            approvals,
            publications: publications.map((p) => ({
              publicationId: p.id,
              contentPackageId: p.contentPackageId,
              contentRevisionId: p.contentRevisionId,
              channelConnectionId: p.channelConnectionId,
              scheduledFor: p.scheduledFor,
            })),
            computedAt: now(),
          };
        }),
        update: mutation.input(BrandVersionUpdate).mutation(({ input }) => {
          backend.brandDraftDocument = input.document as { voice?: unknown };
          brandDraft = {
            ...brandDraft,
            document: input.document as typeof brandDraftDoc,
            contentHash: hash(input.document),
            version: brandDraft.version + 1,
          };
          return {
            versionId: brandDraft.id,
            version: brandDraft.version,
            contentHash: brandDraft.contentHash,
          };
        }),
      }),
      onboarding: t.router({
        /** A known principal starts a run on the draft; anything else is refused the way the server refuses it. */
        start: mutation.input(OnboardingStart).mutation(({ input }) => {
          if (input.servicePrincipalId !== 'sp_e2e_onboarding')
            throw new NotFoundError('ServicePrincipal', input.servicePrincipalId);
          if (input.versionId !== brandDraft.id)
            throw new ValidationFailedError([
              { path: 'versionId', issue: 'onboarding proposes into a draft only' },
            ]);
          return {
            runId: 'run_e2e_onboarding',
            state: 'planned',
            autonomyMode: 'create',
            workflowId: 'run:run_e2e_onboarding',
            versionId: brandDraft.id,
          };
        }),
      }),
      facts: t.router({ list: query.input(FactList).query(() => ({ items: [], nextCursor: null })) }),
      objectives: t.router({
        list: query.input(ObjectiveList).query(() => ({ items: [], nextCursor: null })),
      }),
    }),
    assets: t.router({
      search: query.input(AssetSearch).query(() => ({
        items: [
          {
            assetId: 'ast_e2e',
            assetVersionId: 'av_photo',
            kind: 'photo' as const,
            semanticRole: null,
            altText: 'Sample photo',
            contentHash: hash('photo'),
            width: 2,
            height: 2,
          },
        ],
        nextCursor: null,
      })),
      /** Every asset of the brand with its issues (spec 21.2), filtered as assets.list is. */
      list: query.input(AssetList).query(({ input }) => {
        const items = backend.assets
          .filter((a) => !input.state || a.state === input.state)
          .filter((a) => !input.kinds || input.kinds.includes(a.kind))
          .filter((a) => !input.query || a.name.toLowerCase().includes(input.query.toLowerCase()))
          .filter((a) => !input.needsAttention || assetIssues(a).length > 0)
          .map((a) => ({
            id: a.id,
            brandId: backend.brandId,
            kind: a.kind,
            name: a.name,
            semanticRole: null,
            state: a.state,
            rightsState: a.rights ? ('recorded' as const) : ('unknown' as const),
            version: a.version,
            createdAt: a.createdAt,
            updatedAt: a.createdAt,
            currentVersion: { ...assetVersionOf(a), provenance: undefined, bytes: undefined },
            rights: a.rights
              ? {
                  owner: a.rights.owner,
                  permittedChannels: 'all' as const,
                  territories: 'all' as const,
                  expiresAt: a.rights.expiresAt,
                }
              : null,
            issues: assetIssues(a),
          }));
        return paged(items, input.page);
      }),
      /** The asset as the inspector and the brand kit editor read it. */
      get: query.input(AssetGet).query(({ input }) => {
        const a = backend.asset(input.assetId);
        return {
          id: a.id,
          brandId: backend.brandId,
          kind: a.kind,
          name: a.name,
          semanticRole: null,
          state: a.state,
          rightsState: a.rights ? ('recorded' as const) : ('unknown' as const),
          currentVersion: assetVersionOf(a),
          derivatives: [],
          rights: a.rights
            ? {
                id: `ur_${a.id}`,
                owner: a.rights.owner,
                licenceRef: a.rights.licenceRef,
                permittedChannels: 'all' as const,
                territories: 'all' as const,
                expiresAt: a.rights.expiresAt ? new Date(a.rights.expiresAt) : null,
                releases: [],
                restrictions: [],
                version: 1,
              }
            : null,
          version: a.version,
        };
      }),
      approve: mutation.input(AssetApprove).mutation(({ ctx, input }) => {
        if (ctx.member?.role === 'creator') throw new PolicyDeniedError('role');
        const a = backend.asset(input.assetId);
        if (a.version !== input.expectedVersion)
          throw new ConflictError('Asset', a.id, input.expectedVersion);
        if (a.state !== 'pending_review')
          throw new ValidationFailedError([{ path: 'assetId', issue: `asset_${a.state}` }]);
        a.state = 'approved';
        a.version += 1;
        return { assetId: a.id, state: a.state, version: a.version };
      }),
      retire: mutation.input(AssetRetire).mutation(({ ctx, input }) => {
        if (ctx.member?.role === 'creator') throw new PolicyDeniedError('role');
        const a = backend.asset(input.assetId);
        if (a.version !== input.expectedVersion)
          throw new ConflictError('Asset', a.id, input.expectedVersion);
        if (a.state !== 'approved')
          throw new ValidationFailedError([{ path: 'assetId', issue: `asset_${a.state}` }]);
        a.state = 'retired';
        a.version += 1;
        return { assetId: a.id, state: a.state, version: a.version };
      }),
      rights: t.router({
        set: mutation.input(UsageRightsInput).mutation(({ input }) => {
          const a = backend.asset(input.assetId);
          if (!a.rights) a.version += 1; // the server bumps the asset when rightsState flips to recorded
          a.rights = {
            owner: input.owner,
            licenceRef: input.licenceRef ?? null,
            expiresAt: input.expiresAt ?? null,
          };
          return { usageRightsId: `ur_${a.id}` };
        }),
      }),
      uploads: t.router({
        createIntent: mutation.input(UploadIntentCreate).mutation(({ input }) => {
          const intentId = rid('upi');
          backend.fontIntents.set(intentId, { ...input, polls: 0, assetId: null });
          return {
            intentId,
            uploadUrl: `${backend.objectStoreOrigin}/e2e-upload/${intentId}`,
            expiresAt: new Date(Date.now() + 3600_000),
            maxBytes: 10 * 1024 * 1024,
          };
        }),
        complete: mutation.input(UploadIntentComplete).mutation(({ input }) => {
          const intent = backend.fontIntents.get(input.intentId);
          if (!intent) throw new NotFoundError('UploadIntent', input.intentId);
          if (intent.kind === 'font') {
            const family = intent.originalFilename.replace(/\.[a-z0-9]+$/i, '');
            backend.fonts.push(fontFace(rid('ast'), family, 400, 'upload'));
          }
          return { intentId: input.intentId, state: 'uploaded' as const };
        }),
        /** The ingest workflow's side: the second read settles the intent (accepted, catalogued pending review). */
        get: query.input(UploadIntentGet).query(({ input }) => {
          const intent = backend.fontIntents.get(input.intentId);
          if (!intent) throw new NotFoundError('UploadIntent', input.intentId);
          intent.polls += 1;
          if (intent.polls >= 2 && !intent.assetId) {
            intent.assetId = rid('ast');
            if (intent.kind !== 'font')
              backend.assets.unshift(
                mockAsset(
                  intent.assetId,
                  intent.kind === 'logo' || intent.kind === 'illustration' ? intent.kind : 'photo',
                  intent.originalFilename,
                  'pending_review',
                  null,
                ),
              );
          }
          return {
            intentId: input.intentId,
            state: intent.assetId ? ('accepted' as const) : ('uploaded' as const),
            assetId: intent.assetId,
            rejectionReason: null,
          };
        }),
      }),
      fonts: t.router({
        list: query.input(BrandFontsList).query(() => ({ items: backend.fonts })),
        importGoogle: mutation.input(GoogleFontImport).mutation(({ input }) => {
          backend.googleImports.push(input);
          if (input.family !== 'Inter')
            throw new ValidationFailedError(
              [{ path: 'family', issue: 'google_fonts_family_unknown' }],
              `Google Fonts has no family "${input.family}" with those weights and styles`,
            );
          // Inter is a variable family: css2 names one file per subset for every weight asked for.
          const assetId = 'ast_inter_var';
          const range = { min: 100, max: 900 };
          if (!backend.fonts.some((f) => f.assetId === assetId))
            backend.fonts.push(
              fontFace(
                assetId,
                'Inter',
                100,
                'google_fonts',
                [
                  ['latin', 'U+0000-00FF'],
                  ['latin-ext', 'U+0100-02AF'],
                ],
                range,
              ),
            );
          const files = ['latin', 'latin-ext'].map((subset) => ({
            weight: 100,
            weightRange: range,
            style: 'normal' as const,
            subset,
            unicodeRange: subset === 'latin' ? 'U+0000-00FF' : 'U+0100-02AF',
            contentHash: hash(`${assetId}:${subset}`),
            outcome: 'queued' as const,
            assetId: null,
            intentId: rid('upi'),
          }));
          return { family: 'Inter', files };
        }),
      }),
      media: t.router({
        signedUrl: query.input(MediaSignedUrlRequest).query(({ input }) => {
          if (input.assetVersionId.startsWith('av_font_'))
            return {
              url: `${backend.objectStoreOrigin}/e2e-object/${input.assetVersionId}`,
              expiresAt: new Date(Date.now() + 300_000),
              mime: 'font/ttf',
            };
          if (input.assetVersionId !== 'av_photo')
            throw new NotFoundError('AssetVersion', input.assetVersionId);
          return { url: pngDataUrl, expiresAt: new Date(Date.now() + 300_000), mime: 'image/png' };
        }),
      }),
    }),
    creative: t.router({
      documents: t.router({
        create: mutation.input(DocumentCreate).mutation(({ input }) => {
          const doc = backend.createDocument(input.title, input.document);
          const head = backend.head(doc.id);
          return {
            documentId: doc.id,
            revisionId: head.id,
            number: 1,
            version: 1,
            contentHash: head.contentHash,
            findings: [],
          };
        }),
        get: query.input(DocumentGet).query(({ input }) => {
          const { revisions: _r, ...doc } = backend.doc(input.documentId);
          return { ...doc, revision: backend.head(input.documentId) };
        }),
        list: query.input(DocumentList).query(({ input }) =>
          paged(
            [...backend.docs.values()]
              .filter(
                (d) =>
                  d.brandId === input.brandId &&
                  (input.contentPackageId === undefined || d.contentPackageId === input.contentPackageId),
              )
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
              .map(({ revisions: _r, ...doc }) => doc),
            input.page,
          ),
        ),
      }),
      revisions: t.router({
        list: query.input(RevisionList).query(({ input }) => ({
          items: backend
            .doc(input.documentId)
            .revisions.slice()
            .reverse()
            .map(({ operations: _o, snapshot: _s, ...summary }) => summary),
          nextCursor: null,
        })),
        get: query.input(RevisionGet).query(({ input }) => {
          const rev = backend.doc(input.documentId).revisions.find((r) => r.id === input.revisionId);
          if (!rev) throw new NotFoundError('CreativeRevision', input.revisionId);
          return rev;
        }),
      }),
      operations: t.router({
        applyBatch: mutation.input(OperationsApply).mutation(({ input }) => {
          if (backend.failNextApply) {
            backend.failNextApply = false;
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'simulated outage' });
          }
          return backend.apply(input);
        }),
        propose: mutation.input(OperationsPropose).mutation(({ input }) => {
          const { documentId, ...batch } = input;
          const doc = backend.doc(documentId);
          if (doc.currentRevisionId !== batch.baseRevisionId)
            throw new StaleRevisionError(doc.currentRevisionId);
          const base = backend.head(documentId);
          const e = backend.evaluate(base, batch);
          return {
            baseRevisionId: base.id,
            snapshot: e.snapshot,
            contentHash: e.contentHash,
            findings: e.findings,
            changedElementIds: e.changedElementIds,
            blocking: e.blocking,
            preview: {
              kind: 'scene' as const,
              rendererVersion: '1.0.0',
              publishable: false as const,
              pages: [],
            },
          };
        }),
      }),
      renders: t.router({
        request: mutation.input(RenderRequest).mutation(({ input }) => {
          const id = rid('rj');
          backend.jobs.set(id, {
            id,
            revisionId: input.revisionId,
            formatKeys: input.formatKeys,
            state: 'pending',
            attempts: 0,
            error: null,
            requestedByKind: 'user',
            requestedById: 'usr_e2e',
            exportIds: [],
            exports: [],
            createdAt: now(),
            updatedAt: now(),
            version: 0,
            polls: 0,
          });
          return { renderJobId: id, state: 'pending' as const, version: 0 };
        }),
        get: query.input(RenderGet).query(({ input }) => {
          const job = backend.jobs.get(input.renderJobId);
          if (!job) throw new NotFoundError('RenderJob', input.renderJobId);
          job.polls += 1;
          // No render worker in a UI-only smoke: the job fails on the second poll when asked to, else stays queued.
          if (backend.failNextRender && job.polls >= 2) {
            backend.failNextRender = false;
            job.state = 'failed';
            job.error = 'Renderer exited: font asset av_font could not be loaded';
          }
          const { polls: _p, ...dto } = job;
          return dto;
        }),
      }),
      comments: t.router({
        add: mutation.input(CommentAdd).mutation(({ input }) => {
          backend.doc(input.documentId);
          const c: Comment = {
            id: rid('cmt'),
            documentId: input.documentId,
            revisionId: input.revisionId,
            elementId: input.elementId,
            body: input.body,
            authorKind: 'user',
            authorId: 'usr_e2e',
            state: 'open',
            createdAt: now(),
            updatedAt: now(),
            version: 0,
          };
          backend.comments.push(c);
          return { commentId: c.id, state: 'open' as const, version: 0 };
        }),
        resolve: mutation.input(CommentResolve).mutation(({ input }) => {
          const c = backend.comments.find((x) => x.id === input.commentId);
          if (!c) throw new NotFoundError('ElementComment', input.commentId);
          c.state = 'resolved';
          c.version += 1;
          return { commentId: c.id, state: 'resolved' as const, version: c.version };
        }),
        list: query.input(CommentList).query(({ input }) => ({
          items: backend.comments.filter((c) => c.documentId === input.documentId),
          nextCursor: null,
        })),
      }),
      templates: t.router({
        list: query.input(TemplateList).query(() => ({
          items: [
            {
              id: 'tpl_e2e',
              brandId: backend.brandId,
              name: 'Promo template',
              currentVersionId: 'tv_e2e',
              state: 'active' as const,
              createdAt: now(),
              updatedAt: now(),
              version: 1,
            },
          ],
          nextCursor: null,
        })),
        get: query.input(TemplateGet).query(() => ({
          id: 'tpl_e2e',
          brandId: backend.brandId,
          name: 'Promo template',
          currentVersionId: 'tv_e2e',
          state: 'active' as const,
          createdAt: now(),
          updatedAt: now(),
          version: 1,
          versions: [],
          selectedVersion: {
            id: 'tv_e2e',
            templateId: 'tpl_e2e',
            number: 1,
            slots: [{ key: 'headline', elementId: ids.headline, kind: 'text', required: true }],
            constraints: {},
            formats: ['square_1080'],
            document: fixtureDocument(),
            contentHash: hash('tv'),
            state: 'approved' as const,
            createdAt: now(),
          },
        })),
      }),
    }),
  });
}

export type MockRouter = ReturnType<typeof createMockRouter>;

/** One company's handler: its router over its own stores, logging every request it serves. */
function companyHandler(backend: MockBackend) {
  return createHTTPHandler({
    router: createMockRouter(backend),
    basePath: '/trpc/',
    createContext: ({ req }) => {
      const path = (req.url ?? '').replace(/^\/trpc\//, '').split('?')[0] ?? '';
      backend.requests.push({ path, headers: req.headers });
      return { headers: req.headers, correlationId: first(req.headers['x-correlation-id']) ?? randomUUID() };
    },
  });
}

/**
 * A Node request handler mounted at /trpc by the static server. With several companies (`addCompany`) a request goes
 * to the company its X-Oremedia-Tenant header names, so each tenant's reads and writes only ever reach its own
 * stores; requests without a tenant (listCompanies, the review portal) and unknown tenants go to the first company,
 * which answers them or refuses the tenant as apps/api does.
 */
export function createMockHandler(backend: MockBackend): RequestListener {
  const handlers = new Map<string, RequestListener>(
    [backend, ...backend.companies].map((company) => [company.tenantId, companyHandler(company)]),
  );
  const primary = handlers.get(backend.tenantId) as RequestListener;
  return (req, res) => (handlers.get(first(req.headers['x-oremedia-tenant']) ?? '') ?? primary)(req, res);
}

/**
 * The password routes of apps/api/src/auth/router.ts for the UI-only smokes, mounted at /auth by the static server:
 * the same paths, JSON bodies, Origin check and answers (`{ ok: true }` with the session and CSRF cookies set, or
 * `{ ok: false, error }`), over the backend's in-memory passwords and setup links. Sign-out answers 204 as before.
 */
export function createMockAuthHandler(backend: MockBackend): RequestListener {
  const answer = (res: ServerResponse, status: number, body: PasswordAuthResponse, sessionToken?: string) => {
    if (sessionToken)
      res.setHeader('set-cookie', [
        `oremedia_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax`,
        `oremedia_csrf=csrf_${randomUUID()}; Path=/; SameSite=Lax`,
      ]);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });
  return (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method !== 'POST') return answer(res, 404, { ok: false, error: 'sign_in_failed' });
    if (path === '/auth/sign-out') {
      res.writeHead(204, {
        'set-cookie': ['oremedia_session=; Path=/; Max-Age=0', 'oremedia_csrf=; Path=/; Max-Age=0'],
      });
      res.end();
      return;
    }
    void readJson(req).then((body) => {
      const origin = first(req.headers['origin']);
      backend.authRequests.push({ path, origin, body });
      // Login CSRF: the API accepts only its own origin (WEB_ORIGIN, or the request's host).
      if (!origin || new URL(origin).host !== req.headers['host'])
        return answer(res, 403, { ok: false, error: 'origin_rejected' });
      if (path === '/auth/password/sign-in') {
        const parsed = PasswordSignIn.safeParse(body);
        const account = parsed.success ? backend.passwords.get(parsed.data.email.toLowerCase()) : undefined;
        if (!parsed.success || !account || account.password !== parsed.data.password)
          return answer(res, 401, { ok: false, error: 'invalid_credentials' });
        return answer(res, 200, { ok: true }, account.sessionToken);
      }
      if (path === '/auth/password/setup') {
        const parsed = PasswordSetup.safeParse(body);
        const link = parsed.success ? backend.setupLinks.get(parsed.data.token) : undefined;
        if (!parsed.success || !link || link.used)
          return answer(res, 400, { ok: false, error: 'link_invalid' });
        const issue = passwordPolicyIssue(parsed.data.password, link.email);
        if (issue) return answer(res, 400, { ok: false, error: 'password_rejected', issue });
        link.used = true;
        backend.passwords.set(link.email, {
          password: parsed.data.password,
          sessionToken: link.sessionToken,
        });
        return answer(res, 200, { ok: true }, link.sessionToken);
      }
      answer(res, 404, { ok: false, error: 'sign_in_failed' });
    });
  };
}
