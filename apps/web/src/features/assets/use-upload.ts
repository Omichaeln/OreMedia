import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetKind } from '@oremedia/contracts/assets';
import { useTRPC, useTRPCClient } from '../../lib/trpc';
import { newIntentKey, intentContext } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';

export type UploadStep =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string }
  /** Accepted by the API; the ingest workflow is scanning, sanitising and cataloguing (polled until it settles). */
  | { kind: 'queued'; intentId: string }
  | { kind: 'accepted'; intentId: string; assetId: string }
  /** `message` (BSC-2) says what was wrong and what to do; null for a reason the server has no words for. */
  | { kind: 'rejected'; intentId: string; reason: string; message: string | null }
  /** Still processing after the wait, or the status could not be read: the outcome is not known here. */
  | { kind: 'unsettled'; intentId: string; message: string }
  | { kind: 'failed'; message: string; details: string[] };

/** Browsers often report no type for font files; the extension names it (ingest checks the content either way). */
const FONT_MIMES: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};
const mimeFromName = (name: string): string =>
  FONT_MIMES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** How often the intent is read while the ingest workflow runs (it settles within seconds for an image). */
const INGEST_POLL_MS = 2_000;
/** After this long without an outcome the sheet stops polling and says so; the asset list still shows it when it lands. */
const INGEST_WAIT_MS = 5 * 60_000;

/**
 * Spec 9.1: intent → PUT to the signed URL → complete; processing continues in the ingest workflow, so the hook
 * reads the intent back until it is accepted (the asset id) or rejected (the reason), never leaving the person
 * with "processing" and no outcome (R1-B). On acceptance the asset lists are refetched.
 */
export function useAssetUpload(brandId: string, opts: { onAccepted?: (assetId: string) => void } = {}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<UploadStep>({ kind: 'idle' });
  const intentId = step.kind === 'queued' ? step.intentId : null;
  const [queuedAt, setQueuedAt] = useState(0);
  // The latest callback, read when the upload settles (the caller's closure may have changed since it started).
  const onAccepted = useRef(opts.onAccepted);
  useEffect(() => {
    onAccepted.current = opts.onAccepted;
  });
  const status = useQuery({
    ...trpc.assets.uploads.get.queryOptions({ intentId: intentId ?? '' }),
    enabled: intentId !== null,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false;
      const state = q.state.data?.state;
      if (state === 'accepted' || state === 'rejected') return false;
      return Date.now() - queuedAt > INGEST_WAIT_MS ? false : INGEST_POLL_MS;
    },
    retry: false,
  });
  useEffect(() => {
    if (intentId === null) return;
    if (status.isError) {
      setStep({ kind: 'unsettled', intentId, message: toUiError(status.error).message });
      return;
    }
    if (!status.data || status.data.intentId !== intentId) return;
    if (status.data.state === 'accepted' && status.data.assetId) {
      setStep({ kind: 'accepted', intentId, assetId: status.data.assetId });
      void queryClient.invalidateQueries(trpc.assets.pathFilter());
      onAccepted.current?.(status.data.assetId);
    } else if (status.data.state === 'rejected') {
      setStep({
        kind: 'rejected',
        intentId,
        reason: status.data.rejectionReason ?? 'rejected',
        message: status.data.rejectionMessage ?? null,
      });
    } else if (Date.now() - queuedAt > INGEST_WAIT_MS) {
      setStep({
        kind: 'unsettled',
        intentId,
        message:
          'Still processing after five minutes; it appears under All assets when the ingest workflow finishes.',
      });
    }
  }, [intentId, queuedAt, status.data, status.isError, status.error, queryClient, trpc]);
  const mutation = useMutation({
    mutationFn: async ({ file, kind }: { file: File; kind: AssetKind }) => {
      const mime = file.type || mimeFromName(file.name);
      const intent = await client.assets.uploads.createIntent.mutate(
        {
          brandId,
          kind,
          declaredMime: mime,
          declaredBytes: file.size,
          originalFilename: file.name,
        },
        intentContext(newIntentKey()),
      );
      const put = await fetch(intent.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': mime },
      });
      if (!put.ok) throw new Error(`Upload failed with HTTP ${put.status}`);
      return client.assets.uploads.complete.mutate(
        { intentId: intent.intentId },
        intentContext(newIntentKey()),
      );
    },
    onMutate: ({ file }) => setStep({ kind: 'uploading', name: file.name }),
    onSuccess: (res) => {
      setQueuedAt(Date.now());
      setStep({ kind: 'queued', intentId: res.intentId });
    },
    onError: (err) => {
      const ui = toUiError(err);
      setStep({
        kind: 'failed',
        message: ui.message,
        details: ui.details.map((d) => `${d.path ?? ''} ${d.issue}`.trim()),
      });
    },
  });
  return {
    step,
    pending: mutation.isPending,
    upload: (file: File, kind: AssetKind) => mutation.mutate({ file, kind }),
  };
}
