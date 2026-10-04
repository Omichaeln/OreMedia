import { Link } from 'react-router';
import { Button, StatusBanner } from '@oremedia/ui';
import { Section } from '../../../../../../components/section';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { Documents } from '../../../../../../features/studio/documents-panel';
import { NewDocumentGallery } from '../../../../../../features/studio/create/new-document';

/**
 * The Studio section: the brand's documents and the form that creates one. Each document opens the editor, a
 * full-screen workspace of its own (studio/:doc); this index is where the sidebar lands.
 */
export function StudioIndexRoute() {
  const { companyId, brandId, brand } = useBrandContext();
  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8">
      <header className="max-w-prose">
        <h1 className="text-xl font-semibold">Studio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start a new document from what it is for, or open one of the brand's documents to keep editing.
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
      <Section id="create" title="Create">
        <NewDocumentGallery
          disabledReason={brand.publishedVersionId ? undefined : 'Save the brand system first'}
        />
      </Section>
      <Section id="documents" title="Documents">
        <Documents />
      </Section>
    </main>
  );
}
