import type { VideoMediaInfo, VideoProjectV1 } from '@oremedia/contracts/video';
import type { VideoMediaLookup } from './reduce';

/**
 * A small 9:16 project for tests: three clips back to back on the video track (A 0-4 s, B 4-7 s with a 1 s
 * crossfade, C 7-10 s), music, a title overlay, two captions and two contiguous scenes. Sources: av_clip_a (6 s
 * video with sound), av_clip_b (5 s video, no sound), av_still (image), av_music (20 s audio).
 */
export const VIDEO_FIXTURE_MEDIA: Record<string, VideoMediaInfo> = {
  av_clip_a: {
    assetVersionId: 'av_clip_a',
    kind: 'video',
    mime: 'video/mp4',
    durationMs: 6_000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    derivatives: ['proxy', 'strip', 'strip_map', 'waveform'],
  },
  av_clip_b: {
    assetVersionId: 'av_clip_b',
    kind: 'video',
    mime: 'video/mp4',
    durationMs: 5_000,
    width: 1080,
    height: 1920,
    hasAudio: false,
    derivatives: ['proxy', 'strip', 'strip_map'],
  },
  av_still: {
    assetVersionId: 'av_still',
    kind: 'image',
    mime: 'image/png',
    durationMs: null,
    width: 1200,
    height: 800,
    hasAudio: false,
    derivatives: ['web'],
  },
  av_music: {
    assetVersionId: 'av_music',
    kind: 'audio',
    mime: 'audio/mpeg',
    durationMs: 20_000,
    width: null,
    height: null,
    hasAudio: true,
    derivatives: ['proxy', 'waveform'],
  },
};

export const videoFixtureLookup = (): VideoMediaLookup => VIDEO_FIXTURE_MEDIA;

export function fixtureVideoProject(): VideoProjectV1 {
  const frame = { fit: 'fill' as const, focalX: 0.5, focalY: 0.5, zoom: 1 };
  return {
    schemaVersion: 1,
    kind: 'video',
    brandVersionId: 'bv_1',
    format: { key: 'video_9x16', width: 1080, height: 1920, fps: 30 },
    durationMs: 10_000,
    tracks: [
      {
        id: 'trk_video',
        kind: 'video',
        name: 'Video',
        locked: false,
        muted: false,
        items: [
          {
            id: 'clip_a',
            name: 'A',
            assetVersionId: 'av_clip_a',
            sourceInMs: 1_000,
            sourceOutMs: 5_000,
            startMs: 0,
            frame,
            gainDb: 0,
            muted: false,
            locked: false,
          },
          {
            id: 'clip_b',
            name: 'B',
            assetVersionId: 'av_clip_b',
            sourceInMs: 0,
            sourceOutMs: 3_000,
            startMs: 4_000,
            frame,
            transitionIn: { kind: 'crossfade', durationMs: 1_000 },
            gainDb: 0,
            muted: false,
            locked: false,
          },
          {
            id: 'clip_c',
            name: 'C',
            assetVersionId: 'av_still',
            sourceInMs: 0,
            sourceOutMs: 3_000,
            startMs: 7_000,
            frame,
            gainDb: 0,
            muted: false,
            locked: false,
          },
        ],
      },
      {
        id: 'trk_titles',
        kind: 'overlay',
        name: 'Titles',
        locked: false,
        items: [
          {
            id: 'ov_title',
            startMs: 500,
            endMs: 3_500,
            enter: { kind: 'fade', durationMs: 500 },
            locked: false,
            element: {
              id: 'el_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              name: 'Title',
              type: 'text',
              locked: false,
              visible: true,
              opacity: 1,
              protected: false,
              transform: { x: 64, y: 300, width: 952, height: 200, rotation: 0 },
              text: 'Hello',
              factRefs: [],
              style: {
                typeRole: 'display',
                fontAssetVersionId: 'av_font',
                weight: 700,
                sizePx: 96,
                lineHeight: 1.1,
                tracking: 0,
                colourToken: 'ink',
                align: 'center',
                overflow: 'shrink_to_fit',
              },
            },
          },
        ],
      },
      {
        id: 'trk_captions',
        kind: 'caption',
        name: 'Captions',
        locked: false,
        style: {
          fontAssetVersionId: 'av_font',
          sizePx: 48,
          weight: 600,
          colourToken: 'paper',
          boxToken: 'ink',
          boxOpacity: 0.6,
          position: 'bottom',
        },
        items: [
          { id: 'cap_1', startMs: 0, endMs: 2_000, text: 'First caption', locked: false },
          { id: 'cap_2', startMs: 2_000, endMs: 4_000, text: 'Second caption', locked: false },
        ],
      },
      {
        id: 'trk_music',
        kind: 'audio',
        name: 'Music',
        locked: false,
        muted: false,
        items: [
          {
            id: 'aud_1',
            assetVersionId: 'av_music',
            sourceInMs: 0,
            sourceOutMs: 10_000,
            startMs: 0,
            gainDb: -6,
            fadeInMs: 500,
            fadeOutMs: 1_000,
            muted: false,
            locked: false,
          },
        ],
      },
    ],
    scenes: [
      { id: 'scene_1', title: 'Opening', startMs: 0, endMs: 4_000 },
      { id: 'scene_2', title: 'Middle', startMs: 4_000, endMs: 10_000 },
    ],
  };
}
