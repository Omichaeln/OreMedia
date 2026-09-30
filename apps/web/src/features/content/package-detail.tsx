import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Field, Input, Panel, Skeleton, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { brandPath } from '../brand/brand-context';
import { CHANNEL_CHIP } from '../publishing/publication-state';
import type { ChannelDto } from '../publishing/use-publishing';
import { packageChip, revisionChip, sameIdSet, variantFindings } from './content-helpers';
import { DocumentPicker } from './document-picker';
import { RequestReview } from './request-review';
import { VariantEditor } from './variant-editor';
import { usePackage, type PackageDocumentDto, type PackageDto, type PackageVariantDto } from './use-content';

export interface PackageDetailProps {
  companyId: string;
  brandId: string;
  contentPackageId: string;
  channels: ReadonlyMap<string, ChannelDto>;
  /** The brand's time zone: the planned publish time is entered as the brand's wall clock (UX-06). */
  timeZone: string;
}

/**
 * The creative documents the current revision publishes with, from the server (it resolves the pinned creative
 * revisions to their documents); a document whose current revision moved past the pin is marked stale.
 */
function PackageDocuments({
  companyId,
  brandId,
  documents,
}: {
  companyId: string;
  brandId: string;
  documents: readonly PackageDocumentDto[];
}) {
  if (documents.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No creative documents are pinned to this revision. Revise the package to choose some.
      </p>
    );
  return (
    <ul className="flex flex-col gap-1" aria-label="Creative documents" data-testid="studio-links">
      {documents.map((d) => (
        <li key={d.documentId} className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            to={brandPath(companyId, brandId, `studio/${encodeURIComponent(d.documentId)}`)}
            className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {d.title}
          </Link>
          <code className="text-xs text-muted-foreground">{d.pinnedRevisionId}</code>
          {d.stale && (
            <Badge tone="warning" data-testid="document-stale">
              Stale: newer revision exists
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

function VariantRow({
  companyId,
  brandId,
  variant,
  channel,
  documents,
  editable,
  schedulable,
}: {
  companyId: string;
  brandId: string;
  variant: PackageVariantDto;
  channel: ChannelDto | undefined;
  documents: readonly PackageDocumentDto[];
  /** Only a draft revision's variants are edited (spec 5.5 step 5); the server guards the same. */
  editable: boolean;
  /** An approved revision's variants are scheduled from here (UX-06): the calendar form opens on this variant. */
  schedulable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const findings = variantFindings(variant.validation);
  const status = channel ? CHANNEL_CHIP[channel.status] : null;
  const label = channel ? `${channel.displayName} (${channel.providerKey})` : variant.channelConnectionId;
  return (
    <li
      className="flex flex-col gap-1 py-2"
      data-testid="variant"
      data-variant-valid={findings.ok ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{label}</span>
        {status && status.needsAction && <Badge tone={status.tone}>{status.label}</Badge>}
        <Badge tone={findings.ok ? 'good' : 'critical'}>{findings.ok ? 'Valid' : 'Invalid'}</Badge>
        <code className="text-xs text-muted-foreground">{variant.id}</code>
        {editable && !editing && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit {label}
          </Button>
        )}
        {schedulable && (
          <Button asChild size="sm" variant="secondary">
            <Link
              to={brandPath(companyId, brandId, `calendar?schedule=${encodeURIComponent(variant.id)}`)}
              data-testid="schedule-variant"
            >
              Schedule {label}
            </Link>
          </Button>
        )}
      </div>
      {editing ? (
        <VariantEditor
          key={variant.version}
          variant={variant}
          documents={documents}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm">{variant.text}</p>
          <p className="text-xs text-muted-foreground">
            {variant.exportIds.length} media item{variant.exportIds.length === 1 ? '' : 's'} ·{' '}
            {variant.altTexts.length} alt text{variant.altTexts.length === 1 ? '' : 's'}
          </p>
        </>
      )}
      {!findings.ok && (
        <ul
          className="list-disc pl-5 text-xs"
          aria-label={`Findings for ${variant.id}`}
          data-testid="variant-findings"
        >
          {findings.issues.length === 0 && <li>The channel capability check did not pass.</li>}
          {findings.issues.map((f, i) => (
            <li key={i}>
              {f.path ? <code>{f.path}</code> : null} {f.issue}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function GenerateVariantsForm({
  pkg,
  channels,
}: {
  pkg: PackageDto;
  channels: ReadonlyMap<string, ChannelDto>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const existing = new Set(pkg.variants.map((v) => v.channelConnectionId));
  const [selected, setSelected] = useState<string[]>([]);
  const generate = useMutation(
    trpc.content.variants.generate.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setSelected([]);
        void queryClient.invalidateQueries(trpc.content.pathFilter());
      },
    }),
  );
  const toggle = (id: string) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (selected.length)
      generate.mutate({ contentRevisionId: pkg.revision.id, channelConnectionIds: selected });
  };
  const ui = generate.isError ? toUiError(generate.error) : null;
  const options = [...channels.values()];
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-muted-foreground">
          Channels for revision {pkg.revision.number} (one variant per channel; existing ones are kept)
        </legend>
        {options.length === 0 && (
          <p className="text-xs text-muted-foreground">No channels are connected for this brand.</p>
        )}
        {options.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={existing.has(c.id) || selected.includes(c.id)}
              disabled={existing.has(c.id)}
              onChange={() => toggle(c.id)}
            />
            <span>
              {c.displayName} ({c.providerKey}){existing.has(c.id) ? ' · has a variant' : ''}
            </span>
          </label>
        ))}
      </fieldset>
      {generate.data && (
        <StatusBanner
          tone="good"
          title={`${generate.data.created.length} variant${generate.data.created.length === 1 ? '' : 's'} generated`}
          description="Each variant was checked against its channel's capability; findings are listed per variant."
          data-testid="variants-generated"
        />
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Generating variants needs content.edit for this brand.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={generate.error} title="Variants were not generated" />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={generate.isPending || selected.length === 0}
          disabledReason={selected.length === 0 ? 'Choose at least one channel' : undefined}
        >
          {generate.isPending ? 'Generating…' : 'Generate variants'}
        </Button>
      </div>
    </form>
  );
}

function ReviseForm({ pkg }: { pkg: PackageDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const initialIds = pkg.creativeDocuments.map((d) => d.documentId);
  const [text, setText] = useState(pkg.revision.copy.master.text);
  const [selected, setSelected] = useState<string[]>(initialIds);
  const [summary, setSummary] = useState('');
  const revise = useMutation(
    trpc.content.packages.revise.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setSummary('');
        void queryClient.invalidateQueries(trpc.content.pathFilter());
      },
    }),
  );
  const toggle = (id: string) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    revise.mutate({
      contentPackageId: pkg.id,
      expectedVersion: pkg.version,
      copy: { schemaVersion: 1, master: { text, factRefs: pkg.revision.copy.master.factRefs } },
      // Omitted when unchanged: the server keeps the current documents, so a copy-only revision never detaches
      // the creative. An empty list is a deliberate removal.
      ...(sameIdSet(selected, initialIds) ? {} : { creativeDocumentIds: selected }),
      ...(summary.trim() ? { summary: summary.trim() } : {}),
    });
  };
  const ui = revise.isError ? toUiError(revise.error) : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <Field label="Master copy" htmlFor={`revise-${pkg.id}-copy`}>
        <Textarea
          id={`revise-${pkg.id}-copy`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
      </Field>
      <DocumentPicker
        brandId={pkg.brandId}
        pinned={pkg.creativeDocuments}
        selected={selected}
        onToggle={toggle}
        legend="Creative documents (their current revisions are pinned)"
      />
      <Field label="Change summary (optional)" htmlFor={`revise-${pkg.id}-summary`}>
        <Input id={`revise-${pkg.id}-summary`} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Revising needs content.edit.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={revise.error} title="The package was not revised" />
      )}
      <div>
        <Button type="submit" size="sm" disabled={revise.isPending}>
          {revise.isPending ? 'Revising…' : 'Create next revision'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Spec 13 content package: the current revision with its state (in review, changes requested, approved), the revision
 * history (superseded revisions are kept, never edited), channel variants with their capability findings, and the
 * creative documents the revision publishes with.
 */
export function PackageDetail({
  companyId,
  brandId,
  contentPackageId,
  channels,
  timeZone,
}: PackageDetailProps) {
  const pkg = usePackage(contentPackageId);
  const p = pkg.data;
  const current = p ? revisionChip(p.revision.state) : null;
  return (
    <Panel title="Content package" data-testid="package-detail">
      {pkg.isPending && <Skeleton label="Loading content package" />}
      {pkg.isError && (
        <RequestError
          error={pkg.error}
          onRetry={() => void pkg.refetch()}
          title={toUiError(pkg.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {p && current && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{p.title}</span>
              <Badge tone={packageChip(p.state).tone}>{packageChip(p.state).label}</Badge>
              <code className="text-xs text-muted-foreground">{p.id}</code>
            </div>
          </div>
          <section aria-labelledby={`rev-${p.id}`} className="flex flex-col gap-2">
            <h3 id={`rev-${p.id}`} className="text-sm font-semibold">
              Revision {p.revision.number}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={current.tone} data-testid="revision-state">
                {current.label}
              </Badge>
              <code className="text-xs text-muted-foreground">{p.revision.id}</code>
            </div>
            {current.detail && (
              <p className="text-xs text-muted-foreground" data-testid="revision-detail">
                {current.detail}
              </p>
            )}
            <p className="whitespace-pre-wrap break-words text-sm">{p.revision.copy.master.text}</p>
            <p className="text-xs text-muted-foreground">
              Brand version <code>{p.revision.brandVersionId}</code> · policy{' '}
              <code>{p.revision.policyVersionId}</code> · {p.revision.creativeRevisionIds.length} creative
              revision
              {p.revision.creativeRevisionIds.length === 1 ? '' : 's'} pinned · hash{' '}
              <code>{p.revision.contentHash.slice(0, 12)}…</code>
            </p>
            <PackageDocuments companyId={companyId} brandId={brandId} documents={p.creativeDocuments} />
          </section>
          <section aria-labelledby={`history-${p.id}`} className="flex flex-col gap-1">
            <h3 id={`history-${p.id}`} className="text-sm font-semibold">
              Revision history
            </h3>
            <ol className="flex flex-col gap-1" aria-label="Revision history" data-testid="revision-history">
              {p.revisions.map((r) => {
                const chip = revisionChip(r.state);
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="tabular-nums">#{r.number}</span>
                    <Badge tone={chip.tone}>{chip.label}</Badge>
                    <code className="text-xs text-muted-foreground">{r.id}</code>
                    <span className="text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
          <section aria-labelledby={`variants-${p.id}`} className="flex flex-col gap-1">
            <h3 id={`variants-${p.id}`} className="text-sm font-semibold">
              Channel variants
            </h3>
            {p.variants.length === 0 ? (
              <p className="text-sm text-muted-foreground">No variants for this revision yet.</p>
            ) : (
              <ul className="divide-y divide-border" aria-label="Channel variants">
                {p.variants.map((v) => (
                  <VariantRow
                    key={v.id}
                    companyId={companyId}
                    brandId={brandId}
                    variant={v}
                    channel={channels.get(v.channelConnectionId)}
                    documents={p.creativeDocuments}
                    editable={p.revision.state === 'draft'}
                    schedulable={p.revision.state === 'approved'}
                  />
                ))}
              </ul>
            )}
            <GenerateVariantsForm key={p.revision.id} pkg={p} channels={channels} />
          </section>
          <section aria-labelledby={`review-${p.id}`} className="flex flex-col gap-1">
            <h3 id={`review-${p.id}`} className="text-sm font-semibold">
              Review
            </h3>
            {p.revision.state !== 'draft' && p.revision.state !== 'changes_requested' && (
              <p className="text-xs text-muted-foreground">
                Revision {p.revision.number} is {current.label.toLowerCase()}; only a draft revision can be
                sent for review.
              </p>
            )}
            <RequestReview
              key={p.revision.id}
              companyId={companyId}
              brandId={brandId}
              timeZone={timeZone}
              contentPackageId={p.id}
              revision={p.revision}
              variantCount={p.variants.length}
            />
          </section>
          <ReviseForm key={p.version} pkg={p} />
        </div>
      )}
    </Panel>
  );
}
