import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { changedElementIds, findElement } from '@oremedia/editor';
import { Badge, Button, EmptyState, Panel, StatusBanner } from '@oremedia/ui';
import { Tab, TabList, TabPanel, Tabs } from '../../components/tabs';
import { useBrandVersion } from '../brand/use-brand';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useAssetUrls } from '../assets/use-assets';
import { rememberDocument } from '../../lib/recent-documents';
import { useTheme } from '../../lib/theme';
import { AssetsPanel } from './assets-panel';
import { Canvas } from './canvas';
import { CommentsPanel } from './comments-panel';
import { diffDocuments } from './diff';
import { assetVersionIdsOf, fontRefsOf } from './document-helpers';
import { FormatStrip } from './format-strip';
import { HistoryPanel } from './history-panel';
import { LayersPanel } from './layers-panel';
import { PropertiesPanel } from './properties-panel';
import { ProposalPanel } from './proposal-panel';
import { RenderPanel } from './render-panel';
import { ConflictDialog, LeaveDialog, SaveIndicator } from './save-indicator';
import { hasLocalWork } from './studio-reducer';
import { TemplatesPanel } from './templates-panel';
import { useComments } from './use-document';
import { useDocumentFonts } from './use-document-fonts';
import { useStudio } from './use-studio';
import type { DocumentDto } from './types';

const devTools = (): boolean =>
  import.meta.env.DEV || new URLSearchParams(window.location.search).has('devtools');

