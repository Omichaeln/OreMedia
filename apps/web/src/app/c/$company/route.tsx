import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Field, Input, Skeleton } from '@oremedia/ui';
import { TopBar } from '../../root';
import { RequestError } from '../../../components/request-state';
import { Section } from '../../../components/section';
import { useCompanies } from '../../../features/portfolio/use-companies';
import { useBrands } from '../../../features/brand/use-brand';
import { brandPath } from '../../../features/brand/brand-context';
import { useTRPC } from '../../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../../lib/intent-key';
import { toUiError } from '../../../lib/errors';

/** The brands of one company (`/c/:company`); restricted access shows as the server's FORBIDDEN, never a blank page. */
export function CompanyRoute() {
  const { company = '' } = useParams();
  const companies = useCompanies();
  const brands = useBrands();
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

function CreateBrand() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [name, setName] = useState('');
  const create = useMutation(
    trpc.brand.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setName('');
        void queryClient.invalidateQueries(trpc.brand.list.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate({ name: name.trim(), timezone: 'UTC', defaultLocale: 'en' });
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
        <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
          {create.isPending ? 'Creating…' : 'Create brand'}
        </Button>
      </form>
    </Section>
  );
}
