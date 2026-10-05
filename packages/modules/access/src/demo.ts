import { DemoRefusedError } from '@oremedia/contracts/errors';
import { currentTenant, requireTenant, type Tx } from '@oremedia/db';
import { count, METRIC } from '@oremedia/observability';
import { audit } from '@oremedia/module-operations';
import { tenantKinds } from './resolve';

/**
 * Demo workspace (architecture §4.2): the commands that reach outside the product. In a demo company each is refused
 * in its service, so tRPC, REST and MCP refuse it identically, with a message that says what the demo does instead.
 * A live company is never affected: the check reads the company's immutable kind and returns at once for `live`.
 */
export type DemoRefusedCapability =
  | 'channel_connect'
  | 'destination_connect'
  | 'site_audit'
  | 'rendered_validation'
  | 'brand_assist'
  | 'brand_source_capture'
  | 'google_fonts_import'
  | 'ai_generation'
  | 'video_ai'
  | 'agent_run'
  | 'agent_variants'
  | 'analyst_run'
  | 'spend_limit'
  | 'skill_evaluation'
  | 'member_invite'
  | 'password_setup_link'
  | 'api_client'
  | 'service_principal';

const DEMO_MESSAGES: Record<DemoRefusedCapability, string> = {
  channel_connect:
    'Not available in the demo workspace: channels here are simulated and never connect to a real platform.',
  destination_connect:
    'Not available in the demo workspace: websites and data sources here are simulated and never connect to a real site.',
  site_audit:
    'Not available in the demo workspace: an audit would crawl a real website. The demo shows example findings.',
  rendered_validation:
    'Not available in the demo workspace: checking a live page would fetch a real website. Nothing was published there.',
  brand_assist:
    'Not available in the demo workspace: brand assist would read websites and call a model. The demo shows example suggestions.',
  brand_source_capture: 'Not available in the demo workspace: adding a source would fetch a real web page.',
  google_fonts_import:
    'Not available in the demo workspace: importing from Google Fonts would download from the internet.',
  ai_generation:
    'AI generation is not available in the demo workspace: no model is called here. The demo shows example outputs.',
  video_ai:
    'AI video jobs are not available in the demo workspace: no model is called here. The demo shows an example storyboard.',
  agent_run:
    'Agent runs are not available in the demo workspace: no model is called here. The demo shows example runs.',
  agent_variants:
    'Generating variants starts an agent run, which is not available in the demo workspace. Create a brief from this recommendation instead.',
  analyst_run:
    'The analyst is not available in the demo workspace: no model is called here. The demo shows example insights.',
  spend_limit: 'Spend limits stay at zero in the demo workspace: no paid call runs here.',
  skill_evaluation: 'Skill evaluation is not available in the demo workspace: it would call a model.',
  member_invite: 'The demo workspace is yours alone: nobody else can be invited to it.',
  password_setup_link: 'The demo workspace is yours alone: setup links cannot be issued in it.',
  api_client: 'The demo workspace is yours alone: API keys cannot be created in it.',
  service_principal: 'The demo workspace is yours alone: service principals cannot be created in it.',
};

/** The current request's or activity's company is a demo workspace (requires a tenant context). */
export async function isDemoTenant(tx?: Tx): Promise<boolean> {
  const ctx = requireTenant();
  return (await tenantKinds.of(ctx.tenantId, ctx.correlationId, tx)) === 'demo';
}

/**
 * Refuses `capability` in a demo workspace with DemoRefusedError('demo_simulated') and its plain message; returns for a
 * live company. The refusal is audited on its own connection (it survives the command's rollback), like a policy
 * denial, and counted with the policy denials.
 */
export async function assertTenantCapability(capability: DemoRefusedCapability, tx?: Tx): Promise<void> {
  if (!(await isDemoTenant(tx))) return;
  const ctx = requireTenant();
  await audit.record(
    { kind: ctx.actor.kind, id: ctx.actor.id },
    `demo.${capability}`,
    { type: 'tenant', id: ctx.tenantId },
    { allowed: false, reason: 'demo_simulated' },
  );
  count(METRIC.policyDenials, 1, { reason: 'demo_simulated', action: `demo.${capability}` });
  throw new DemoRefusedError('demo_simulated', DEMO_MESSAGES[capability]);
}

const NO_EGRESS = 'A demo workspace never contacts an outside service: this request was not sent.';

/**
 * The egress guard (architecture §4.4), the last line of defence at the choke points every outbound call passes: a
 * demo company gets DemoRefusedError('demo_no_egress') before any socket opens. Fail-closed: a tenant whose kind
 * cannot be read (unknown id, database unavailable) is refused too, never treated as live.
 */
export async function assertEgressAllowed(
  tenantId: string,
  correlationId: string = currentTenant()?.correlationId ?? 'egress-guard',
): Promise<void> {
  if ((await tenantKinds.of(tenantId, correlationId)) === 'demo') {
    count(METRIC.policyDenials, 1, { reason: 'demo_no_egress', action: 'egress' });
    throw new DemoRefusedError('demo_no_egress', NO_EGRESS);
  }
}

/**
 * The egress guard for calls that carry no tenant id of their own (the model gateway, Google Fonts): the current
 * tenant context decides. Without one the call is a platform call (a deploy-time evaluation, a startup probe), not a
 * demo's.
 */
export async function assertCurrentTenantEgress(): Promise<void> {
  const ctx = currentTenant();
  if (ctx) await assertEgressAllowed(ctx.tenantId, ctx.correlationId);
}
