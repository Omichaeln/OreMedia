import { useState, type ComponentProps, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BrandClassification } from '@oremedia/contracts/brand';
import { Badge, Button, EmptyState, Field, Input, Skeleton } from '@oremedia/ui';
import { TopBar } from '../../root';
import { RequestError } from '../../../components/request-state';
import { Select } from '../../../components/select';
import { Section } from '../../../components/section';
import { SummaryCounts } from '../../../features/portfolio/summary-counts';
import { useCompanies } from '../../../features/portfolio/use-companies';
import { useBrandSummary, useBrands } from '../../../features/brand/use-brand';
import { CLASSIFICATION_LABEL } from '../../../features/brand/brand-classification';
import { brandPath } from '../../../features/brand/brand-context';
import { useTRPC } from '../../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../../lib/intent-key';
import { toUiError } from '../../../lib/errors';

/** The brands of one company (`/c/:company`); restricted access shows as the server's FORBIDDEN, never a blank page. */
export function CompanyRoute() {
  const { company = '' } = useParams();
  const companies = useCompanies();
  const brands = useBrands();
  const summary = useBrandSummary(company);
  const companyName = companies.data?.find((c) => c.tenantId === company)?.name ?? null;
  return (
    <>
      <TopBar title={companyName ?? 'Company'} />
      <main id="main" className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8">
        <header>
          <h1 className="text-xl font-semibold">{companyName ?? 'Brands'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Brands you can see in this company.</p>
        </header>
        {brands.isPending && <Skeleton label="Loading brands" lines={3} />}
        {brands.isError && (
          <RequestError
            error={brands.error}
            onRetry={() => void brands.refetch()}
            title="Restricted access"
          />
        )}
        {brands.isSuccess && brands.data.length === 0 && (
          <EmptyState
            title="No brands yet"
            description="Create the first brand, or ask an admin to grant you one."
          />
        )}
        {brands.isSuccess && brands.data.length > 0 && (
          <ul className="flex flex-col divide-y divide-border border-y border-border" aria-label="Brands">
            {brands.data.map((b) => (
              <li key={b.id}>
                <section
                  aria-labelledby={`brand-${b.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div className="min-w-0">
                    <h2 id={`brand-${b.id}`} className="font-semibold">
                      {b.name}
                    </h2>
                    <p className="mt-1 flex flex-wrap gap-2">
                      <Badge
                        tone={b.status === 'active' ? 'good' : b.status === 'setup' ? 'warning' : 'neutral'}
                      >
                        {b.status === 'setup' ? 'Setup incomplete' : b.status}
                      </Badge>
                      {!b.publishedVersionId && <Badge tone="warning">No published standards</Badge>}
                    </p>
                    {summary.data && (
                      <BrandCounts
                        counts={summary.data.brands.find((c) => c.brandId === b.id)}
                        upcomingDays={summary.data.upcomingDays}
                      />
                    )}
                    {summary.isError && (
                      <p className="mt-2 text-xs text-muted-foreground">Counts are unavailable right now.</p>
                    )}
                  </div>
                  <Link
                    to={brandPath(company, b.id)}
                    className="text-sm font-medium underline-offset-2 hover:underline"
                  >
                    Open <span aria-hidden="true">→</span>
                  </Link>
                </section>
              </li>
            ))}
          </ul>
        )}
        {brands.isSuccess && <CreateBrand />}
      </main>
    </>
  );
}

function BrandCounts({
  counts,
  upcomingDays,
}: {
  counts: Omit<ComponentProps<typeof SummaryCounts>, 'upcomingDays'> | undefined;
  upcomingDays: number;
}) {
  if (!counts) return null;
  return (
    <p className="mt-2">
      <SummaryCounts {...counts} upcomingDays={upcomingDays} />
    </p>
  );
}

/** The zones the browser knows (IANA); UTC first so a brand without a home office has a plain choice. */
const TIME_ZONES: readonly string[] = (() => {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  return ['UTC', ...known.filter((z) => z !== 'UTC')];
})();

function CreateBrand() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [name, setName] = useState('');
  const [classification, setClassification] = useState<BrandClassification>('client');
  // R1-D: the brand keeps its own clock from the first day; the browser's zone is the likely one.
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const create = useMutation(
    trpc.brand.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setName('');
        setClassification('client');
        void queryClient.invalidateQueries(trpc.brand.list.pathFilter());
        void queryClient.invalidateQueries(trpc.brand.summary.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate({ name: name.trim(), timezone, defaultLocale: 'en', classification });
  };
  return (
    <Section id="create-brand-heading" title="Create a brand">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3" noValidate>
        <Field
          label="Brand name"
          htmlFor="brand-name"
          className="min-w-64 flex-1"
          error={create.isError ? toUiError(create.error).message : undefined}
        >
          <Input
            id="brand-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
          />
        </Field>
        <Field label="Brand type" htmlFor="brand-classification" className="min-w-48">
          <Select
            id="brand-classification"
            value={classification}
            onValueChange={(v) => setClassification(BrandClassification.parse(v))}
            options={BrandClassification.options.map((c) => ({
              value: c,
              label: CLASSIFICATION_LABEL[c].label,
            }))}
          />
        </Field>
        <Field label="Time zone" htmlFor="brand-timezone" className="min-w-56">
          <Select
            id="brand-timezone"
            value={timezone}
            onValueChange={setTimezone}
            options={TIME_ZONES.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
          {create.isPending ? 'Creating…' : 'Create brand'}
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">{CLASSIFICATION_LABEL[classification].hint}</p>
    </Section>
  );
}
