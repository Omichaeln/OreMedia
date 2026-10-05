import { useMemo, useState, type FormEvent, type HTMLAttributes, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FrozenManifestV1, ReviewDecisionKind } from '@oremedia/contracts/review';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Skeleton,
  StatusBanner,
  StatusDot,
  Textarea,
  cn,
  toneGlyph,
  type Tone,
} from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { useToast } from '../../components/toast';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { useTRPC } from '../../lib/trpc';
import type { ChannelDto } from '../publishing/use-publishing';
import { destinationLabel, type DestinationDto } from '../destinations/use-destinations';
import { ArticlePreview } from '../content/article-preview';
import { useRevision } from '../content/use-content';
import { mediaClock } from '../assets/media';
import { VideoPlayer } from '../assets/media-player';
import {
  ATTENTION_CHIP,
  DECISION_LABEL,
  commentOutdated,
  invalidatedReasonText,
  manifestChangeText,
  manifestChannels,
  requestHeadline,
  reviewLinkUrl,
  reviewerRows,
  shortDate,
  shortHash,
  staleReasonText,
  timingText,
  websiteStatement,
} from './review-attention';
import {
  isMemberView,
  useManifestMedia,
  useReviewRequest,
  type ExternalLinkCreatedDto,
  type ManifestMediaItemDto,
  type MemberReviewRequestDto,
} from './use-review';

const when = (iso: string) => new Date(iso).toLocaleString();

/** Where reviewer links open: the portal origin (spec 21.1) or, without one configured, this app's portal route. */
export const portalBase = (): string =>
  (import.meta.env['VITE_REVIEW_PORTAL_URL'] as string | undefined) ??
  `${window.location.origin}/review-portal`;

/** A frozen target's id: a manifest written before destinations existed names a channel. */
const targetId = (t: { channelConnectionId?: string; destinationId?: string }) =>
  t.destinationId ?? t.channelConnectionId ?? '';

/** A state as the interface sets it in a pill: a dot, the glyph for assistive technology, the label. */
export function StatePill({
  tone,
  label,
  className,
  ...props
}: { tone: Tone; label: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2.5 py-1 text-sm',
        className,
      )}
      {...props}
    >
      <StatusDot tone={tone} size="sm" />
      <span className="sr-only">{toneGlyph[tone]} </span>
      {label}
    </span>
  );
}

/** The interface's change-note banner: a tinted box, the lead in bold, then what it means. */
function Note({
  tone,
  title,
  children,
  ...props
}: { tone: Tone; title: string; children?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn(
        'om-in rounded-lg px-3.5 py-2.5 text-sm text-pretty',
        tone === 'critical'
          ? 'bg-status-critical-tint'
          : tone === 'warning'
            ? 'bg-status-warning-tint'
            : 'bg-accent-tint',
      )}
      {...props}
    >
      <span className="sr-only">{toneGlyph[tone]} </span>
      <span className="font-bold">{title}</span>
      {children && <> {children}</>}
    </div>
  );
}

/** The manifest's identity, as the interface sets it beside FROZEN MANIFEST: hash · brand version · policy. */
export function ManifestMeta({ manifest, manifestHash }: { manifest: FrozenManifestV1; manifestHash: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1 text-xs tabular-nums text-muted-foreground">
      <code
        data-testid="manifest-hash"
        title={manifestHash}
        className="inline-block max-w-[14ch] truncate align-bottom"
      >
        {manifestHash}
      </code>
      <span>
        · brand <code>{manifest.brandVersionId}</code> · policy <code>{manifest.policyVersionId}</code>
      </span>
    </span>
  );
}

/**
 * One frozen rendered file as the reviewer sees it (spec 13.3): delivered only when its stored bytes still carry
 * the frozen hash; one that does not is shown as unverifiable, never as approved media.
 */
