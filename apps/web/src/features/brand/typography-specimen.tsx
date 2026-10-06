import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { Button, Field, Input, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { useBrandFonts, type BrandFontFaceDto } from '../assets/use-assets';
import { useFontFaceStatus } from '../assets/use-font-faces';
import { brandPath, useBrandContext } from './brand-context';
import {
  DEFAULT_LINE_HEIGHT,
  TYPE_ROLES,
  faceName,
  fontStatus,
  minSizeWarning,
  resolveLineHeight,
  specRows,
  specimenSizePx,
  typeScale,
  weightCoverage,
  type FontLoadState,
  type FontStatus,
  type TypeRoleKey,
} from './typography-helpers';

type Doc = BrandSystemDocumentV1;
type TypeRole = Doc['tokens']['typeRoles'][number];

const heading = 'om-label';

/**
 * Whether the browser draws `family` at weight `b` with different ink from weight `a`. Faces are registered for
 * weights 100–900 (as the render worker does), so a weight a static file lacks is drawn from that file unchanged;
 * a variable file read as static draws it differently. Null when there is no canvas to ask.
 */
function inkDiffers(family: string, a: number, b: number): boolean | null {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 60;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const draw = (weight: number) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${weight} 32px "${family}"`;
    ctx.fillText('Hamburg', 4, 44);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const x = draw(a);
  const y = draw(b);
  for (let i = 3; i < x.length; i += 4) if (x[i] !== y[i]) return true;
  return false;
}

/**
 * How a role is drawn: its face's registered family (no generic fallback to pass for it), weight, intended size (else
 * its minimum), configured line height (else the labelled default) and tracking.
 */
const roleStyle = (role: TypeRole, family: string | null): CSSProperties => ({
  fontFamily: family ? `"${family}", sans-serif` : 'sans-serif',
  fontWeight: role.weight,
  fontSize: `${specimenSizePx(role)}px`,
  lineHeight: resolveLineHeight(role).value,
  letterSpacing: `${role.tracking ?? 0}em`,
});

interface ResolvedRole {
  role: TypeRole;
  face: BrandFontFaceDto | undefined;
  family: string | null;
  status: FontStatus | null;
}

/**
 * The Typography section as a live specimen (the v3 prototype's layout): the typefaces the roles use, then every
 * type role the brand system defines, largest first, drawn at 100% of its size in its own font files with the values
 * it is drawn with beside it, then the roles composed together, then spacing and radii. Bound to `doc`, so in the
 * editor every change shows at once. The sample text is this preview's alone: it is never part of the brand system.
 */
export function TypographySpecimen({ doc, editing = false }: { doc: Doc; editing?: boolean }) {
  const { companyId, brandId } = useBrandContext();
  const fonts = useBrandFonts(brandId);
  const faces = useMemo(() => fonts.data?.items ?? [], [fonts.data]);
  const roles = doc.tokens.typeRoles;
  const [sample, setSample] = useState('');
  // Every face a role uses is loaded once, under its representative file's version id.
  const used = useMemo(
    () =>
      faces
        .filter((f) => roles.some((r) => r.fontAssetId === f.assetId))
        .flatMap((f) =>
          f.files.map((x) => ({
            family: f.assetVersionId,
            assetVersionId: x.assetVersionId,
            unicodeRange: f.files.length > 1 ? x.unicodeRange : null,
          })),
        ),
    [faces, roles],
  );
  const load = useFontFaceStatus(used);
  const loadOf = (face: BrandFontFaceDto | undefined): FontLoadState =>
    face ? (load.get(face.assetVersionId) ?? 'loading') : 'failed';
  const probes = roles
    .map((r) => {
      const face = faces.find((f) => f.assetId === r.fontAssetId);
      if (!face || loadOf(face) !== 'loaded' || weightCoverage(face, r.weight) !== 'uncovered') return '';
      return [face.assetVersionId, face.weightRange?.min ?? face.weight ?? 400, r.weight].join(' ');
    })
    .join('\n');
  const rendered = useMemo(() => {
    const out = new Map<string, boolean | null>();
    for (const line of probes.split('\n')) {
      const [family, a, b] = line.split(' ');
      if (family && a && b) out.set(line, inkDiffers(family, Number(a), Number(b)));
    }
    return out;
  }, [probes]);

  const resolve = (role: TypeRole): ResolvedRole => {
    const face = faces.find((f) => f.assetId === role.fontAssetId);
    const probe = face
      ? rendered.get(
          [face.assetVersionId, face.weightRange?.min ?? face.weight ?? 400, role.weight].join(' '),
        )
      : undefined;
    return {
      role,
      face,
      family: face ? face.assetVersionId : null,
      // Until the brand's fonts are listed nothing is known about the face, so nothing is claimed either way.
      status: fonts.isSuccess
        ? fontStatus({
            face,
            weight: role.weight,
            load: loadOf(face),
            rendered: probe === undefined || probe === null ? 'unchecked' : probe ? 'distinct' : 'same',
          })
        : null,
    };
  };
  const scale = typeScale(roles).map((s) => ({ ...s, ...resolve(s.role) }));
  const byRole = new Map(scale.map((s) => [s.role.role, s]));
  const typefaces = faces
    .map((face) => ({ face, roles: scale.filter((s) => s.face === face) }))
    .filter((t) => t.roles.length > 0);
  const t = doc.tokens;

  return (
    <div data-testid="type-specimen" className="flex min-w-0 flex-col gap-9 [contain:layout_paint]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          {roles.length === 0
            ? 'No type roles yet.'
            : `${roles.length} role${roles.length === 1 ? '' : 's'}, each bound to a font file, weight, size, minimum size, line height and tracking. Specimens are drawn at 100% of each role's size (its minimum where no size is set); a role with no line height uses ${DEFAULT_LINE_HEIGHT}, labelled as the default.`}
        </p>
        {!editing && (
          <Button asChild size="sm">
            <Link to={brandPath(companyId, brandId, 'assets')}>Manage font files</Link>
          </Button>
        )}
      </div>
      {fonts.isError && <RequestError error={fonts.error} onRetry={() => void fonts.refetch()} />}
      {roles.length > 0 && fonts.isPending && <Skeleton label="Loading the brand's fonts" lines={2} />}

      {typefaces.length > 0 && (
        <section aria-labelledby="specimen-typefaces" className="flex flex-col gap-3">
          <h3 id="specimen-typefaces" className={heading}>
            Typefaces
          </h3>
          <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
            {typefaces.map(({ face, roles: assigned }) => {
              const first = assigned[0]?.role;
              const failed = loadOf(face) === 'failed';
              return (
                <li
                  key={face.key}
                  data-testid={`typeface-${face.assetId}`}
                  className="flex flex-col gap-3 rounded-md border border-border bg-background p-5"
                >
                  <span
                    aria-hidden="true"
                    style={{
                      fontFamily: `"${face.assetVersionId}", sans-serif`,
                      fontWeight: first?.weight ?? face.weight ?? 400,
                      fontSize: '44px',
                      lineHeight: 1,
                    }}
                  >
                    Aa
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{faceName(face)}</span>
                    <span className="break-all font-mono text-[11px] text-muted-foreground">{face.name}</span>
                    {face.licence && <span className="text-xs text-muted-foreground">{face.licence}</span>}
                  </span>
                  <span className="text-xs">
                    <span className="text-muted-foreground">Used for </span>
                    {assigned.map((a) => TYPE_ROLES.find((x) => x.role === a.role.role)?.label).join(' · ')}
                  </span>
                  {failed && (
                    <p className="text-xs text-status-critical">
                      <span aria-hidden="true">! </span>The font file did not load.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {scale.length > 0 && (
        <section aria-labelledby="specimen-roles" className="flex flex-col">
          <div className="mb-3 flex flex-col gap-2">
            <h3 id="specimen-roles" className={heading}>
              Type scale
            </h3>
            <div className="flex flex-wrap items-start gap-2">
              <Field
                label="Sample text"
                htmlFor="specimen-sample"
                hint="Preview only: it is never saved to the brand system."
                className="min-w-0 flex-1 basis-full sm:basis-0"
              >
                <Input
                  id="specimen-sample"
                  value={sample}
                  maxLength={200}
                  placeholder="Type your own words to preview every role"
                  onChange={(e) => setSample(e.target.value)}
                />
              </Field>
              <Button
                size="sm"
                variant="ghost"
                className="sm:mt-5"
                onClick={() => setSample('')}
                disabled={sample === ''}
              >
                Reset sample text
              </Button>
            </div>
          </div>
          <ol aria-label="Type roles, largest first">
            {scale.map((s) => {
              const spec = TYPE_ROLES.find((x) => x.role === s.role.role);
              return (
                <li
                  key={s.role.role}
                  data-testid={`type-specimen-${s.role.role}`}
                  className="grid gap-x-6 gap-y-3 border-t border-border py-5 md:grid-cols-[minmax(0,1fr)_240px] md:items-center"
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="min-w-0 overflow-x-auto">
                      <p
                        data-testid={`type-preview-${s.role.role}`}
                        className="m-0 [text-wrap:balance]"
                        style={roleStyle(s.role, s.family)}
                      >
                        {sample || spec?.sample}
                      </p>
                    </div>
                    {spec && <p className="text-xs text-muted-foreground">{spec.use}</p>}
                    {s.status && <SpecimenWarning role={s.role.role} status={s.status} />}
                    <MinSizeWarning role={s.role} />
                  </div>
                  <dl
                    className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]"
                    data-testid={`type-spec-${s.role.role}`}
                  >
                    <dt className="text-muted-foreground">scale</dt>
                    <dd className="m-0">
                      {s.step} of {s.of}
                    </dd>
                    {specRows(s.role, s.face).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="m-0 break-words">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {scale.length > 0 && (
        <section aria-labelledby="specimen-in-use" className="flex flex-col gap-3">
          <h3 id="specimen-in-use" className={heading}>
            In use
          </h3>
          <ComposedExample byRole={byRole} />
          {scale.some((s) => s.status && s.status.tone !== 'info') && (
            <p className="text-xs text-status-warning">
              <span aria-hidden="true">! </span>Some roles are not drawn in their brand font: see the warnings
              above.
            </p>
          )}
        </section>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-8">
        <section aria-labelledby="specimen-spacing" className="flex flex-col gap-3">
          <h3 id="specimen-spacing" className={heading}>
            Spacing scale
          </h3>
          {t.spacingScale.length === 0 ? (
            <p className="text-sm text-muted-foreground">No spacing scale yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {t.spacingScale.map((v, i) => (
                <li key={i} className="flex items-center gap-3">
                  <span className="w-10 font-mono text-[11px] text-muted-foreground">{v}</span>
                  <span
                    aria-hidden="true"
                    className="h-2.5 max-w-full rounded-sm bg-accent"
                    style={{ width: `${v * 3}px` }}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="specimen-radii" className="flex flex-col gap-3">
          <h3 id="specimen-radii" className={heading}>
            Radii
          </h3>
          {t.radii.length === 0 ? (
            <p className="text-sm text-muted-foreground">No radii yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {t.radii.map((v, i) => (
                <li key={i} className="flex flex-col items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-14 w-14 border-[1.5px] border-foreground bg-background"
                    style={{ borderRadius: `${Math.min(v, 28)}px` }}
                  />
                  <span className="font-mono text-[11px] text-muted-foreground">{v}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function SpecimenWarning({ role, status }: { role: TypeRoleKey; status: FontStatus }) {
  if (status.tone === 'info')
    return (
      <p className="text-xs text-muted-foreground" data-testid={`type-loading-${role}`}>
        {status.title}
      </p>
    );
  return (
    <StatusBanner
      tone={status.tone}
      title={status.title}
      description={status.action}
      live="polite"
      data-testid={`type-warning-${role}`}
    />
  );
}

/** A role set below its own minimum size, said on its specimen (apart from the font warnings). */
function MinSizeWarning({ role }: { role: TypeRole }) {
  const warning = minSizeWarning(role);
  if (!warning) return null;
  return (
    <StatusBanner
      tone={warning.tone}
      title={warning.title}
      description={warning.action}
      live="polite"
      data-testid={`type-size-warning-${role.role}`}
    />
  );
}

/** The roles together as a post would set them: label, display, heading, body paragraphs, a button and a caption. */
function ComposedExample({ byRole }: { byRole: Map<TypeRoleKey, ResolvedRole> }) {
  const style = (key: TypeRoleKey) => {
    const r = byRole.get(key);
    return r ? roleStyle(r.role, r.family) : undefined;
  };
  const has = (key: TypeRoleKey) => byRole.has(key);
  return (
    <article
      data-testid="type-composed"
      className="flex min-w-0 flex-col gap-4 overflow-x-auto rounded-md border border-border bg-background p-5 sm:p-8"
    >
      {has('label') && (
        <p className="m-0" style={style('label')}>
          New season · Limited run
        </p>
      )}
      {has('display') && (
        <h4 className="m-0 [text-wrap:balance]" style={style('display')}>
          Made slowly, made to last
        </h4>
      )}
      {has('heading') && (
        <p className="m-0 [text-wrap:balance]" style={style('heading')}>
          What goes into every piece we make
        </p>
      )}
      {has('body') && (
        <div className="flex max-w-prose flex-col gap-3">
          <p className="m-0" style={style('body')}>
            Every piece starts with the material. We choose it for how it wears in, not how it looks on the
            first day, and we tell you where it came from.
          </p>
          <p className="m-0" style={style('body')}>
            Then we take our time. Small batches mean each one is checked by the person who made it before it
            leaves the workshop.
          </p>
        </div>
      )}
      {(has('label') || has('caption')) && (
        <div className="flex flex-wrap items-center gap-4">
          {has('label') && (
            <span className="rounded-md border border-foreground px-4 py-2" style={style('label')}>
              Shop the range
            </span>
          )}
          {has('caption') && (
            <span className="text-muted-foreground" style={style('caption')}>
              Photographed in the workshop, 2026
            </span>
          )}
        </div>
      )}
    </article>
  );
}
