import { IMAGE_CREATIVE_KINDS, type AssetKind } from '@oremedia/contracts/assets';
import type { BrandSnapshot } from '@oremedia/contracts/brand';
import {
  CreativeDocumentV1,
  OperationBatch,
  type DocumentKind,
  type Element,
} from '@oremedia/contracts/creative';
import {
  VideoOperationBatch,
  VideoProjectV1,
  type TrackItem,
  type VideoMediaInfo,
  type VideoOperation,
} from '@oremedia/contracts/video';
import type { Tx } from '@oremedia/db';
import { newElementId } from '@oremedia/domain/ids';
import type { VideoBrandBindings, VideoMediaLookup } from '@oremedia/editor/video/index';

/**
 * STU-2b support for video documents in the creative module: the assets hook the module reads sources through, the
 * asset references a timeline operation introduces (each with the kinds its place accepts), and the brand bindings
 * a starter template is instantiated with. Kept beside service.ts so the service stays one flow per procedure.
 */

/** What the creative module asks the assets module about sources (registered by the composition root). */
export interface CreativeAssetCatalog {
  /** Kind, duration, size, sound and derivatives of each asset version found in the tenant. */
  mediaInfo(assetVersionIds: readonly string[], tx?: Tx): Promise<VideoMediaInfo[]>;
  /** The current version of each asset (brand fonts and logos are recorded by asset in the brand system). */
  currentVersionIds(assetIds: readonly string[], tx?: Tx): Promise<Record<string, string>>;
}
const unregisteredCatalog: CreativeAssetCatalog = {
  mediaInfo: async () => {
    throw new Error('asset catalog not registered (composition root must call registerCreativeAssetCatalog)');
  },
  currentVersionIds: async () => {
    throw new Error('asset catalog not registered (composition root must call registerCreativeAssetCatalog)');
  },
};
let catalog: CreativeAssetCatalog = unregisteredCatalog;
export const registerCreativeAssetCatalog = (c: CreativeAssetCatalog): void => {
  catalog = c;
};
export const assetCatalog = (): CreativeAssetCatalog => catalog;

export async function mediaLookup(ids: readonly string[], tx?: Tx): Promise<Record<string, VideoMediaInfo>> {
  if (!ids.length) return {};
  return Object.fromEntries((await catalog.mediaInfo(ids, tx)).map((m) => [m.assetVersionId, m]));
}
export const asLookup = (m: Record<string, VideoMediaInfo>): VideoMediaLookup => m;

/** A use of an asset version: the eligibility purpose and the kinds its place in the document accepts. */
export interface KindedAssetRef {
  assetVersionId: string;
  purpose: 'creative' | 'font';
  kinds?: readonly AssetKind[];
}

/** Picture track sources: a video, or a still image. Audio track sources: audio, or a video's sound. */
const PICTURE_KINDS: readonly AssetKind[] = ['video', ...IMAGE_CREATIVE_KINDS];
const SOUND_KINDS: readonly AssetKind[] = ['audio', 'video'];

/** Graphic layers (in graphic documents and in video overlays): still images only, text fonts as fonts. */
export function elementAssetRefs(elements: readonly Element[]): KindedAssetRef[] {
  const out: KindedAssetRef[] = [];
  for (const el of elements) {
    if (el.type === 'image' || el.type === 'logo')
      out.push({ assetVersionId: el.assetVersionId, purpose: 'creative', kinds: IMAGE_CREATIVE_KINDS });
    else if (el.type === 'background' && el.assetVersionId)
      out.push({ assetVersionId: el.assetVersionId, purpose: 'creative', kinds: IMAGE_CREATIVE_KINDS });
    else if (el.type === 'text') out.push({ assetVersionId: el.style.fontAssetVersionId, purpose: 'font' });
    else if (el.type === 'group') out.push(...elementAssetRefs(el.children));
  }
  return out;
}

const trackItemRefs = (kind: string, items: readonly TrackItem[]): KindedAssetRef[] =>
  items.flatMap((i): KindedAssetRef[] => {
    if ('assetVersionId' in i)
      return [
        {
          assetVersionId: i.assetVersionId,
          purpose: 'creative',
          kinds: kind === 'audio' ? SOUND_KINDS : PICTURE_KINDS,
        },
      ];
    if ('element' in i) return elementAssetRefs([i.element]);
    return [];
  });

