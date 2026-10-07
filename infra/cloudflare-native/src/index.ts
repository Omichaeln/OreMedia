import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ASSET_BUCKET: R2Bucket;
  EVENTS: Queue<FoundationEvent>;
  FOUNDATION_WORKFLOW: Workflow<FoundationWorkflowPayload>;
  OREMEDIA_DEPLOYMENT: string;
  OREMEDIA_CF_COMMIT: string;
}

type FoundationEvent = {
  kind: 'foundation-probe';
  requestId: string;
  createdAt: string;
};

type FoundationWorkflowPayload = {
  requestId: string;
};

type Capability = 'available' | 'not_migrated' | 'external_dependency';

const capabilities: Record<string, { status: Capability; note: string }> = {
  static_web: { status: 'available', note: 'Current Vite web bundle is served by Worker static assets.' },
  worker_routing: { status: 'available', note: 'Cloudflare Worker routing and observability are enabled.' },
  d1_foundation: { status: 'available', note: 'Isolated D1 database is used only for foundation probes.' },
  r2_foundation: { status: 'available', note: 'Isolated R2 bucket binding is available for object probes.' },
  queues_foundation: { status: 'available', note: 'Isolated Queue producer and consumer are configured.' },
  workflows_foundation: {
    status: 'available',
    note: 'Cloudflare Workflow binding is configured for a probe workflow.',
  },
  ore_media_api: {
    status: 'not_migrated',
    note: 'The production API is not replaced by this foundation Worker.',
  },
  temporal_workflows: {
    status: 'not_migrated',
    note: 'OreMedia Temporal workflows require a deliberate Workflows port.',
  },
  mysql_domain_model: {
    status: 'external_dependency',
    note: 'The current 116-table MySQL domain model remains outside this foundation.',
  },
  media_renderer: {
    status: 'not_migrated',
    note: 'Chromium/FFmpeg rendering remains on the existing worker-render service.',
  },
  malware_scanning: {
    status: 'not_migrated',
    note: 'ClamAV scanning remains on the existing media pipeline.',
  },
};

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      ...(init?.headers ?? {}),
    },
  });
}

function requestId(request: Request): string {
  return request.headers.get('cf-ray') ?? crypto.randomUUID();
}

async function foundationProbe(env: Env, request: Request): Promise<Response> {
  const id = requestId(request);
  const now = new Date().toISOString();
  let stage = 'd1';
  try {
    await env.DB.prepare(
      'INSERT INTO foundation_probe_events (request_id, kind, created_at) VALUES (?, ?, ?)',
    )
      .bind(id, 'request', now)
      .run();

    stage = 'queue';
    const body: FoundationEvent = { kind: 'foundation-probe', requestId: id, createdAt: now };
    await env.EVENTS.send(body);

    stage = 'workflow';
    const instance = await env.FOUNDATION_WORKFLOW.create({ params: { requestId: id } });

    return json(
      {
        ok: true,
        requestId: id,
        workflowId: instance.id,
        r2Binding: Boolean(env.ASSET_BUCKET),
        queueBinding: Boolean(env.EVENTS),
        databaseBinding: Boolean(env.DB),
        deployment: env.OREMEDIA_DEPLOYMENT,
        commit: env.OREMEDIA_CF_COMMIT,
      },
      { status: 202 },
    );
  } catch (error) {
    return json(
      {
        ok: false,
        code: 'FOUNDATION_PROBE_FAILED',
        stage,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export class OreMediaFoundationWorkflow extends WorkflowEntrypoint<Env> {
  override async run(
    event: WorkflowEvent<FoundationWorkflowPayload>,
    step: WorkflowStep,
  ): Promise<{ requestId: string; status: 'completed' }> {
    await step.do('record-workflow-start', async () => {
      await this.env.DB.prepare(
        'INSERT INTO foundation_probe_events (request_id, kind, created_at) VALUES (?, ?, ?)',
      )
        .bind(event.payload.requestId, 'workflow-start', new Date().toISOString())
        .run();
    });

    await step.sleep('durable-boundary', '1 second');

    await step.do('record-workflow-complete', async () => {
      await this.env.DB.prepare(
        'INSERT INTO foundation_probe_events (request_id, kind, created_at) VALUES (?, ?, ?)',
      )
        .bind(event.payload.requestId, 'workflow-complete', new Date().toISOString())
        .run();
    });

    return { requestId: event.payload.requestId, status: 'completed' };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'oremedia-cf-native', deployment: env.OREMEDIA_DEPLOYMENT });
    }

    if (url.pathname === '/cf-capabilities') {
      return json({
        ok: true,
        status: 'foundation-only',
        accountBoundary: 'oreandtar',
        capabilities,
      });
    }

    if (url.pathname === '/cf-foundation/probe' && request.method === 'POST') {
      return foundationProbe(env, request);
    }

    if (
      url.pathname.startsWith('/trpc/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/v1/') ||
      url.pathname === '/mcp' ||
      url.pathname.startsWith('/mcp/')
    ) {
      return json(
        {
          ok: false,
          code: 'NOT_MIGRATED',
          message:
            'This route is intentionally fail-closed: the full OreMedia API has not been replaced by the Cloudflare foundation Worker.',
          path: url.pathname,
        },
        { status: 503 },
      );
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<FoundationEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await env.DB.prepare(
        'INSERT INTO foundation_probe_events (request_id, kind, created_at) VALUES (?, ?, ?)',
      )
        .bind(message.body.requestId, 'queue-consumed', new Date().toISOString())
        .run();
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, FoundationEvent>;
