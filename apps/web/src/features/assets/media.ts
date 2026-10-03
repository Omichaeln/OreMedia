import {
  ACCEPTED_MIMES,
  KIND_MIME_GROUPS,
  PERSON_MEDIA_LIMITS,
  UPLOAD_CAPS_BYTES,
  type AssetKind,
} from '@oremedia/contracts/assets';

/**
 * STU-2a: what the upload sheet and the library say about video and audio. The limits come from the contracts the
 * server enforces (UPLOAD_CAPS_BYTES at intent, PERSON_MEDIA_LIMITS at ingest), so the hint and the refusal agree.
 */

/** A clock-style duration as players show it: 0:07, 1:05, 1:02:03. */
export function mediaClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const formatBytes = (n: number): string =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(n % 1024 ** 3 === 0 ? 0 : 1)} GB`
    : n >= 1024 ** 2
      ? `${Math.round(n / 1024 ** 2)} MB`
      : `${Math.max(1, Math.round(n / 1024))} kB`;

/** Browsers name some audio types differently from the accepted list; ingest sniffs the content either way. */
const MIME_ALIASES: Record<string, string> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-aac': 'audio/aac',
};
export const normaliseMediaMime = (mime: string): string => MIME_ALIASES[mime.toLowerCase()] ?? mime;

/** The `accept` list of the file input for a kind: the mimes ingest takes for it. */
export const acceptFor = (kind: AssetKind): string =>
  KIND_MIME_GROUPS[kind].flatMap((g) => ACCEPTED_MIMES[g] ?? []).join(',');

/** The largest file the kind accepts (the intent's cap), for a check before anything is uploaded. */
export const maxBytesFor = (kind: AssetKind): number =>
  Math.max(...KIND_MIME_GROUPS[kind].map((g) => UPLOAD_CAPS_BYTES[g] ?? 0));

/** The field hint under the file input, per kind. */
export function uploadHint(kind: AssetKind): string {
  if (kind === 'video')
    return `MP4, MOV or WebM (H.264, H.265, VP9, AV1 or ProRes), up to ${formatBytes(UPLOAD_CAPS_BYTES['video'] ?? 0)} and ${PERSON_MEDIA_LIMITS.durationSeconds.video / 60} minutes. Processing makes a poster, a thumbnail strip, an editing proxy and a waveform; it can take a few minutes.`;
  if (kind === 'audio')
    return `MP3, M4A, AAC or WAV, up to ${formatBytes(UPLOAD_CAPS_BYTES['audio'] ?? 0)} and ${PERSON_MEDIA_LIMITS.durationSeconds.audio / 60} minutes. Processing makes a listening proxy and a waveform.`;
  return 'Images, SVG, fonts and PDF; archives are rejected.';
}

export const isTimeBased = (kind: AssetKind | string): boolean => kind === 'video' || kind === 'audio';

/** What each ingest rejection means for the person who uploaded the file, and what to do about it. */
export const REJECTION_TEXT: Record<string, string> = {
  object_missing: 'The upload did not arrive. Try again.',
  exceeds_cap: 'The file is larger than this kind accepts.',
  type_unrecognised: 'The file type could not be recognised.',
  type_mismatch: 'The file content does not match the kind chosen.',
  declared_mime_mismatch: 'The file content is not the type its name says.',
  archive_rejected: 'Archives are not accepted; upload the files themselves.',
  malware_detected: 'The virus scanner flagged this file.',
  scanner_unavailable: 'The file is held until the virus scanner can check it.',
  duplicate_of: 'This exact file is already in the library.',
  format_unsupported: 'This format is not supported.',
  media_malformed:
    'The file is damaged or incomplete (for example an upload cut short). Export it again and upload the new file.',
  duration_exceeds_cap: 'The file is longer than the limit.',
  media_no_video_stream: 'The file has no video picture; upload it as audio, or choose a video file.',
  media_no_audio_stream: 'The file has no sound.',
  media_codec_unsupported: 'The file uses a codec that cannot be processed.',
  media_undecodable: 'The file could not be decoded.',
  media_frame_rate_unsupported:
    'The frame rate cannot be edited reliably; re-export at a constant frame rate (24, 25, 30 or 60 fps).',
  media_dimensions_unsupported: 'The picture size is outside what can be processed.',
  media_processing_failed: 'Processing failed. Try again; if it keeps failing, re-export the file.',
};

export const rejectionText = (reason: string): string =>
  REJECTION_TEXT[reason] ?? `The file was not catalogued (${reason.replaceAll('_', ' ')}).`;
