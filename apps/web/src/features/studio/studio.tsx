import { useEffect, useMemo, useRef, useState } from 'react';
import { changedElementIds, findElement, findWithAncestors, isLockedInContext } from '@oremedia/editor';
import { Badge, Button, EmptyState, StatusBanner } from '@oremedia/ui';
import { Tab, TabList, TabPanel, Tabs } from '../../components/tabs';
import { useBrandVersion } from '../brand/use-brand';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useAssetUrls, useBrandFonts, useGeneratedAssetIds } from '../assets/use-assets';
import { useStarterBrand } from './create/use-starter-brand';
import { DocumentTitle } from './document-title';
import { InsertToolbar } from './insert-toolbar';
import { newElementId } from '../../lib/ids';
import { useTheme } from '../../lib/theme';
import { AssetsPanel } from './assets-panel';
import { Canvas } from './canvas';
import { CommentsPanel } from './comments-panel';
import { diffDocuments } from './diff';
import { assetVersionIdsOf, fontRefsOf, logoVersionIdsOf } from './document-helpers';
import { FormatStrip } from './format-strip';
import { HistoryPanel } from './history-panel';
import { LayersPanel } from './layers-panel';
import { PropertiesPanel, toFontOption, type FontOption } from './properties-panel';
import { AgentPanel } from './agent-panel';
import { GeneratePanel } from './generate-panel';
import { RenderPanel } from './render-panel';
import { ReviewPanel } from './review-panel';
import { ConflictDialog, LeaveDialog, SaveBanners, SaveIndicator } from './save-indicator';
import { StudioBar } from './studio-bar';
import { hasLocalWork } from './studio-reducer';
import { TemplatesPanel } from './templates-panel';
import { useCommentPages } from './use-document';
import { useDocumentFonts } from './use-document-fonts';
import { useStudioPanels } from './use-panels';
import { useStudio } from './use-studio';
import type { DocumentDto } from './types';

const devTools = (): boolean =>
  import.meta.env.DEV || new URLSearchParams(window.location.search).has('devtools');

type RightTab = 'generate' | 'agent' | 'comments' | 'checks' | 'history';

