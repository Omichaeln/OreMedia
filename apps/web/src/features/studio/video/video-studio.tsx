import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { TrackItem } from '@oremedia/contracts/video';
import { Badge, Button, EmptyState, Panel, StatusBanner } from '@oremedia/ui';
import { Dialog, DialogActions, DialogContent } from '../../../components/dialog';
import { Tab, TabList, TabPanel, Tabs } from '../../../components/tabs';
import { useBrandVersion } from '../../brand/use-brand';
import { brandPath, useBrandContext } from '../../brand/brand-context';
import { useTheme } from '../../../lib/theme';
import { HistoryPanel } from '../history-panel';
import { LeaveDialog, SaveIndicator } from '../save-indicator';
import { useDocumentFonts } from '../use-document-fonts';
import type { VideoDocumentDto } from '../types';
import { Inspector } from './inspector';
import { Library, mediaOfAsset } from './library';
import { ListEditor } from './list-editor';
import { PreviewPlayer } from './preview-player';
import { ScenesPanel } from './scenes-panel';
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
  const { companyId, companyName, brandId, brand } = useBrandContext();
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
    <div className="flex h-full min-h-0 flex-col" data-testid="video-studio">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Link
            to={brandPath(companyId, brandId, 'studio')}
            aria-label="Studio"
            title="Back to the Studio documents"
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
          <Badge glyph={false}>
            Video · {project.format.width}×{project.format.height} · {project.format.fps} fps ·{' '}
            {timecode(project.durationMs)}
          </Badge>
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
            title="A local change could not be applied"
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
        className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2 md:grid-cols-[16rem_minmax(20rem,1fr)_20rem] xl:grid-cols-[18rem_minmax(24rem,1fr)_24rem]"
      >
        <Panel
          title="Library and scenes"
          hideTitle
          className="order-3 md:order-1"
          bodyClassName="flex flex-col p-0"
          data-testid="video-left"
        >
          <Tabs defaultValue="library" className="flex min-h-0 flex-1 flex-col">
            <TabList label="Library and scenes">
              <Tab value="library">Library</Tab>
              <Tab value="scenes">Scenes</Tab>
            </TabList>
            <TabPanel value="library" className="p-2">
              {library}
            </TabPanel>
            <TabPanel value="scenes" className="p-2">
              <ScenesPanel
                project={project}
                playheadMs={state.playheadMs}
                readOnly={readOnly}
                onIntent={studio.applyIntent}
                onSeek={studio.setPlayhead}
              />
            </TabPanel>
          </Tabs>
        </Panel>

        <div className="order-1 flex min-w-0 flex-col gap-2 md:order-2">
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
          <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Add to the video">
            <Button
              size="sm"
              disabledReason={readOnly ? 'Read only' : undefined}
              onClick={() => add(addCaptionIntent(project, state.playheadMs))}
              data-testid="add-caption"
            >
              Add caption
            </Button>
            <Button
              size="sm"
              disabledReason={readOnly ? 'Read only' : undefined}
              onClick={() => add(addTitleIntent(project, state.playheadMs))}
              data-testid="add-title"
            >
              Add title
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

        <div className="order-2 flex min-h-0 flex-col gap-2 md:order-3" data-testid="video-right">
          {wide && (
            <Panel title="Inspector" level={2} className="shrink-0 md:max-h-[55%] md:overflow-auto">
              {inspector}
            </Panel>
          )}
          <Panel
            title="Video panels"
            hideTitle
            className="min-h-72 flex-1 md:min-h-0"
            bodyClassName="flex flex-col p-0"
          >
            <Tabs defaultValue="render" className="flex min-h-0 flex-1 flex-col">
              <TabList label="Video panels" className="flex-wrap">
                <Tab value="render">Render</Tab>
                <Tab value="checks">
                  Checks{' '}
                  {state.findings.length > 0 && (
                    <span className="ml-1 text-xs tabular-nums text-muted-foreground">
                      {state.findings.length}
                    </span>
                  )}
                </Tab>
                <Tab value="history">History</Tab>
              </TabList>
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
          </Panel>
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
