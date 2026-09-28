import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AssetKind } from '@oremedia/contracts/assets';
import { useTRPCClient } from '../../lib/trpc';
import { newIntentKey, intentContext } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';

export type UploadStep =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string }
  | { kind: 'queued'; intentId: string }
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

/**
 * Spec 9.1: intent → PUT to the signed URL → complete; processing continues in the ingest workflow, so the asset
 * appears (approved, or pending review for someone without asset.approve) once scanning and derivatives finish.
 */
export function useAssetUpload(brandId: string) {
  const client = useTRPCClient();
  const [step, setStep] = useState<UploadStep>({ kind: 'idle' });
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
    onSuccess: (res) => setStep({ kind: 'queued', intentId: res.intentId }),
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