/** The asset versions an operation introduces into the project (guardAssets for timelines). */
export function videoOpAssetRefs(
  op: VideoOperation,
  trackKindOf: (trackId: string) => string | undefined,
): KindedAssetRef[] {
  switch (op.op) {
    case 'insertClip':
      return trackItemRefs(trackKindOf(op.trackId) ?? 'video', [op.item as TrackItem]);
    case 'replaceClipSource':
      return trackItemRefs(trackKindOf(op.trackId) ?? 'video', [
        { assetVersionId: op.assetVersionId } as TrackItem,
      ]);
    case 'setOverlay':
      return elementAssetRefs([op.overlay.element]);
    case 'setCaptionStyle':
      return [{ assetVersionId: op.style.fontAssetVersionId, purpose: 'font' }];
    case 'addTrack': {
      const refs = trackItemRefs(op.track.kind, op.track.items as TrackItem[]);
      if (op.track.kind === 'caption')
        refs.push({ assetVersionId: op.track.style.fontAssetVersionId, purpose: 'font' });
      return refs;
    }
    default:
      return [];
  }
}

/** Every asset version a project references (document creation, render pinning). */
export function projectAssetRefs(project: VideoProjectV1): KindedAssetRef[] {
  return project.tracks.flatMap((t) => [
    ...trackItemRefs(t.kind, t.items as TrackItem[]),
    ...(t.kind === 'caption'
      ? [{ assetVersionId: t.style.fontAssetVersionId, purpose: 'font' as const }]
      : []),
  ]);
}

/** Timed sources (clips and audio) of a project: the ones the reducer and validation need media info for. */
export const timedAssetIds = (project: VideoProjectV1): string[] => [
  ...new Set(
    project.tracks.flatMap((t) =>
      t.kind === 'video' || t.kind === 'audio' ? t.items.map((i) => i.assetVersionId) : [],
    ),
  ),
];

/** One authorisation per (purpose, kinds, version). */
export function distinctKindedRefs(refs: readonly KindedAssetRef[]): KindedAssetRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.purpose}:${(r.kinds ?? []).join(',')}:${r.assetVersionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A template's brand bindings from the published snapshot: each type role's font (current version of the brand's
 * font asset), colour tokens by role (text on video takes the background colour, the caption box the text colour,
 * so captions read light on dark like broadcast captions), and the primary logo.
 */
export async function brandBindings(snapshot: BrandSnapshot, tx: Tx): Promise<VideoBrandBindings> {
  const doc = snapshot.document;
  const primaryLogo =
    doc.logoRules.find((r) => r.variant === 'primary') ?? doc.logoRules.find(() => true) ?? null;
  const assetIds = [
    ...new Set([
      ...doc.tokens.typeRoles.map((t) => t.fontAssetId),
      ...(primaryLogo ? [primaryLogo.assetId] : []),
    ]),
  ];
  const current = assetIds.length ? await catalog.currentVersionIds(assetIds, tx) : {};
  const fonts: VideoBrandBindings['fonts'] = {};
  for (const t of doc.tokens.typeRoles) {
    const v = current[t.fontAssetId];
    if (v && !fonts[t.role]) fonts[t.role] = v;
  }
  const byRole = (role: string) => doc.tokens.colours.find((c) => c.role === role)?.key;
  return {
    brandVersionId: snapshot.brandVersionId,
    fonts,
    colours: {
      ...((byRole('background') ?? byRole('neutral'))
        ? { text: byRole('background') ?? byRole('neutral') }
        : {}),
      ...(byRole('text') ? { box: byRole('text') } : {}),
      ...((byRole('accent') ?? byRole('primary')) ? { accent: byRole('accent') ?? byRole('primary') } : {}),
    },
    ...(primaryLogo && current[primaryLogo.assetId]
      ? { logoAssetVersionId: current[primaryLogo.assetId] }
      : {}),
    newElementId,
  };
}

// ---- snapshots by document kind (spec 6.1: JSON documents are validated on read as on write) ------------------

export type ParsedSnapshot =
  { kind: 'graphic'; snapshot: CreativeDocumentV1 } | { kind: 'video'; snapshot: VideoProjectV1 };

/** A revision snapshot read as its document's kind: graphic documents never parse as video, and the reverse. */
export function parseSnapshot(kind: DocumentKind, json: unknown): ParsedSnapshot {
  return kind === 'video'
    ? { kind, snapshot: VideoProjectV1.parse(json) }
    : { kind, snapshot: CreativeDocumentV1.parse(json) };
}

export function parseRevisionContent(kind: DocumentKind, operations: unknown, snapshot: unknown) {
  return kind === 'video'
    ? {
        kind: 'video' as const,
        operations: VideoOperationBatch.parse(operations),
        snapshot: VideoProjectV1.parse(snapshot),
      }
    : {
        kind: 'graphic' as const,
        operations: OperationBatch.parse(operations),
        snapshot: CreativeDocumentV1.parse(snapshot),
      };
}
