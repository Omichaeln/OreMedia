import { useEffect, useMemo, useState } from 'react';
import type { TrackItem } from '@oremedia/contracts/video';
import { Badge, Button, EmptyState, StatusBanner } from '@oremedia/ui';
import { Dialog, DialogActions, DialogContent } from '../../../components/dialog';
import { Tab, TabList, TabPanel, Tabs } from '../../../components/tabs';
import { useBrandVersion } from '../../brand/use-brand';
import { brandPath, useBrandContext } from '../../brand/brand-context';
import { useTheme } from '../../../lib/theme';
import { HistoryPanel } from '../history-panel';
import { LeaveDialog, SaveBanners, SaveIndicator } from '../save-indicator';
import { StudioBar } from '../studio-bar';
import { useDocumentFonts } from '../use-document-fonts';
import type { VideoDocumentDto } from '../types';
import { Inspector } from './inspector';
import { Library, mediaOfAsset } from './library';
import { ListEditor } from './list-editor';
import { PreviewPlayer } from './preview-player';
import { RecutPanel } from './recut-panel';
import { ScenesPanel } from './scenes-panel';
import { StoryboardPanel } from './storyboard-panel';
import { Timeline } from './timeline';
import { timecode } from './timecode';
import { useVideoSourceUrls, sourceIdsOf } from './use-video-media';
import { useVideoStudio } from './use-video-studio';
import { addAssetIntent, addCaptionIntent, addTitleIntent, itemLabel } from './video-actions';
import { VideoRenderPanel } from './video-render-panel';
import { hasLocalVideoWork } from './video-state';
import { useRevisionSnapshot } from './use-revision-snapshot';

const WIDE = '(min-width: 768px)';
function useWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof matchMedia === 'function' ? matchMedia(WIDE).matches : true,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** The save states the banners under the bar speak for (SaveBanners). */
const BANNER_SAVE_KINDS: ReadonlySet<string> = new Set(['failed', 'rebasing', 'conflict']);

/** Text fields keep their keys; the studio shortcuts apply elsewhere. */
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));
};

/**
 * The Studio for video documents (STU-2b): the preview player above the timeline editor (or, on narrow screens, the
 * list editor), the library and scenes on the left, the inspector and the checks, history and render panels on the
 * right. Edits are timeline operations through the same revision machinery as pages: autosave, rebase, undo and
 * redo as new revisions, restore of an earlier revision.
 */