function MediaThumb({
  item,
  alt,
  label,
  locale,
  portal,
}: {
  item: ManifestMediaItemDto;
  alt: string;
  label: string;
  locale?: string | undefined;
  portal: boolean;
}) {
  const size = item.width && item.height ? `${item.width}×${item.height}` : null;
  return (
    <figure
      className="flex flex-col gap-1"
      data-testid="manifest-media-item"
      data-verified={item.verified ? 'true' : 'false'}
    >
      {item.verified && item.url && item.mime?.startsWith('image/') ? (
        <img
          src={item.url}
          alt={alt}
          width={item.width ?? undefined}
          height={item.height ?? undefined}
          className={cn(
            'h-auto w-full bg-muted object-contain',
            portal ? 'max-h-[420px] rounded-lg' : 'max-h-[220px] rounded-md',
          )}
        />
      ) : item.verified && item.url && item.mime?.startsWith('video/') ? (
        // STU-2a: the exact frozen video export plays inline, with its poster frame and captions sidecar.
        <VideoPlayer
          src={item.url}
          poster={item.posterUrl}
          captions={item.captionsUrl}
          captionsLang={locale ?? null}
          label={`Rendered video for ${label}${alt ? `: ${alt}` : ''}`}
          width={item.width}
          height={item.height}
        />
      ) : item.verified && item.url ? (
        <a href={item.url} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-2">
          Open file ({item.mime ?? 'unknown type'})
        </a>
      ) : (
        <Badge tone="critical" data-testid="media-unverified">
          Could not verify this file against the manifest
        </Badge>
      )}
      <figcaption className="text-2xs tabular-nums text-muted-foreground">
        {size ?? 'rendered file'}
        {item.durationMs ? ` · ${mediaClock(item.durationMs)}` : ''}
        {item.fps ? ` · ${item.fps} fps` : ''}
        {item.channelConnectionIds.length > 1 ? ` · also ${label}` : ''}
      </figcaption>
    </figure>
  );
}

/** The interface's hatched placeholder where a variant has no rendered file (or it has not loaded yet). */
function Placeholder({ text, portal }: { text: string; portal: boolean }) {
  return (
    <div
      className={cn(
        'om-stripes flex items-end',
        portal ? 'aspect-[4/5] max-h-[420px] rounded-lg p-2.5' : 'aspect-[4/5] max-h-[220px] rounded-md p-2',
      )}
    >
      <span className="text-2xs tabular-nums text-muted-foreground">{text}</span>
    </div>
  );
}

/**
 * RA-09: the article preview rendered from the frozen document (never the live revision), with the frozen
 * images signed through the request-bound media endpoint, and what approving means for each website target.
 */
function FrozenArticle({
  reviewRequestId,
  manifest,
}: {
  reviewRequestId: string | undefined;
  manifest: FrozenManifestV1;
}) {
  const media = useManifestMedia(reviewRequestId ?? null);
  const document = manifest.article?.document;
  const images = media.data?.images;
  const urls = useMemo(() => {
    const map = new Map<string, string>();
    for (const image of images ?? [])
      if (image.verified && image.url) map.set(image.assetVersionId, image.url);
    return map;
  }, [images]);

  const unverified = (media.data?.images ?? []).filter((i) => !i.verified).length;
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4" data-testid="frozen-article">
      {manifest.article && (
        <p className="text-xs tabular-nums text-muted-foreground" data-testid="manifest-article">
          Article <span className="text-foreground">{manifest.article.title}</span>{' '}
          <code>/{manifest.article.slug}</code> · {manifest.article.blocks} block
          {manifest.article.blocks === 1 ? '' : 's'} · article hash{' '}
          <code>{shortHash(manifest.article.articleHash)}</code>
        </p>
      )}
      {(manifest.websites ?? []).map((site) => (
        <StatusBanner
          key={site.destinationId}
          tone={site.publishMode === 'publish' ? 'warning' : 'info'}
          title={site.publishMode === 'publish' ? 'Approval publishes live' : 'Approval saves a draft'}
          description={websiteStatement(site, manifest.timing)}
          data-testid="website-intent"
          data-publish-mode={site.publishMode}
        />
      ))}
      {document ? (
        <>
          <p className="text-xs text-muted-foreground">
            Rendered from the frozen document by the same renderer the website receives
            {manifest.article?.renderedHtmlHash
              ? `; rendered hash ${shortHash(manifest.article.renderedHtmlHash)}`
              : ''}
            .
          </p>
          {unverified > 0 && (
            <Badge tone="critical" data-testid="article-image-unverified">
              {unverified} image{unverified === 1 ? '' : 's'} could not be verified against the manifest
            </Badge>
          )}
          <ArticlePreview
            article={document}
            imageUrls={urls}
            featuredUrl={
              document.featuredImage ? (urls.get(document.featuredImage.assetVersionId) ?? null) : null
            }
            label="Frozen article preview"
          />
        </>
      ) : (
        manifest.article && (
          <p className="text-xs text-muted-foreground">
            This request was frozen before previews were kept; the article hash above is what was approved.
          </p>
        )
      )}
    </div>
  );
}

