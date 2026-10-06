import { useSearchParams } from 'react-router';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { Documents } from '../../../../../../features/studio/documents-panel';
import {
  FormatPicker,
  StudioStart,
  formatOf,
  kindLabel,
  studioKindOf,
} from '../../../../../../features/studio/create/new-document';
import { StudioBar } from '../../../../../../features/studio/studio-bar';

/**
 * The Studio section as the supplied interface draws it: a full-screen workspace with its own breadcrumb bar (the
 * brand shell steps aside, as it does for a document). "Create" asks what is being made (Still or Motion) and lists
 * the brand's documents to continue; the format step picks a platform, a size and a layout and creates the document
 * (D-30: the home's "+ New document" lands here). The step is in the address: `?kind=still&platform=&format=`.
 */
export function StudioIndexRoute() {
  const { companyId, brandId } = useBrandContext();
  const [params] = useSearchParams();
  const kind = studioKindOf(params);
  const format = kind ? formatOf(kind, params.get('format')) : null;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <StudioBar
        back={
          kind
            ? { to: brandPath(companyId, brandId, 'studio'), label: 'Back', title: 'Back to Create' }
            : { to: brandPath(companyId, brandId, 'home'), label: 'Back', title: 'Back to Home' }
        }
        crumbs={kind ? [kindLabel(kind), format ? format.label : 'Choose a format'] : ['Create']}
      />
      {kind ? (
        <FormatPicker kind={kind} />
      ) : (
        <StudioStart>
          <Documents />
        </StudioStart>
      )}
    </div>
  );
}