export function VideoStudio({ documentId, initial }: { documentId: string; initial: VideoDocumentDto }) {
  const { companyId, brandId } = useBrandContext();
  const studio = useVideoStudio(documentId, initial);
  const { state, project } = studio;
  const { theme, toggle } = useTheme();
  const wide = useWide();
  const readOnly = false;
  const [replacing, setReplacing] = useState(false);
  const [restoreFrom, setRestoreFrom] = useState<string | null>(null);
  const dirty = hasLocalVideoWork(state);

  const brandVersion = useBrandVersion(brandId, project.brandVersionId);
  const colourTokens = useMemo(() => brandVersion.data?.document.tokens.colours ?? [], [brandVersion.data]);
  const colourMap = useMemo(() => new Map(colourTokens.map((c) => [c.key, c.value])), [colourTokens]);
  const fontRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const t of project.tracks) {
      if (t.kind === 'caption') refs.add(t.style.fontAssetVersionId);
      if (t.kind === 'overlay')
        for (const o of t.items) if (o.element.type === 'text') refs.add(o.element.style.fontAssetVersionId);
    }
    return [...refs].sort();
  }, [project]);
  const fontFamilyFor = useDocumentFonts(fontRefs);
  const urls = useVideoSourceUrls(
    useMemo(() => sourceIdsOf(project), [project]),
    state.media,
  );
  const resolverVersion = `${fontRefs.map(fontFamilyFor).join(',')}|${colourTokens.map((c) => c.key + c.value).join(',')}|${[...urls.values()].map((u) => u.image ?? '').join(',').length}`;

  const selected = useMemo(() => {
    if (!state.selection) return null;
    const track = project.tracks.find((t) => t.id === state.selection?.trackId);
    const item = (track?.items as TrackItem[] | undefined)?.find((i) => i.id === state.selection?.itemId);
    return track && item ? { track, item } : null;
  }, [project, state.selection]);
  const blocking = state.findings.filter((f) => f.severity === 'blocking').length;
  const restoreRevision = useRevisionSnapshot(documentId, restoreFrom);

  // Studio shortcuts: Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo, Ctrl+S saves now.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) studio.undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') studio.redo();
      else if (k === 's') void studio.saveNow();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [studio]);

  const add = (result: ReturnType<typeof addCaptionIntent>) => {
    if ('error' in result) studio.dispatch({ type: 'notice', notice: { tone: 'info', text: result.error } });
    else studio.applyIntent(result);
  };

  const inspector = (
    <Inspector
      project={project}
      media={state.media}
      track={selected?.track ?? null}
      item={selected?.item ?? null}
      playheadMs={state.playheadMs}
      readOnly={readOnly}
      colourTokens={colourTokens}
      replacing={replacing}
      onReplace={setReplacing}
      onIntent={studio.applyIntent}
      onDeselect={() => studio.select(null)}
    />
  );
  const library = (
    <Library
      readOnly={readOnly}
      replacing={
        replacing && selected && 'sourceInMs' in selected.item
          ? { label: itemLabel(selected.item), kind: selected.track.kind === 'audio' ? 'audio' : 'video' }
          : null
      }
      onPick={(asset) => {
        const info = mediaOfAsset(asset);
        studio.addMedia([info]);
        if (replacing && selected && 'sourceInMs' in selected.item) {
          setReplacing(false);
          studio.applyIntent({
            operations: [
              {
                op: 'replaceClipSource',
                trackId: selected.track.id,
                itemId: selected.item.id,
                assetVersionId: asset.assetVersionId,
              },
            ],
            summary: `Replace the source of ${itemLabel(selected.item)}`,
          });
          return;
        }
        const r = addAssetIntent(project, { ...info, name: asset.altText ?? asset.kind }, state.playheadMs);
        add(r);
      }}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="video-studio">
      <StudioBar
        back={{ to: brandPath(companyId, brandId, 'studio'), label: 'Studio', title: 'Back to the Studio' }}
        crumbs={[
          'Motion',
          <h1 key="title" className="truncate text-sm font-semibold" data-testid="document-title">
            {initial.title}
          </h1>,
        ]}
        status={
          <>
            <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {project.format.width}×{project.format.height} · {project.format.fps} fps ·{' '}
              {timecode(project.durationMs)}
            </span>
            <SaveIndicator
              save={state.save}
              revisionNumber={state.committed.number}
              onRetry={() => void studio.saveNow()}
            />
          </>
        }
        actions={
          <>
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
          </>
        }
      />

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
              title="A local change could not be applied"
              description={studio.localError}
            />
          )}
        </div>
      )}

      {/* The interface's video workspace: the library on the left, the monitor in the centre, the inspector and the
          video panels on the right, and the timeline across the full width below. Narrow screens stack the monitor,
          the list editor, the panels and then the library. */}
      <main
        id="main"
        className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[16rem_minmax(20rem,1fr)_17rem] md:grid-rows-[minmax(0,1fr)_auto] md:overflow-hidden xl:grid-cols-[16.25rem_minmax(24rem,1fr)_19.375rem]"
      >
        <section
          aria-labelledby="video-left-heading"
          className="order-4 flex min-h-72 min-w-0 flex-col border-t border-border bg-card md:order-1 md:min-h-0 md:border-r md:border-t-0"
          data-testid="video-left"
        >
          <h2 id="video-left-heading" className="sr-only">
            Library and scenes
          </h2>
          <Tabs defaultValue="library" className="flex min-h-0 flex-1 flex-col">
            <TabList label="Library and scenes" variant="pill">
              <Tab value="library" variant="pill">
                Library
              </Tab>
              <Tab value="scenes" variant="pill">
                Scenes
              </Tab>
            </TabList>
            <TabPanel value="library" className="p-2.5">
              {library}
            </TabPanel>
            <TabPanel value="scenes" className="p-2.5">
              <ScenesPanel
                project={project}
                playheadMs={state.playheadMs}
                readOnly={readOnly}
                onIntent={studio.applyIntent}
                onSeek={studio.setPlayhead}
              />
            </TabPanel>
          </Tabs>
        </section>

        <div className="order-1 flex min-w-0 flex-col bg-secondary p-4 md:order-2 md:min-h-0 md:overflow-auto">
          <PreviewPlayer
            project={project}
            media={state.media}
            urls={urls}
            fontFamilyFor={fontFamilyFor}
            colourFor={(t) => colourMap.get(t) ?? null}
            resolverVersion={resolverVersion}
            playheadMs={state.playheadMs}
            onSeek={studio.setPlayhead}
          />
        </div>

        <div
          className="order-3 flex min-h-0 min-w-0 flex-col border-t border-border bg-card md:border-l md:border-t-0"
          data-testid="video-right"
        >
          {wide && (
            <section
              aria-labelledby="inspector-heading"
              className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3 md:max-h-[55%] md:overflow-auto"
            >
              <h2 id="inspector-heading" className="text-sm font-medium">
                Inspector
              </h2>
              {inspector}
            </section>
          )}
          <section
            aria-labelledby="video-panels-heading"
            className="flex min-h-72 flex-1 flex-col md:min-h-0"
          >
            <h2 id="video-panels-heading" className="sr-only">
              Video panels
            </h2>
            <Tabs defaultValue="render" className="flex min-h-0 flex-1 flex-col">
              <TabList label="Video panels" variant="pill" className="flex-wrap">
                <Tab value="storyboard" variant="pill">
                  Storyboard
                </Tab>
                <Tab value="ai" variant="pill">
                  AI edit
                </Tab>
                <Tab value="render" variant="pill">
                  Render
                </Tab>
                <Tab value="checks" variant="pill">
                  Checks{' '}
                  {state.findings.length > 0 && (
                    <span className="ml-1 text-xs tabular-nums text-muted-foreground">
                      {state.findings.length}
                    </span>
                  )}
                </Tab>
                <Tab value="history" variant="pill">
                  History
                </Tab>
              </TabList>
              <TabPanel value="storyboard" className="overflow-auto p-3">
                <StoryboardPanel documentId={documentId} project={project} studio={studio} />
              </TabPanel>
              <TabPanel value="ai" className="overflow-auto p-3">
                <RecutPanel documentId={documentId} project={project} studio={studio} />
              </TabPanel>
              <TabPanel value="render" className="p-3">
                <VideoRenderPanel
                  documentId={documentId}
                  revisionId={state.committed.revisionId}
                  formatKey={project.format.key}
                  title={initial.title}
                  hasLocalWork={dirty}
                  blocking={blocking}
                />
              </TabPanel>
              <TabPanel value="checks" className="p-3">
                {state.findings.length === 0 ? (
                  <EmptyState
                    title="No findings on the last save"
                    description="Sources, captions and titles are checked on every save; blocking findings and warnings appear here."
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
                        <button
                          type="button"
                          className="text-left underline-offset-2 hover:underline"
                          onClick={() => {
                            const id = f.elementId;
                            const track = project.tracks.find((t) =>
                              (t.items as TrackItem[]).some((x) => x.id === id),
                            );
                            if (track && id) studio.select({ trackId: track.id, itemId: id });
                          }}
                        >
                          {f.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </TabPanel>
              <TabPanel value="history" className="flex flex-col gap-3 p-3">
                <HistoryPanel
                  documentId={documentId}
                  headRevisionId={state.committed.revisionId}
                  onRestore={dirty ? undefined : (id) => setRestoreFrom(id)}
                />
              </TabPanel>
            </Tabs>
          </section>
        </div>

        <div className="order-2 flex min-w-0 flex-col border-t border-border bg-card md:order-4 md:col-span-3 md:max-h-[45vh] md:overflow-auto">
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="mr-1.5 text-xs font-medium">{wide ? 'Timeline' : 'Sequence'}</span>
            <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Add to the video">
              <Button
                size="sm"
                disabledReason={readOnly ? 'Read only' : undefined}
                onClick={() => add(addCaptionIntent(project, state.playheadMs))}
                data-testid="add-caption"
              >
                + Caption
              </Button>
              <Button
                size="sm"
                disabledReason={readOnly ? 'Read only' : undefined}
                onClick={() => add(addTitleIntent(project, state.playheadMs))}
                data-testid="add-title"
              >
                + Title
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabledReason={readOnly ? 'Read only' : undefined}
                onClick={() => {
                  const end = project.tracks
                    .flatMap((t) =>
                      (t.items as TrackItem[]).map((i) =>
                        'endMs' in i ? i.endMs : i.startMs + i.sourceOutMs - i.sourceInMs,
                      ),
                    )
                    .reduce((a, b) => Math.max(a, b), 0);
                  const scenesEnd = project.scenes.reduce((a, s) => Math.max(a, s.endMs), 0);
                  const target = Math.max(1_000, end, scenesEnd);
                  if (target !== project.durationMs)
                    studio.applyIntent({
                      operations: [{ op: 'setDuration', durationMs: target }],
                      summary: 'Fit the length to the content',
                    });
                }}
              >
                Fit length to content
              </Button>
            </div>
          </div>
          <div className="p-3">
            {wide ? (
              <Timeline
                project={project}
                media={state.media}
                urls={urls}
                selection={state.selection}
                playheadMs={state.playheadMs}
                pendingItemIds={studio.pendingItemIds}
                readOnly={readOnly}
                onSelect={studio.select}
                onSeek={studio.setPlayhead}
                onIntent={studio.applyIntent}
              />
            ) : (
              <ListEditor
                project={project}
                selection={state.selection}
                readOnly={readOnly}
                onSelect={studio.select}
                onIntent={studio.applyIntent}
                inspector={inspector}
              />
            )}
          </div>
        </div>
      </main>

      {state.conflict && (
        <Dialog open onOpenChange={() => undefined}>
          <DialogContent
            role="alertdialog"
            title="Someone else changed this video"
            description={`Your ${state.conflict.localOps.length} unsaved change${state.conflict.localOps.length === 1 ? '' : 's'} touch items they also changed (${state.conflict.conflicts.map((c) => c.key).join(', ')}).`}
          >
            <DialogActions>
              <Button variant="primary" onClick={studio.keepMine}>
                Keep my changes
              </Button>
              <Button onClick={studio.keepServer}>Use their version</Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}
      {restoreFrom && (
        <Dialog open onOpenChange={(open) => !open && setRestoreFrom(null)}>
          <DialogContent
            title="Restore this revision?"
            description="Restoring makes a new revision with the earlier timeline; nothing in the history is lost and you can undo it."
          >
            {restoreRevision.isError && <StatusBanner tone="critical" title="Cannot read the revision" />}
            <DialogActions>
              <Button
                variant="primary"
                disabled={!restoreRevision.data}
                onClick={() => {
                  if (restoreRevision.data)
                    studio.restore(restoreRevision.data.snapshot, restoreRevision.data.number);
                  setRestoreFrom(null);
                }}
                data-testid="confirm-restore"
              >
                Restore revision {restoreRevision.data?.number ?? ''}
              </Button>
              <Button onClick={() => setRestoreFrom(null)}>Cancel</Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}
      {studio.blocker.state === 'blocked' && (
        <LeaveDialog onStay={() => studio.blocker.reset?.()} onLeave={() => studio.blocker.proceed?.()} />
      )}
    </div>
  );
}