/**
 * Spec 13.3: exactly what the reviewer sees, one row per frozen variant as the interface lays it out: the
 * rendered file (or a hatched placeholder), the channel, the caption, the alt text and the hashes the decision
 * binds. Shared by the inbox detail and the external portal (`portal` stacks each variant full width).
 */
export function ManifestSummary({
  manifest,
  channels,
  destinations,
  reviewRequestId,
  locale,
  portal = false,
}: {
  manifest: FrozenManifestV1;
  channels?: ReadonlyMap<string, ChannelDto>;
  /** R2-3: the brand's websites, so a destination target is named like a channel. */
  destinations?: ReadonlyMap<string, DestinationDto>;
  /** When given, the frozen files are loaded and shown (spec 13.3); the summary alone lists their counts. */
  reviewRequestId?: string;
  /** The brand's default locale, for video captions (unknown in the reviewer portal). */
  locale?: string | undefined;
  portal?: boolean;
}) {
  const media = useManifestMedia(reviewRequestId ?? null);
  const name = (id: string) => {
    const c = channels?.get(id);
    if (c) return `${c.displayName} (${c.providerKey})`;
    const d = destinations?.get(id);
    return d ? destinationLabel(d, id) : id;
  };
  // Alt texts are frozen per channel in media order (spec 14.1): the n-th export of a channel takes its n-th alt text.
  const altFor = (channelId: string, exportId: string) => {
    const caption = manifest.captions.find((c) => targetId(c) === channelId);
    const index = manifest.exports
      .filter((e) => targetId(e) === channelId)
      .findIndex((e) => e.exportId === exportId);
    return caption?.altTexts[index] ?? '';
  };
  // One file frozen for several channels is shown once, under the first channel it serves.
  const items = media.data?.items ?? [];
  const rows = manifestChannels(manifest);
  const known = new Set(rows.map((r) => r.channelConnectionId));
  const itemsOf = (channelId: string, first: boolean) =>
    items.filter((i) =>
      first
        ? (i.channelConnectionIds.find((id) => known.has(id)) ?? i.channelConnectionIds[0]) === channelId
        : i.channelConnectionIds.includes(channelId),
    );
  const orphans = items.filter((i) => !i.channelConnectionIds.some((id) => known.has(id)));
  const binds = (settingsHash: string, exportHashes: string[]) =>
    `text ${shortHash(manifest.contentHash, 8)} · ${
      exportHashes.length === 0
        ? 'no export'
        : `export ${exportHashes.map((h) => shortHash(h, 8)).join(', ')}`
    } · settings ${shortHash(settingsHash, 8)} bound`;

  return (
    <div className={cn('flex flex-col', portal ? 'gap-7' : 'gap-1')} data-testid="manifest">
      <p className={cn('text-xs tabular-nums text-muted-foreground', portal && 'sr-only')}>
        Revision <code>{manifest.contentRevisionId}</code> · content{' '}
        <code>{shortHash(manifest.contentHash)}</code> ·{' '}
        {manifest.creativeRevisionIds.length
          ? `creative ${manifest.creativeRevisionIds.join(', ')}`
          : 'no creative documents'}{' '}
        · {timingText(manifest.timing)}
      </p>
      {media.isError && (
        <RequestError error={media.error} title="The rendered files could not be loaded" className="my-2" />
      )}
      <ul
        className={cn('flex flex-col', portal && 'gap-7')}
        aria-label="Channel variants in this manifest"
        data-testid="manifest-media"
      >
        {rows.map((c) => {
          const own = itemsOf(c.channelConnectionId, true);
          const shared = itemsOf(c.channelConnectionId, false).filter((i) => !own.includes(i));
          const label = name(c.channelConnectionId);
          const cell = (
            <div className={cn('flex flex-col gap-2', portal && 'w-[min(100%,340px)]')}>
              {media.isPending && reviewRequestId ? (
                <Skeleton label={`Loading rendered files for ${label}`} lines={1} className="h-full" />
              ) : own.length > 0 ? (
                own.map((item) => (
                  <MediaThumb
                    key={item.exportId}
                    item={item}
                    alt={altFor(c.channelConnectionId, item.exportId)}
                    label={item.channelConnectionIds
                      .filter((id) => id !== c.channelConnectionId)
                      .map(name)
                      .join(', ')}
                    locale={locale}
                    portal={portal}
                  />
                ))
              ) : (
                <Placeholder
                  text={
                    shared.length > 0
                      ? `same file as ${name(shared[0]?.channelConnectionIds[0] ?? '')}`
                      : c.exportCount > 0
                        ? `${c.exportCount} rendered file${c.exportCount === 1 ? '' : 's'}`
                        : 'no rendered file'
                  }
                  portal={portal}
                />
              )}
            </div>
          );
          return (
            <li
              key={c.channelConnectionId}
              className={cn(
                'border-t border-border',
                portal
                  ? 'flex flex-col gap-3 pt-5'
                  : 'grid grid-cols-[112px_minmax(0,1fr)] gap-4 py-4 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-5',
              )}
            >
              {portal ? (
                <>
                  <span className="om-label">
                    {label}
                    {c.kind === 'destination' && manifest.article ? ' · publishes the article below' : ''}
                  </span>
                  {cell}
                  <p className="whitespace-pre-wrap text-md leading-relaxed text-pretty">{c.text}</p>
                  {c.altTexts.length > 0 && (
                    <p className="text-xs text-muted-foreground text-pretty">
                      <span className="text-2xs tabular-nums">ALT</span> {c.altTexts.join(' / ')}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {cell}
                  <div className="flex min-w-0 flex-col gap-2.5">
                    <span className="text-sm font-medium">
                      {label}
                      {c.kind === 'destination' && manifest.article ? ' · publishes the article below' : ''}
                    </span>
                    <p className="whitespace-pre-wrap text-base leading-relaxed text-pretty">{c.text}</p>
                    {c.altTexts.length > 0 && (
                      <p className="text-xs text-muted-foreground text-pretty">
                        <span className="text-2xs tabular-nums">ALT</span> {c.altTexts.join(' / ')}
                      </p>
                    )}
                    <p className="text-2xs tabular-nums text-muted-foreground">
                      {binds(c.settingsHash, c.exportHashes)}
                    </p>
                  </div>
                </>
              )}
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="border-t border-border py-2.5 text-sm text-muted-foreground">
            No channel variants were frozen.
          </li>
        )}
        {orphans.length > 0 && (
          <li
            className={cn(
              'border-t border-border',
              portal ? 'flex flex-col gap-3 pt-5' : 'grid grid-cols-[112px_minmax(0,1fr)] gap-4 py-4 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-5',
            )}
          >
            <div className={cn('flex flex-col gap-2', portal && 'w-[min(100%,340px)]')}>
              {orphans.map((item) => (
                <MediaThumb
                  key={item.exportId}
                  item={item}
                  alt=""
                  label={item.channelConnectionIds.map(name).join(', ')}
                  locale={locale}
                  portal={portal}
                />
              ))}
            </div>
            <span className="text-sm font-medium">
              Rendered files for {orphans.flatMap((i) => i.channelConnectionIds).map(name).join(', ')}
            </span>
          </li>
        )}
      </ul>
      {(manifest.article || manifest.websites) && (
        <FrozenArticle reviewRequestId={reviewRequestId} manifest={manifest} />
      )}
    </div>
  );
}

export interface RequestDetailProps {
  reviewRequestId: string | null;
  channels: ReadonlyMap<string, ChannelDto>;
  /** R2-3: the brand's websites, named beside the channels in the frozen manifest. */
  destinations?: ReadonlyMap<string, DestinationDto>;
  /** What the request is about (the package title), shown as the heading. */
  title?: ReactNode;
  /** The brand's default locale: the language of a video export's captions. */
  locale?: string;
  /** Names a member by id for the reviewers list; the id itself when the session cannot list members. */
  memberName?: (userId: string) => string;
}

/** Spec 21.2 inbox states: changes requested, stale approval, revoked external access, decided. */
export function RequestDetail({
  reviewRequestId,
  channels,
  destinations,
  title,
  locale,
  memberName = (id) => id,
}: RequestDetailProps) {
  const request = useReviewRequest(reviewRequestId);
  const member = request.data && isMemberView(request.data) ? request.data : null;
  const revision = useRevision(member?.contentRevisionId ?? null);
  const revisionNumber = revision.data?.number;
  return (
    <section
      aria-labelledby="request-detail-title"
      className="mx-auto flex w-full max-w-[820px] flex-col gap-7 px-4 py-7 sm:px-8 sm:pb-16"
      data-testid="request-detail"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-[200px] flex-1 flex-col gap-1">
          {reviewRequestId && (
            <p className="text-xs tabular-nums text-muted-foreground">
              {reviewRequestId}
              {member && (
                <>
                  {' '}
                  · revision{' '}
                  {revisionNumber ?? <code>{member.contentRevisionId}</code>} · created{' '}
                  {shortDate(member.createdAt)}
                </>
              )}
            </p>
          )}
          <h2 id="request-detail-title" className="text-xl font-bold tracking-title">
            {reviewRequestId ? (title ?? 'Review request') : 'Review request'}
          </h2>
        </div>
        {member && (
          <StatePill
            tone={requestHeadline(member).tone}
            label={requestHeadline(member).label}
            data-testid="request-state"
          />
        )}
      </div>
      {reviewRequestId === null && (
        <EmptyState
          title="Nothing selected"
          description="Open a request from the list to see its frozen manifest, decide on it or share it with an external reviewer."
        />
      )}
      {reviewRequestId !== null && request.isPending && <Skeleton label="Loading request" />}
      {reviewRequestId !== null && request.isError && (
        <RequestError error={request.error} onRetry={() => void request.refetch()} />
      )}
      {request.isSuccess && !isMemberView(request.data) && (
        <StatusBanner
          tone="warning"
          title="Reviewer view only"
          description="This session sees the frozen manifest only; decisions from here belong in the review portal."
        />
      )}
      {member && (
        <MemberDetail
          request={member}
          channels={channels}
          destinations={destinations}
          locale={locale}
          revisionNumber={revisionNumber}
          memberName={memberName}
        />
      )}
    </section>
  );
}

function MemberDetail({
  request: r,
  channels,
  destinations,
  locale,
  revisionNumber,
  memberName,
}: {
  request: MemberReviewRequestDto;
  channels: ReadonlyMap<string, ChannelDto>;
  destinations?: ReadonlyMap<string, DestinationDto>;
  locale?: string;
  revisionNumber?: number;
  memberName: (userId: string) => string;
}) {
  const validApproval = r.approvals.find((a) => a.state === 'valid');
  const invalidated = r.approvals.filter((a) => a.state === 'invalidated');
  const revokedLinks = r.externalLinks.filter((l) => l.revokedAt !== null);
  const comments = r.decisions.filter((d) => d.comment);
  const reviewers = reviewerRows(r, memberName);
  const who = (d: MemberReviewRequestDto['decisions'][number]) =>
    d.deciderKind === 'external_reviewer' ? (d.verifiedEmail ?? 'external reviewer') : memberName(d.deciderId);
  return (
    <>
      {r.state === 'stale' && (
        <Note tone="warning" title="Stale: the package changed after this request was frozen.">
          What changed: {staleReasonText(r.staleReason)}. Reviewers are told the same. Ask for a new review
          request on the current package; this one cannot be decided.
        </Note>
      )}
      {r.changedSinceFreeze.length > 0 && (
        <Note
          tone="warning"
          title={validApproval ? 'Changed since approval.' : 'Changed since this request was frozen.'}
          data-testid="changed-since-freeze"
        >
          What changed: {manifestChangeText(r.changedSinceFreeze)}.{' '}
          {validApproval
            ? 'The approval no longer matches what would publish; dispatch holds the publication and a new review is needed.'
            : 'A decision on this request will be refused; ask for a new review on the current package.'}
        </Note>
      )}
      {r.state === 'decided' && r.revisionState === 'changes_requested' && (
        <Note tone="info" title={`${ATTENTION_CHIP.changes_requested.label}.`}>
          {ATTENTION_CHIP.changes_requested.detail}
        </Note>
      )}
      {invalidated.map((a) => (
        <Note key={a.id} tone="critical" title="Approval invalidated.">
          Approval {a.id} no longer releases anything because {invalidatedReasonText(a.invalidatedReason)}. A
          new review is needed.
        </Note>
      ))}
      {revokedLinks.length > 0 && (
        <Note tone="info" title={`${ATTENTION_CHIP.external_access_revoked.label}.`}>
          {revokedLinks.length} external reviewer link{revokedLinks.length === 1 ? '' : 's'} revoked (
          {revokedLinks.map((l) => l.email).join(', ')}). Revocation takes effect on the reviewer's next request.
        </Note>
      )}

      <Section
        id={`manifest-${r.id}`}
        title="Frozen manifest"
        level={3}
        action={<ManifestMeta manifest={r.frozenManifest} manifestHash={r.manifestHash} />}
      >
        <ManifestSummary
          manifest={r.frozenManifest}
          channels={channels}
          destinations={destinations}
          reviewRequestId={r.id}
          locale={locale}
        />
      </Section>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-7">
        <Section id={`reviewers-${r.id}`} title="Reviewers" level={3}>
          {reviewers.length === 0 ? (
            <p className="py-2.5 text-sm text-muted-foreground">No reviewers assigned.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" aria-label="Reviewers" data-testid="reviewers">
              {reviewers.map((p) => (
                <li key={p.key} className="flex justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0 truncate">
                    {p.who} <span className="text-muted-foreground">{p.kind}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">{p.decision}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <ExternalLinks request={r} />
      </div>

      <Section id={`comments-${r.id}`} title="Comments" level={3}>
        {comments.length === 0 ? (
          <p className="py-2.5 text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" aria-label="Comments" data-testid="decisions">
            {comments.map((d) => (
              <li key={d.id} className="flex flex-col gap-1 py-2.5 text-sm">
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{who(d)}</span>
                  {DECISION_LABEL[d.decision]} · {shortDate(d.createdAt)}
                  {commentOutdated(d, r) && (
                    <span
                      className="rounded-sm bg-secondary px-1.5 py-px text-2xs tabular-nums"
                      title="Made on a manifest that is no longer the one that would publish"
                    >
                      OUTDATED
                    </span>
                  )}
                </span>
                <p className="whitespace-pre-wrap">{d.comment}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {r.state === 'open' && (
        <DecisionForm reviewRequestId={r.id} manifestHash={r.manifestHash} revisionNumber={revisionNumber} />
      )}
      {r.state === 'decided' && validApproval && (
        <p className="om-in flex items-start gap-2.5 border-t border-border pt-3 text-sm text-muted-foreground">
          <StatusDot tone="good" size="sm" className="mt-1.5" />
          <span className="sr-only">{toneGlyph.good} </span>
          <span>
            Approved and bound · Approval {validApproval.id} binds this exact package
            {validApproval.validUntil ? ` until ${when(validApproval.validUntil)}` : ''}. Dispatch recomputes
            the binding and holds the publication if anything changed.
          </span>
        </p>
      )}
    </>
  );
}

/**
 * Spec 13.2: the decision names the manifest hash it was made on; a mismatch is refused and shown. One note, two
 * actions, as the interface sets it: "Approve revision N" binds the manifest, "Request changes" needs the note.
 */
export function DecisionForm({
  reviewRequestId,
  manifestHash,
  revisionNumber,
  onDecided,
  variant = 'card',
  placeholder = 'Note (required when requesting changes)',
}: {
  reviewRequestId: string;
  manifestHash: string;
  revisionNumber?: number | undefined;
  onDecided?: (decision: ReviewDecisionKind) => void;
  /** `card`: the inbox's "Your decision" card; `portal`: the reviewer portal's bare form. */
  variant?: 'card' | 'portal';
  placeholder?: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ReviewDecisionKind | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const intent = useIntentKey();
  const submit = useMutation(
    trpc.review.decisions.submit.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (_res, input) => {
        intent.renew();
        setError(null);
        void queryClient.invalidateQueries(trpc.review.pathFilter());
        onDecided?.(input.decision);
      },
      onError: (err) => setError(toUiError(err).message),
      onSettled: () => setPending(null),
    }),
  );
  const decide = (decision: ReviewDecisionKind) => {
    if (decision !== 'approve' && !comment.trim()) {
      setError('Say what should change.');
      return;
    }
    setError(null);
    setPending(decision);
    submit.mutate({
      reviewRequestId,
      decision,
      comment: comment.trim() || undefined,
      expectedManifestHash: manifestHash,
    });
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    decide('approve');
  };
  const noteId = `note-${reviewRequestId}`;
  const errorId = `${noteId}-error`;
  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        'flex flex-col gap-2',
        variant === 'card' ? 'rounded-xl border border-border bg-card p-4' : 'border-t border-border pt-5',
      )}
      noValidate
      data-testid="decision-form"
    >
      {variant === 'card' && (
        <>
          <p className="text-base font-bold">Your decision</p>
          <p className="text-xs text-muted-foreground">
            Approving binds this exact manifest (<code>{shortHash(manifestHash)}</code>). Any later change to
            caption, export, channel or timing invalidates it; if the package changed since, the decision is
            refused and the request goes stale.
          </p>
        </>
      )}
      <Textarea
        id={noteId}
        aria-label={variant === 'card' ? 'Note' : 'Comments'}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        placeholder={placeholder}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={4000}
        className={cn('bg-background', variant === 'portal' ? 'min-h-[90px] text-base' : 'min-h-16')}
      />
      {error && (
        <p id={errorId} role="alert" className="text-xs text-status-critical">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={submit.isPending}>
          {pending === 'approve'
            ? 'Recording…'
            : revisionNumber !== undefined
              ? `Approve revision ${revisionNumber}`
              : 'Approve'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => decide('request_changes')} disabled={submit.isPending}>
          {pending === 'request_changes' ? 'Recording…' : 'Request changes'}
        </Button>
      </div>
    </form>
  );
}

const defaultExpiry = () => {
  const d = new Date(Date.now() + 7 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Spec 5.6: expiring, revocable links; the token is shown once, here, and never again. */
function ExternalLinks({ request: r }: { request: MemberReviewRequestDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [expires, setExpires] = useState(defaultExpiry);
  const [created, setCreated] = useState<ExternalLinkCreatedDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => void queryClient.invalidateQueries(trpc.review.pathFilter());
  const createIntent = useIntentKey();
  const create = useMutation(
    trpc.review.externalLinks.create.mutationOptions({
      ...mutationIntent(createIntent.key),
      onSuccess: (res) => {
        createIntent.renew();
        setError(null);
        setCreated(res);
        setCopied(false);
        setEmail('');
        setOpen(false);
        invalidate();
      },
      onError: (err) => setError(toUiError(err).message),
    }),
  );
  const revokeIntent = useIntentKey();
  const revoke = useMutation(
    trpc.review.externalLinks.revoke.mutationOptions({
      ...mutationIntent(revokeIntent.key),
      onSuccess: () => {
        revokeIntent.renew();
        invalidate();
        toast({
          tone: 'good',
          title: 'Link revoked',
          description: 'It stops working on the reviewer’s next request.',
        });
      },
      onError: (err) =>
        toast({ tone: 'critical', title: 'Revoke failed', description: toUiError(err).message }),
    }),
  );
  const link = created ? reviewLinkUrl(portalBase(), r.id, created.token, created.expiresAt) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
      toast({
        tone: 'warning',
        title: 'Copy blocked',
        description: 'Select the link text and copy it by hand.',
      });
    }
  };
  const formId = `link-form-${r.id}`;
  return (
    <Section
      id={`links-${r.id}`}
      title="External links"
      level={3}
      action={
        r.state === 'open' && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={formId}
            onClick={() => setOpen((o) => !o)}
            className="hover:text-foreground"
          >
            {open ? 'Close' : '+ New link'}
          </button>
        )
      }
    >
      {created && (
        <StatusBanner
          tone="info"
          title="Link created: copy it now, it is shown only once"
          data-testid="link-once"
          description={
            <div className="flex flex-col gap-2">
              <span>
                For {r.externalLinks.find((l) => l.id === created.linkId)?.email ?? 'the reviewer'}, valid
                until {when(created.expiresAt)}. The token is not stored in a readable form anywhere; closing
                this notice loses it.
              </span>
              <Input
                readOnly
                value={link}
                aria-label="Review link"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="link-url"
              />
              <span className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
                <Button size="sm" variant="secondary" asChild>
                  <a href={link} target="_blank" rel="noreferrer">
                    Preview
                  </a>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                  I have shared it
                </Button>
              </span>
            </div>
          }
        />
      )}
      {r.externalLinks.length === 0 ? (
        <p className="py-2.5 text-sm text-muted-foreground">No external reviewers.</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-border"
          aria-label="External reviewer links"
          data-testid="external-links"
        >
          {r.externalLinks.map((l) => {
            const expired = new Date(l.expiresAt).getTime() < Date.now();
            const state = l.revokedAt
              ? `Revoked ${shortDate(l.revokedAt)}`
              : expired
                ? `Expired ${shortDate(l.expiresAt)}`
                : `Active · expires ${shortDate(l.expiresAt)}`;
            return (
              <li
                key={l.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-sm"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">{l.email}</span>
                  <span
                    className={cn(
                      'text-xs',
                      l.revokedAt || expired ? 'text-status-critical' : 'text-muted-foreground',
                    )}
                  >
                    {state}
                    {l.emailVerifiedAt && ` · verified ${shortDate(l.emailVerifiedAt)}`}
                    {l.lastUsedAt && ` · last used ${shortDate(l.lastUsedAt)}`}
                  </span>
                </span>
                <span className="flex gap-2 text-xs">
                  {created?.linkId === l.id && (
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Preview
                    </a>
                  )}
                  {!l.revokedAt && (
                    <button
                      type="button"
                      className="text-status-critical hover:opacity-60 disabled:opacity-60"
                      onClick={() => revoke.mutate({ linkId: l.id })}
                      disabled={revoke.isPending}
                      aria-label={`Revoke link for ${l.email}`}
                    >
                      Revoke
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {r.state === 'open' && open && (
        <form
          id={formId}
          className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const d = new Date(expires);
            if (!email.trim() || Number.isNaN(d.getTime())) {
              setError('An email address and an expiry are required.');
              return;
            }
            create.mutate({ reviewRequestId: r.id, email: email.trim(), expiresAt: d.toISOString() });
          }}
        >
          <Field
            label="Reviewer email"
            htmlFor={`link-email-${r.id}`}
            className="flex-1"
            error={error ?? undefined}
          >
            <Input
              id={`link-email-${r.id}`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field label="Expires" htmlFor={`link-expires-${r.id}`}>
            <Input
              id={`link-expires-${r.id}`}
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create link'}
          </Button>
        </form>
      )}
    </Section>
  );
}
