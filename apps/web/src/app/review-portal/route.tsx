import { useMemo, useState } from 'react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Button, Skeleton, StatusBanner } from '@oremedia/ui';
import { ToastProvider } from '../../components/toast';
import {
  DecisionForm,
  ManifestMeta,
  ManifestSummary,
  StatePill,
} from '../../features/review/request-detail';
import {
  ATTENTION_CHIP,
  REQUEST_STATE_CHIP,
  parsePortalFragment,
  shortDate,
  staleReasonText,
  type PortalLink,
} from '../../features/review/review-attention';
import { toUiError } from '../../lib/errors';
import { createQueryClient } from '../../lib/query-client';
import { TRPCProvider, createClient, createOptionsProxy, keyPrefixFor, useTRPC } from '../../lib/trpc';
import { DeploymentLogo } from '../../components/deployment-logo';
import { useDeploymentBrand } from '../../lib/deployment-brand';
import { useTheme } from '../../lib/theme';

/**
 * External reviewer surface (spec 5.6, 21.1), in the supplied interface's portal form: a wordmark header with the
 * link's expiry, the request, each frozen variant full width, then the decision. A separate build target on its
 * own origin; the `rl_…` token arrives in the URL fragment, is read once into memory and removed from the address
 * bar. It is never written to sessionStorage, localStorage or a cookie, and every request carries it as
 * `Bearer rl_…` through a client made here, not the app's. The reviewer sees only the frozen manifest of their
 * one request and decides once.
 */
let linkOnce: PortalLink | null | undefined;
/** Reads the fragment exactly once per page load and removes it from the address bar and history entry. */
function readLinkOnce(): PortalLink | null {
  if (linkOnce !== undefined) return linkOnce;
  linkOnce = parsePortalFragment(window.location.hash);
  if (linkOnce) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return linkOnce;
}

export function ReviewPortalRoute({ standalone = false }: { standalone?: boolean }) {
  useTheme();
  const brand = useDeploymentBrand();
  const [link] = useState<PortalLink | null>(readLinkOnce);
  const runtime = useMemo(() => {
    const queryClient = createQueryClient();
    const client = createClient({ bearerToken: () => link?.token ?? null, pathname: () => '/review-portal' });
    return { queryClient, client, trpc: createOptionsProxy(client, queryClient, null) };
  }, [link]);

  return (
    <QueryClientProvider client={runtime.queryClient}>
      <TRPCProvider
        trpcClient={runtime.client}
        queryClient={runtime.queryClient}
        keyPrefix={keyPrefixFor(null)}
      >
        <ToastProvider>
          <div className="om-fade min-h-full bg-card">
            <a href="#main" className="skip-link">
              Skip to content
            </a>
            <header className="flex h-14 items-center justify-between gap-3 border-b border-border px-4 sm:px-8">
              <span className="flex min-w-0 items-center gap-3 text-sm font-bold uppercase tracking-wide-label">
                <DeploymentLogo className="h-7" />
                <span className="truncate">{brand.name}</span>
              </span>
              {link?.expiresAt && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Link expires {new Date(link.expiresAt).toLocaleString()}
                </span>
              )}
            </header>
            <main
              id="main"
              className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-4 py-8 sm:px-8 sm:pb-20 sm:pt-10"
            >
              {!link ? (
                <>
                  <h1 className="text-2xl font-bold tracking-title">Your review</h1>
                  <StatusBanner
                    tone="warning"
                    title="This link is incomplete"
                    description={
                      standalone
                        ? 'Open the review link exactly as it was sent to you; the part after # identifies your request. If it was cut off, ask the sender for the link again.'
                        : 'This route is served from the review portal origin in production. Open a review link exactly as it was sent.'
                    }
                  />
                </>
              ) : (
                <Portal link={link} teamName={brand.name} />
              )}
            </main>
          </div>
        </ToastProvider>
      </TRPCProvider>
    </QueryClientProvider>
  );
}

type Outcome = { kind: 'approve' | 'request_changes' };

/** The token is bound to one request server-side; the policy refuses any other id, so the link names its own. */
function useReviewerRequest(reviewRequestId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.review.requests.get.queryOptions({ reviewRequestId }), enabled, retry: false });
}