type RightTab = 'agent' | 'comments' | 'checks' | 'history';

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
 * Spec 11.1 layout: header with company + brand; assets/templates/layers left; canvas centre; properties right with
 * the agent, comments, checks and history as tabs under them (the v3 prototype's arrangement); page strip bottom.
 */
export function Studio({ documentId, initial }: { documentId: string; initial: DocumentDto }) {
  const { companyId, companyName, brandId, brand } = useBrandContext();
  const studio = useStudio(documentId, initial);
  const { state, doc, page } = studio;
  const { theme, toggle } = useTheme();
  const readOnly = false;
  const [focusText, setFocusText] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [rightTab, setRightTab] = useState<RightTab>('agent');
  const comments = useComments(documentId);
  const openComments = (comments.data?.items ?? []).filter((c) => c.state !== 'resolved').length;

  useEffect(() => {
    rememberDocument({ companyId, brandId, documentId, title: initial.title });
  }, [companyId, brandId, documentId, initial.title]);

  const brandVersion = useBrandVersion(brandId, state.committed.snapshot.brandVersionId);
  const colourTokens = useMemo(() => brandVersion.data?.document.tokens.colours ?? [], [brandVersion.data]);
  const colourMap = useMemo(() => new Map(colourTokens.map((c) => [c.key, c.value])), [colourTokens]);
  const assetUrls = useAssetUrls(useMemo(() => assetVersionIdsOf(doc), [doc]));
  const fontFamilyFor = useDocumentFonts(useMemo(() => fontRefsOf(doc), [doc]));
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
  useEffect(() => {
    if (hasProposal) setRightTab('agent');
  }, [hasProposal]);

  const selectPage = (id: string) => {
    studio.setPage(id);
    canvasRef.current?.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus(); // managed focus on panel change
  };
  const deleteSelected = () => {
    const id = state.selection[0];
    const el = page && id ? findElement(page, id) : null;
    if (!page || !el || el.locked) return;
    studio.applyIntent({
      operations: [{ op: 'removeElement', pageId: page.id, elementId: el.id }],
      summary: `Remove ${el.name}`,
      origin: 'user',
    });
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
    <div className="flex h-full min-h-0 flex-col" data-testid="studio">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Link
            to={brandPath(companyId, brandId, 'home')}
            aria-label="Home"
            title="Back to the brand home"
            className="rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <span aria-hidden="true">←</span>
          </Link>
          <Link to={`/c/${encodeURIComponent(companyId)}`} className="truncate">
            {companyName ?? companyId}
          </Link>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <Link to={brandPath(companyId, brandId)} className="truncate font-medium">
            {brand.name}
          </Link>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <h1 className="truncate text-sm font-semibold" data-testid="document-title">
            {initial.title}
          </h1>
        </div>
        <SaveIndicator
          save={state.save}
          revisionNumber={state.committed.number}
          onRetry={() => void studio.saveNow()}
        />
        <div className="ml-auto flex flex-wrap items-center gap-1">
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
            disabledReason="Review requests arrive in Phase 5 (review and publication)"
          >
            Send for review
          </Button>
          <Button size="sm" variant="ghost" onClick={toggle} aria-pressed={theme === 'dark'}>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </Button>
        </div>
      </header>

      {state.notice && (
        <div className="px-3 pt-2">
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
        </div>
      )}
      {studio.localError && (
        <div className="px-3 pt-2">
          <StatusBanner
            tone="critical"
            title="A local change could not be rendered"
            description={studio.localError}
          />
        </div>
      )}
      {state.save.kind === 'failed' && (
        <div className="px-3 pt-2">
          <StatusBanner
            tone="critical"
            title="Autosave failed"
            description={`${state.save.error.message} Your changes are kept locally; retry when ready.`}
            actions={
              <Button size="sm" onClick={() => void studio.saveNow()}>
                Retry save
              </Button>
            }
          />
        </div>
      )}

      <main
        id="main"
        className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 md:grid-cols-[16rem_minmax(0,1fr)_22rem]"
      >
        <Panel
          title="Left panels"
          hideTitle
          className="min-h-48 md:min-h-0"
          bodyClassName="flex flex-col p-0"
        >
          <Tabs defaultValue="layers" className="flex min-h-0 flex-1 flex-col">
            <TabList label="Studio panels">
              <Tab value="layers">Layers</Tab>
              <Tab value="assets">Assets</Tab>
              <Tab value="templates">Templates</Tab>
            </TabList>
            <TabPanel value="layers">
              <LayersPanel
                page={page}
                selection={state.selection}
                onSelect={studio.select}
                onActivate={() => setFocusText((n) => n + 1)}
              />
            </TabPanel>
            <TabPanel value="assets">
              <AssetsPanel
                brandId={brandId}
                page={page}
                selection={state.selection}
                readOnly={readOnly}
                onIntent={studio.applyIntent}
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
              />
            </TabPanel>
          </Tabs>
        </Panel>

        <div
          ref={canvasRef}
          className="flex min-h-72 min-w-0 flex-col rounded-md border border-border md:min-h-0"
        >
          <Canvas
            doc={doc}
            page={page}
            selection={state.selection}
            readOnly={readOnly}
            onSelect={studio.select}
            onIntent={studio.applyIntent}
            onEditText={(id) => {
              studio.select([id]);
              setFocusText((n) => n + 1);
            }}
            onDeleteSelected={deleteSelected}
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

        <div className="flex min-h-0 flex-col gap-2">
          <Panel title="Properties" level={2} className="shrink-0 md:max-h-[45%] md:overflow-auto">
            <PropertiesPanel
              page={page}
              elementId={state.selection[0] ?? null}
              readOnly={readOnly}
              colourTokens={colourTokens}
              onIntent={studio.applyIntent}
              focusTextRequest={focusText}
            />
          </Panel>
          <Panel
            title="Document panels"
            hideTitle
            className="min-h-72 flex-1 md:min-h-0"
            bodyClassName="flex flex-col p-0"
          >
            <Tabs
              value={rightTab}
              onValueChange={(v) => setRightTab(v as RightTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabList label="Document panels" className="flex-wrap">
                <Tab value="agent">
                  Agent
                  {state.proposal && <TabCount n={1} label="proposal waiting" />}
                </Tab>
                <Tab value="comments">
                  Comments
                  <TabCount n={openComments} label="open" />
                </Tab>
                <Tab value="checks">
                  Checks
                  <TabCount n={state.findings.length} label="on the last save" />
                </Tab>
                <Tab value="history">History</Tab>
              </TabList>
              <TabPanel value="agent" className="flex flex-col gap-3 p-3">
                {state.proposal && proposalDiff ? (
                  <section aria-labelledby="proposal-heading" className="flex flex-col gap-2">
                    <h2 id="proposal-heading" className="text-sm font-semibold">
                      Agent proposal
                    </h2>
                    <ProposalPanel
                      proposal={state.proposal}
                      diff={proposalDiff}
                      headRevisionId={state.committed.revisionId}
                      hasLocalWork={dirty}
                      onAccept={studio.acceptProposal}
                      onModify={studio.modifyProposal}
                      onReject={studio.rejectProposal}
                    />
                  </section>
                ) : (
                  <EmptyState
                    title="No agent proposal"
                    description="Targeted change requests go through the same operation contract as your edits. An agent's change arrives here as a proposal you accept, modify or reject."
                    className="py-4"
                    action={
                      devTools() ? (
                        <Button
                          size="sm"
                          onClick={() => void studio.simulateProposal()}
                          data-testid="simulate-proposal"
                        >
                          Development only: simulate an agent proposal
                        </Button>
                      ) : undefined
                    }
                  />
                )}
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
          </Panel>
        </div>
      </main>

      {state.conflict && (
        <ConflictDialog
          conflict={state.conflict}
          doc={doc}
          onKeepServer={studio.keepServer}
          onDiscardAll={studio.discardAll}
        />
      )}
      {studio.blocker.state === 'blocked' && (
        <LeaveDialog onStay={() => studio.blocker.reset?.()} onLeave={() => studio.blocker.proceed?.()} />
      )}
    </div>
  );
}
