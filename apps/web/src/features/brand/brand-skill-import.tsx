import { useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { Panel, StatusBanner } from '@oremedia/ui';
import { useBrandContext } from './brand-context';
import { useTRPC, type Trpc } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { isZipFileName, readZip, ZipReadError } from '../../lib/unzip';

type ImportResult = inferOutput<Trpc['brand']['guidelines']['import']>;

const TEXT_FILE = /\.(md|markdown|txt)$/i;

const MAX_FILES = 100;

/** A picked file's path inside the package: the folder-relative path of a directory pick, else its name. */
const pathOf = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

const ARCHIVE_MESSAGE: Record<ZipReadError['reason'], string> = {
  not_an_archive: 'is not a zip archive; a .skill package is one',
  unsupported_archive: 'is a zip64 archive, which is not supported; re-export the skill as a plain zip',
  unsupported_entry: 'has an encrypted or unusually compressed entry; re-export the skill without a password',
};

/**
 * The files to send for what was picked: a `.skill` or `.zip` package is unpacked in the browser into its entries
 * (a `.skill` exported from Claude is a zip of SKILL.md and its references); every other pick is sent as it is.
 */
async function packageFiles(picked: File[]): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const f of picked) {
    if (isZipFileName(f.name)) {
      let entries;
      try {
        entries = await readZip(await f.arrayBuffer());
      } catch (err) {
        throw new Error(
          `${f.name} ${err instanceof ZipReadError ? ARCHIVE_MESSAGE[err.reason] : 'could not be read'}.`,
        );
      }
      const text = new TextDecoder();
      for (const e of entries)
        files.push({ path: e.path, content: TEXT_FILE.test(e.path) ? text.decode(e.bytes) : '' });
    } else {
      files.push({ path: pathOf(f), content: TEXT_FILE.test(f.name) ? await f.text() : '' });
    }
  }
  return files.slice(0, MAX_FILES);
}

/**
 * Spec 8.2 brand skill import: pick the skill's folder (SKILL.md, references/, assets/), its files, or the `.skill`
 * package Claude exports. Text files are read in the browser and sent; other files are sent by name only so the
 * result can say they were skipped. The server creates a new draft carrying the guidelines and the palette its
 * tables state; a second person publishes.
 */
export function BrandSkillImport() {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [result, setResult] = useState<ImportResult | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const importSkill = useMutation(
    trpc.brand.guidelines.import.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setResult(res);
        void queryClient.invalidateQueries(trpc.brand.pathFilter());
      },
    }),
  );
  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(e.target.files ?? [])];
    e.target.value = '';
    if (picked.length === 0) return;
    setResult(null);
    setReadError(null);
    let files: Array<{ path: string; content: string }>;
    try {
      files = await packageFiles(picked);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err));
      return;
    }
    importSkill.mutate({ brandId, files });
  };
  const error = importSkill.isError ? toUiError(importSkill.error) : null;
  return (
    <Panel title="Import a brand skill">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          A brand skill made in Claude or elsewhere (a <code>.skill</code> package, or a folder with SKILL.md
          and references) becomes a new draft: its text is kept as the brand guidelines agents follow, and the
          colours in its tables are added to the palette. Someone other than you publishes it.
        </p>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-md border border-border bg-secondary px-2.5 py-1.5 hover:bg-muted">
            Choose skill folder
            <input
              type="file"
              className="sr-only"
              onChange={(e) => void onFiles(e)}
              disabled={importSkill.isPending}
              {...{ webkitdirectory: '', directory: '' }}
            />
          </label>
          <label className="inline-flex cursor-pointer items-center rounded-md border border-border bg-secondary px-2.5 py-1.5 hover:bg-muted">
            Choose package or files
            <input
              type="file"
              multiple
              accept=".skill,.zip,.md,.markdown,.txt"
              className="sr-only"
              onChange={(e) => void onFiles(e)}
              disabled={importSkill.isPending}
            />
          </label>
        </div>
        {importSkill.isPending && <StatusBanner tone="info" busy title="Importing the brand skill" />}
        {readError && <StatusBanner tone="critical" title="Not imported" description={readError} />}
        {error && (
          <StatusBanner
            tone="critical"
            title="Not imported"
            description={[
              error.message,
              ...error.details.map((d) => `${d.path ?? ''} ${d.issue}`.trim()),
            ].join(' · ')}
          />
        )}
        {result && (
          <StatusBanner
            tone="good"
            title={`Draft version ${result.number} created from ${result.source.name}`}
            description={
              <>
                {result.documents.length} guideline document{result.documents.length === 1 ? '' : 's'} kept,{' '}
                {result.coloursAdded} colour{result.coloursAdded === 1 ? '' : 's'} added to the palette.
                Review it below: an agent can extract its voice and vocabulary from the guidelines. Then
                submit it for review; a different person publishes it.
                {result.skipped.length > 0 && (
                  <span className="mt-1 block">
                    Not imported: {result.skipped.map((s) => s.path).join(', ')}. Upload logos and images in
                    the brand kit.
                  </span>
                )}
              </>
            }
          />
        )}
      </div>
    </Panel>
  );
}