function Portal({ link, teamName }: { link: PortalLink; teamName: string }) {
  const expiredByClock = link.expiresAt !== null && new Date(link.expiresAt).getTime() < Date.now();
  const request = useReviewerRequest(link.reviewRequestId, !expiredByClock);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (expiredByClock)
    return (
      <>
        <h1 className="text-2xl font-bold tracking-title">Your review</h1>
        <Expired expiresAt={link.expiresAt} />
      </>
    );
  if (request.isPending)
    return (
      <>
        <h1 className="text-2xl font-bold tracking-title">Your review</h1>
        <Skeleton label="Loading your review" />
      </>
    );
  if (request.isError) {
    const ui = toUiError(request.error);
    const banner =
      ui.kind === 'forbidden' ? (
        // The server says only that the link no longer grants access; whether it expired or was revoked is known
        // here only when the link carried its expiry, so the text claims no more than that.
        link.expiresAt ? (
          <StatusBanner
            tone="critical"
            title="This link has been revoked"
            data-testid="portal-revoked"
            description="The brand team withdrew this reviewer link, so it no longer opens the request. If you still need to review, ask them for a new link."
          />
        ) : (
          <StatusBanner
            tone="critical"
            title="This link is no longer valid"
            data-testid="portal-invalid"
            description="It has expired or was revoked by the brand team. If you still need to review, ask them for a new link."
          />
        )
      ) : ui.kind === 'sign_in' || ui.kind === 'not_found' ? (
        <StatusBanner
          tone="critical"
          title="This link is not recognised"
          description="The token in this link does not match any reviewer link, or the request it names does not exist. Check that the whole link was copied."
        />
      ) : (
        <StatusBanner
          tone="critical"
          title="The review could not be loaded"
          description={ui.message}
          actions={
            <Button size="sm" onClick={() => void request.refetch()}>
              Try again
            </Button>
          }
        />
      );
    return (
      <>
        <h1 className="text-2xl font-bold tracking-title">Your review</h1>
        {banner}
      </>
    );
  }
  const r = request.data;
  const state = r.state === 'open' ? ATTENTION_CHIP.awaiting_decision : REQUEST_STATE_CHIP[r.state];
  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">You were asked to review</p>
        <h1 className="text-2xl font-bold tracking-title">{r.frozenManifest.article?.title ?? 'Your review'}</h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <StatePill tone={state.tone} label={state.label} data-testid="portal-state" />
          <span>
            Revision <code>{r.frozenManifest.contentRevisionId}</code>
            {r.dueAt && ` · due ${shortDate(r.dueAt)}`} · what you see is exactly what will publish
          </span>
        </p>
        <ManifestMeta manifest={r.frozenManifest} manifestHash={r.manifestHash} />
      </div>
      {outcome && (
        <StatusBanner
          tone="good"
          title={outcome.kind === 'approve' ? 'Thank you: approved' : 'Thank you: changes requested'}
          data-testid="portal-success"
          description="Your decision is recorded against exactly this manifest, with your verified email. This link cannot be used to decide again."
        />
      )}
      {!outcome && r.state === 'decided' && (
        <StatusBanner
          tone="info"
          title="This request has already been decided"
          data-testid="portal-decided"
          description="A decision was already recorded for this request, so nothing more can be done from this link. The frozen manifest is shown below for reference."
        />
      )}
      {r.state === 'stale' && (
        <StatusBanner
          tone="warning"
          title="This request is stale"
          data-testid="portal-stale"
          description={`The package changed after this manifest was frozen (${staleReasonText(r.staleReason)}), so it can no longer be decided. The brand team will send a new request for the current package.`}
        />
      )}
      {r.state === 'cancelled' && (
        <StatusBanner
          tone="neutral"
          title="This request was withdrawn"
          description="The brand team cancelled it; there is nothing to decide."
        />
      )}
      <ManifestSummary manifest={r.frozenManifest} reviewRequestId={r.id} portal />
      {!outcome && r.state === 'open' && (
        <DecisionForm
          reviewRequestId={r.id}
          manifestHash={r.manifestHash}
          variant="portal"
          placeholder={`Comments for the ${teamName} team`}
          onDecided={(decision) => {
            setOutcome({ kind: decision === 'approve' ? 'approve' : 'request_changes' });
            void request.refetch();
          }}
        />
      )}
      <p className="text-xs text-muted-foreground">
        {!outcome && r.state === 'open'
          ? 'You can decide once; your email address is verified by this link and recorded with the decision. '
          : ''}
        You can only see this request. The link stops working if it’s revoked or expires.
      </p>
    </>
  );
}

function Expired({ expiresAt }: { expiresAt: string | null }) {
  return (
    <StatusBanner
      tone="warning"
      title="This link has expired"
      data-testid="portal-expired"
      description={`It stopped working on ${expiresAt ? new Date(expiresAt).toLocaleString() : 'its expiry date'}. Ask the brand team for a new link if the review is still needed.`}
    />
  );
}
