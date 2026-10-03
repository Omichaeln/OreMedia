import { Link } from 'react-router';
import { Button, StatusBanner } from '@oremedia/ui';
import { Section } from '../../../../../../components/section';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { Documents, NewDocument } from '../../../../../../features/studio/documents-panel';

/**
 * The Studio section: the brand's documents and the form that creates one. Each document opens the editor, a
 * full-screen workspace of its own (studio/:doc); this index is where the sidebar lands.
 */
export function StudioIndexRoute() {
  const { companyId, brandId, brand } = useBrandContext();
  return (
    <main id="main" className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8">
      <header className="max-w-prose">
        <h1 className="text-xl font-semibold">Studio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every document of the brand, newest first. Open one to edit it in the studio, or create a new one.
        </p>
      </header>
      {brand.status !== 'setup' && !brand.publishedVersionId && (
        <StatusBanner
          tone="warning"
          title="No brand system yet"
          description="The brand has no saved brand system. Documents cannot be created until the brand system is saved."
          actions={
            <Button asChild size="sm">
              <Link to={brandPath(companyId, brandId, 'system')}>Open brand system</Link>
            </Button>
          }
        />
      )}
      <Section id="documents" title="Documents">
        <Documents />
        <NewDocument disabledReason={brand.publishedVersionId ? undefined : 'Save the brand system first'} />
      </Section>
    </main>
  );
}