/** A tab's count, read as part of its name ("Comments, 2 open"); nothing is shown at zero. */
function TabCount({ n, label }: { n: number; label: string }) {
  if (n === 0) return null;
  return (
    <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
      <span className="sr-only">, </span>
      {n}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

/**
 * Spec 11.1 layout, in the interface's chrome: the studio bar; layers, assets and templates in a flush column on the
 * left; the canvas on the tinted ground in the centre with the insert bar above it and the page strip below; on the
 * right the properties over the document panels (generate, agent, comments, checks, history).
 *
 * UX-18: the three columns by breakpoint. The canvas column keeps a minimum (20rem, 24rem from xl) whichever side
 * panels are shown, so panels give way, never the canvas; below md everything stacks. From xl the side columns take
 * the interface's widths (232 and 300 px). Full class strings so Tailwind sees them.
 */
const GRID = {
  both: 'md:grid-cols-[12rem_minmax(20rem,1fr)_14rem] lg:grid-cols-[14.5rem_minmax(20rem,1fr)_18rem] xl:grid-cols-[14.5rem_minmax(24rem,1fr)_18.75rem]',
  left: 'md:grid-cols-[12rem_minmax(20rem,1fr)] lg:grid-cols-[14.5rem_minmax(20rem,1fr)] xl:grid-cols-[14.5rem_minmax(24rem,1fr)]',
  right:
    'md:grid-cols-[minmax(20rem,1fr)_14rem] lg:grid-cols-[minmax(20rem,1fr)_18rem] xl:grid-cols-[minmax(24rem,1fr)_18.75rem]',
  none: 'md:grid-cols-[minmax(20rem,1fr)]',
} as const;
/** The save states the banners under the bar speak for (SaveBanners). */
const BANNER_SAVE_KINDS: ReadonlySet<string> = new Set(['failed', 'rebasing', 'conflict']);
const gridKey = (p: { left: boolean; right: boolean }): keyof typeof GRID =>
  p.left && p.right ? 'both' : p.left ? 'left' : p.right ? 'right' : 'none';

export function Studio({ documentId, initial }: { documentId: string; initial: DocumentDto }) {
  const { companyId, brandId, brand } = useBrandContext();
  const studio = useStudio(documentId, initial);
  const { state, doc, page } = studio;
  const { theme, toggle } = useTheme();
  const readOnly = false;
  const [focusText, setFocusText] = useState(0);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [rightTab, setRightTab] = useState<RightTab>('generate');
  const [reviewOpen, setReviewOpen] = useState(false);
  const { panels, toggle: togglePanel } = useStudioPanels();
  const comments = useCommentPages(documentId);
  const openComments = comments.items.filter((c) => c.state !== 'resolved').length;

  const brandVersion = useBrandVersion(brandId, state.committed.snapshot.brandVersionId);
  const colourTokens = useMemo(() => brandVersion.data?.document.tokens.colours ?? [], [brandVersion.data]);
  const colourMap = useMemo(() => new Map(colourTokens.map((c) => [c.key, c.value])), [colourTokens]);
  const logoIds = useMemo(() => logoVersionIdsOf(doc), [doc]);
  const imageUrls = useAssetUrls(
    useMemo(() => assetVersionIdsOf(doc).filter((id) => !logoIds.includes(id)), [doc, logoIds]),
  );
  // Logos draw from their original (an SVG as vector), the bytes the export draws (BSC-2).
  const logoUrls = useAssetUrls(logoIds, 'original');
  const assetUrls = new Map([...imageUrls, ...logoUrls]);
  const fontFamilyFor = useDocumentFonts(useMemo(() => fontRefsOf(doc), [doc]));
  // STU-1a: the brand pieces new text and shapes are made of, the font picker and honest labels for generated images.
  const starterBrand = useStarterBrand(brandId, state.committed.snapshot.brandVersionId);
  const kit = starterBrand.brand
    ? { colours: starterBrand.brand.colours, typeRoles: starterBrand.brand.typeRoles }
    : null;
  const brandFonts = useBrandFonts(brandId);
  const fontOptions: FontOption[] = useMemo(
    () => (brandFonts.data?.items ?? []).map(toFontOption),
    [brandFonts.data],
  );
  const generatedIds = useGeneratedAssetIds(
    useMemo(() => assetVersionIdsOf(doc).filter((id) => !logoIds.includes(id)), [doc, logoIds]),
  );
  const resolverVersion = `${[...assetUrls.keys()].join(',')}|${[...assetUrls.values()].join(',').length}|${colourTokens.map((c) => c.key + c.value).join(',')}|${fontRefsOf(doc).map(fontFamilyFor).join(',')}`;

  const proposalDiff = useMemo(
    () => (state.proposal ? diffDocuments(state.committed.snapshot, state.proposal.result.snapshot) : null),
    [state.proposal, state.committed.snapshot],
  );
  const pendingElementIds = useMemo(
    () =>
      changedElementIds({
        operations: [...(state.inFlight?.operations ?? []), ...(state.pending?.operations ?? [])],
      }),
    [state.inFlight, state.pending],
  );
  const dirty = hasLocalWork(state);
  // A proposal needs a decision before anything else in the document moves, so it brings its tab forward.
  const hasProposal = state.proposal !== null;
  const generationProposal = Boolean(state.proposal?.generation);
  useEffect(() => {
    if (hasProposal) setRightTab(generationProposal ? 'generate' : 'agent');
  }, [hasProposal, generationProposal]);

  const selectPage = (id: string) => {
    studio.setPage(id);
    canvasRef.current?.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus(); // managed focus on panel change
  };
  const deleteSelected = () => {
    if (!page) return;
    // Locked elements (or ones in a locked group, or groups holding one) are not removed (STU-1a).
    const removable = state.selection
      .map((id) => findWithAncestors(page, id))
      .filter((f): f is NonNullable<typeof f> => f !== null && !isLockedInContext(f.element, f.ancestors))
      .map((f) => f.element);
    if (removable.length === 0) return;
    studio.applyIntent({
      operations: removable.map((el) => ({
        op: 'removeElement' as const,
        pageId: page.id,
        elementId: el.id,
      })),
      summary:
        removable.length === 1 ? `Remove ${removable[0]?.name}` : `Remove ${removable.length} elements`,
      origin: 'user',
    });
  };
  /**
   * Shows or hides elements as one undoable step: hides them all when any is shown, else shows them. Locked elements
   * (or ones in a locked group, or anything on a locked page) are left as they are, as removal leaves them.
   */
  const toggleVisibility = (ids: string[]) => {
    if (!page || page.locked) return;
    const targets = ids
      .map((id) => findWithAncestors(page, id))
      .filter((f): f is NonNullable<typeof f> => f !== null && !isLockedInContext(f.element, f.ancestors))
      .map((f) => f.element);
    if (targets.length === 0) return;
    const visible = !targets.some((el) => el.visible);
    studio.applyIntent({
      operations: targets.map((el) => ({
        op: 'setVisibility' as const,
        pageId: page.id,
        elementId: el.id,
        visible,
      })),
      summary:
        targets.length === 1
          ? `${visible ? 'Show' : 'Hide'} ${targets[0]?.name}`
          : `${visible ? 'Show' : 'Hide'} ${targets.length} elements`,
      origin: 'user',
    });
  };
  /** Selects ids that may not be in this render's page yet (a just-inserted element, a new group). */
  const selectNew = (ids: string[]) => studio.dispatch({ type: 'select', ids });
  const groupSelection = () => {
    if (!page || state.selection.length < 2) return;
    const groupId = newElementId();
    if (
      studio.applyIntent({
        operations: [{ op: 'groupElements', pageId: page.id, elementIds: state.selection, groupId }],
        summary: `Group ${state.selection.length} elements`,
        origin: 'user',
      })
    )
      selectNew([groupId]);
  };
  const ungroupSelection = () => {
    const el = page && state.selection.length === 1 ? findElement(page, state.selection[0] ?? '') : null;
    if (!page || !el || el.type !== 'group') return;
    if (
      studio.applyIntent({
        operations: [{ op: 'ungroupElement', pageId: page.id, elementId: el.id }],
        summary: `Ungroup ${el.name}`,
        origin: 'user',
      })
    )
      selectNew(el.children.map((c) => c.id));
  };
  const editText = (id: string) => {
    const el = page ? findElement(page, id) : null;
    studio.select([id]);
    if (el?.type === 'text' && !el.locked) setEditingTextId(id);
    else setFocusText((n) => n + 1);
  };

  if (!page)
    return (
      <main id="main" className="p-6">
        <EmptyState
          title="This document has no pages"
          description="A document always has at least one page; this one cannot be edited."
        />
      </main>
    );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="studio">
      <StudioBar
        back={{ to: brandPath(companyId, brandId, 'studio'), label: 'Studio', title: 'Back to the Studio' }}
        crumbs={['Still', <DocumentTitle key="title" documentId={documentId} title={initial.title} />]}
        status={
          <SaveIndicator
            save={state.save}
            revisionNumber={state.committed.number}
            onRetry={() => void studio.saveNow()}
          />
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => togglePanel('left')}
              aria-pressed={panels.left}
              data-testid="toggle-left-panels"
            >
              {panels.left ? 'Hide layers' : 'Show layers'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => togglePanel('right')}
              aria-pressed={panels.right}
              data-testid="toggle-right-panels"
            >
              {panels.right ? 'Hide properties' : 'Show properties'}
            </Button>
            <Button size="sm" variant="ghost" onClick={toggle} aria-pressed={theme === 'dark'}>
              {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </Button>
            <Button
              size="sm"
              onClick={studio.undo}
              disabledReason={studio.undoBlocked ?? undefined}
              data-testid="undo"
            >
              Undo
            </Button>
            <Button
              size="sm"
              onClick={studio.redo}
              disabledReason={studio.redoBlocked ?? undefined}
              data-testid="redo"
            >
              Redo
            </Button>
            <Button
              size="sm"
              onClick={() => void studio.saveNow()}
              disabled={!state.pending || Boolean(state.inFlight)}
              data-testid="save-now"
            >
              Save now
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => setReviewOpen((open) => !open)}
              aria-expanded={reviewOpen}
              aria-controls="studio-review"
            >
              Send for review
            </Button>
          </>
        }
      />

      {/* Above the canvas rather than a right-sidebar tab: it holds a form and a package list that need the width,
          and it is a hand-off out of the studio, not a view of the document like the sidebar tabs. */}
      {reviewOpen && (
        <div id="studio-review" className="shrink-0 border-b border-border bg-card px-4 py-3">
          <ReviewPanel
            companyId={companyId}
            brandId={brandId}
            timeZone={brand.timezone || 'UTC'}
            documentId={documentId}
            documentTitle={initial.title}
            headRevisionId={state.committed.revisionId}
            hasLocalWork={dirty}
            onClose={() => setReviewOpen(false)}
          />
        </div>
      )}

      {(state.notice || studio.localError || BANNER_SAVE_KINDS.has(state.save.kind)) && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
          <SaveBanners
            save={state.save}
            headNumber={state.conflict?.head.number ?? state.committed.number}
            onRetry={() => void studio.saveNow()}
          />
          {state.notice && (
            <StatusBanner
              tone={state.notice.tone}
              title={state.notice.text}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => studio.dispatch({ type: 'notice', notice: null })}
                >
                  Dismiss
                </Button>
              }
            />
          )}
          {studio.localError && (
            <StatusBanner
              tone="critical"
              title="A local change could not be rendered"
              description={studio.localError}
            />
          )}
        </div>
      )}

      <main id="main" className={`grid min-h-0 flex-1 grid-cols-1 ${GRID[gridKey(panels)]}`}>
        {panels.left && (
          <section
            aria-labelledby="left-panels-heading"
            className="flex min-h-48 min-w-0 flex-col overflow-hidden border-b border-border bg-card md:min-h-0 md:border-b-0 md:border-r"
            data-testid="left-panels"
          >
            <h2 id="left-panels-heading" className="sr-only">
              Left panels
            </h2>
            <Tabs defaultValue="layers" className="flex min-h-0 flex-1 flex-col">
              <TabList label="Studio panels" variant="pill">
                <Tab value="layers" variant="pill">
                  Layers
                </Tab>
                <Tab value="assets" variant="pill">
                  Assets
                </Tab>
                <Tab value="templates" variant="pill">
                  Templates
                </Tab>
              </TabList>
              <TabPanel value="layers">
                <LayersPanel
                  page={page}
                  selection={state.selection}
                  onSelect={selectNew}
                  onActivate={() => setFocusText((n) => n + 1)}
                  readOnly={readOnly}
                  onToggleVisibility={(id) => toggleVisibility([id])}
                />
              </TabPanel>
              <TabPanel value="assets">
                <AssetsPanel
                  brandId={brandId}
                  page={page}
                  logoRules={brandVersion.data?.document.logoRules ?? []}
                  selection={state.selection}
                  readOnly={readOnly}
                  onIntent={studio.applyIntent}
                  onInserted={(id) => selectNew([id])}
                />
              </TabPanel>
              <TabPanel value="templates">
                <TemplatesPanel
                  brandId={brandId}
                  page={page}
                  readOnly={readOnly}
                  resolveTemplate={studio.resolveTemplate}
                  onIntent={studio.applyIntent}
                  templates={state.templates}
                  saveSource={dirty ? null : { title: initial.title, document: state.committed.snapshot }}
                />
              </TabPanel>
            </Tabs>
          </section>
        )}

        <div
          ref={canvasRef}
          className="flex min-h-72 min-w-0 flex-col bg-secondary md:min-h-0"
          data-testid="canvas-column"
        >
          <InsertToolbar
            page={page}
            kit={kit}
            readOnly={readOnly}
            onIntent={studio.applyIntent}
            onInserted={(id) => selectNew([id])}
          />
          {page.locked && (
            <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground" role="status">
              This page is locked: elements on it cannot be moved, resized or rotated, and AI agents cannot
              change it.
            </p>
          )}
          <Canvas
            doc={doc}
            page={page}
            selection={state.selection}
            readOnly={readOnly}
            onSelect={studio.select}
            onIntent={studio.applyIntent}
            onEditText={editText}
            editingTextId={editingTextId}
            onEditTextDone={() => setEditingTextId(null)}
            onDeleteSelected={deleteSelected}
            onGroup={groupSelection}
            onUngroup={ungroupSelection}
            onToggleVisibility={() => toggleVisibility(state.selection)}
            onUndo={studio.undo}
            onRedo={studio.redo}
            onSave={() => void studio.saveNow()}
            resolveAssetUrl={(id) => assetUrls.get(id) ?? null}
            fontFamilyFor={fontFamilyFor}
            colourFor={(token) => colourMap.get(token) ?? null}
            resolverVersion={resolverVersion}
            overlay={proposalDiff}
          />
          <FormatStrip
            doc={doc}
            pageId={page.id}
            readOnly={readOnly}
            onSelectPage={selectPage}
            onIntent={studio.applyIntent}
          />
        </div>

        {panels.right && (
          <div
            className="flex min-h-0 min-w-0 flex-col border-t border-border bg-card md:border-l md:border-t-0"
            data-testid="right-panels"
          >
            <section
              aria-labelledby="properties-heading"
              className="flex shrink-0 flex-col gap-2.5 border-b border-border px-4 py-3.5 md:max-h-[46%] md:overflow-auto"
            >
              <h2 id="properties-heading" className="text-sm font-medium">
                Properties
              </h2>
              <PropertiesPanel
                page={page}
                selection={state.selection}
                readOnly={readOnly}
                colourTokens={colourTokens}
                fonts={fontOptions}
                generatedIds={generatedIds}
                resolveAssetUrl={(id) => assetUrls.get(id) ?? null}
                onIntent={studio.applyIntent}
                onSelect={selectNew}
                focusTextRequest={focusText}
              />
            </section>
            <section
              aria-labelledby="document-panels-heading"
              className="flex min-h-72 flex-1 flex-col md:min-h-0"
            >
              <h2 id="document-panels-heading" className="sr-only">
                Document panels
              </h2>
              <Tabs
                value={rightTab}
                onValueChange={(v) => setRightTab(v as RightTab)}
                className="flex min-h-0 flex-1 flex-col"
              >
                <TabList label="Document panels" variant="pill" className="flex-wrap">
                  <Tab value="generate" variant="pill">
                    Generate
                    {state.proposal?.generation && <TabCount n={1} label="proposal waiting" />}
                  </Tab>
                  <Tab value="agent" variant="pill">
                    Agent
                    {state.proposal && !state.proposal.generation && (
                      <TabCount n={1} label="proposal waiting" />
                    )}
                  </Tab>
                  <Tab value="comments" variant="pill">
                    Comments
                    <TabCount n={openComments} label="open" />
                  </Tab>
                  <Tab value="checks" variant="pill">
                    Checks
                    <TabCount n={state.findings.length} label="on the last save" />
                  </Tab>
                  <Tab value="history" variant="pill">
                    History
                  </Tab>
                </TabList>
                <TabPanel value="generate" className="flex flex-col gap-3 p-3" keepMounted>
                  <GeneratePanel
                    documentId={documentId}
                    page={page}
                    state={state}
                    studio={studio}
                    proposalDiff={proposalDiff}
                    hasLocalWork={dirty}
                    readOnly={readOnly}
                  />
                </TabPanel>
                <TabPanel value="agent" className="flex flex-col gap-3 p-3">
                  <AgentPanel
                    brandId={brandId}
                    documentId={documentId}
                    page={page}
                    state={state}
                    studio={studio}
                    proposalDiff={proposalDiff}
                    hasLocalWork={dirty}
                    readOnly={readOnly}
                    simulate={devTools() ? () => void studio.simulateProposal() : undefined}
                  />
                </TabPanel>
                <TabPanel value="comments" className="p-3" keepMounted>
                  <CommentsPanel
                    documentId={documentId}
                    revisionId={state.committed.revisionId}
                    doc={doc}
                    selection={state.selection}
                    pendingElementIds={pendingElementIds}
                    onSelect={studio.select}
                  />
                </TabPanel>
                <TabPanel value="checks" className="p-3">
                  {state.findings.length === 0 ? (
                    <EmptyState
                      title="No findings on the last save"
                      description="Brand checks run on every save; blocking findings and warnings appear here."
                      className="py-4"
                    />
                  ) : (
                    <ul className="flex flex-col gap-2 text-sm" data-testid="findings">
                      {state.findings.map((f, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <Badge
                            tone={
                              f.severity === 'blocking'
                                ? 'critical'
                                : f.severity === 'warning'
                                  ? 'warning'
                                  : 'info'
                            }
                          >
                            {f.severity}
                          </Badge>
                          <span>{f.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabPanel>
                <TabPanel value="history" className="flex flex-col gap-4 p-3">
                  <HistoryPanel documentId={documentId} headRevisionId={state.committed.revisionId} />
                  <section aria-labelledby="exports-heading" className="flex flex-col gap-2">
                    <h2 id="exports-heading" className="text-sm font-semibold">
                      Exports
                    </h2>
                    <RenderPanel
                      documentId={documentId}
                      revisionId={state.committed.revisionId}
                      formatKey={page.formatKey}
                      hasLocalWork={dirty}
                    />
                  </section>
                </TabPanel>
              </Tabs>
            </section>
          </div>
        )}
      </main>

      {state.conflict && (
        <ConflictDialog
          conflict={state.conflict}
          doc={doc}
          templates={state.templates}
          onKeepServer={studio.keepServer}
          onKeepMine={studio.keepMine}
          onDiscardAll={studio.discardAll}
        />
      )}
      {studio.blocker.state === 'blocked' && (
        <LeaveDialog onStay={() => studio.blocker.reset?.()} onLeave={() => studio.blocker.proceed?.()} />
      )}
    </div>
  );
}
