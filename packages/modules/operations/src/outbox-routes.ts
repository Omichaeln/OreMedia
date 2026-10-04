import type { EventType } from '@oremedia/contracts/events';

/** One outbox row as the dispatcher sees it (platform-level: it spans tenants). */
export interface OutboxEventRecord {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  correlationId: string;
  attempts: number;
  availableAt: Date;
  createdAt: Date;
}

/** What a route asks the worker to start. The database row, not Temporal, is the dedupe authority (spec 14.2). */
export interface WorkflowStartRequest {
  workflowType: string;
  taskQueue: string;
  /** Stable per aggregate occurrence, e.g. `ingest:<uploadIntentId>`; started with USE_EXISTING conflict policy. */
  workflowId: string;
  args: unknown[];
}

/** A route turns an event into a workflow start, or `null` when the event is informational (nothing to start). */
export type OutboxRoute = (evt: OutboxEventRecord) => WorkflowStartRequest | null;

/**
 * How an event of a demo workspace (tenants.kind = 'demo') is dispatched (architecture §4.3): `'same'` when the live
 * route only does internal work that is safe in a demo (ingest, a local render, an impact check, a deletion), or a
 * route of its own (a simulated workflow). An event registered without one is suppressed for demo tenants.
 */
export type DemoOutboxRoute = OutboxRoute | 'same';

export interface OutboxRouteOptions {
  demo?: DemoOutboxRoute;
}

const routes = new Map<EventType, OutboxRoute>();
const demoRoutes = new Map<EventType, DemoOutboxRoute>();

/**
 * Modules register their own routes (composition root calls them); the dispatcher stays generic and never names a
 * module's workflow. Registering twice replaces the route (and its demo option), matching the other composition hooks.
 */
export function registerOutboxRoute(
  eventType: EventType,
  route: OutboxRoute,
  opts: OutboxRouteOptions = {},
): void {
  routes.set(eventType, route);
  if (opts.demo) demoRoutes.set(eventType, opts.demo);
  else demoRoutes.delete(eventType);
}

export function outboxRouteFor(eventType: string): OutboxRoute | undefined {
  return routes.get(eventType as EventType);
}

/**
 * The route for a demo workspace's event: the demo option, the live route when that option is `'same'`, or undefined
 * (suppress) when the event has no demo option or no route at all. Fail-closed: nothing reaches a live workflow from
 * a demo unless its registration says it may.
 */
export function demoOutboxRouteFor(eventType: string): OutboxRoute | undefined {
  const demo = demoRoutes.get(eventType as EventType);
  return demo === 'same' ? routes.get(eventType as EventType) : demo;
}

/** Resolves a tenant's kind for the dispatcher (wired by the worker's composition root to module-access). */
export type TenantKindResolver = (tenantId: string, correlationId: string) => Promise<'live' | 'demo'>;

let tenantKindResolver: TenantKindResolver | null = null;

/**
 * Architecture §4.1: the operations module does not import module-access, so the composition root wires the kind
 * resolver here, as it registers the routes. Unwired, the dispatcher refuses to dispatch in production (see
 * tenantKindForDispatch); outside production an unwired resolver reads every tenant as live.
 */
export function configureTenantKindResolver(fn: TenantKindResolver | null): void {
  tenantKindResolver = fn;
}

export const tenantKindResolverConfigured = (): boolean => tenantKindResolver !== null;

/**
 * The kind the dispatcher routes an event by. A resolver failure (unknown tenant, database down) throws, so the row is
 * retried rather than dispatched as live; an unwired resolver throws in production for the same reason.
 */
export async function tenantKindForDispatch(
  tenantId: string,
  correlationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<'live' | 'demo'> {
  if (tenantKindResolver) return tenantKindResolver(tenantId, correlationId);
  if (env['NODE_ENV'] === 'production')
    throw new Error('outbox tenant kind resolver is not configured: refusing to dispatch');
  return 'live';
}

/** Test seam. */
export function clearOutboxRoutes(): void {
  routes.clear();
  demoRoutes.clear();
}
