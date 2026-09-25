import { useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { Panel, StatusBanner } from '@oremedia/ui';
import { useBrandContext } from './brand-context';
import { useTRPC, type Trpc } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';

type ImportResult = inferOutput<Trpc['brand']['guidelines']['import']>;

const TEXT_FILE = /\.(md|markdown|txt)$/i;

/** A picked file's path inside the package: the folder-relative path of a directory pick, else its name. */
const pathOf = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

/**
 * Spec 8.2 brand skill import: pick the skill's folder (SKILL.md, references/, assets/) or its files. Text files are
 * read in the browser and sent; other files are sent by name only so the result can say they were skipped. The
 * server creates a new draft carrying the guidelines and the palette its tables state; a second person publishes.
 */
export function BrandSkillImport() {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [result, setResult] = useState<ImportResult | null>(null);
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
    const files = await Promise.all(
      picked.slice(0, 100).map(async (f) => ({
        path: pathOf(f),
        content: TEXT_FILE.test(f.name) ? await f.text() : '',
      })),
    );
    importSkill.mutate({ brandId, files });
  };
  const error = importSkill.isError ? toUiError(importSkill.error) : null;
  return (
    <Panel title="Import a brand skill">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          A brand skill made in Claude or elsewhere (a folder with SKILL.md and references) becomes a new
          draft: its text is kept as the brand guidelines agents follow, and the colours in its tables are
          added to the palette. Someone other than you publishes it.
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
            Choose files
            <input
              type="file"
              multiple
              accept=".md,.markdown,.txt"
              className="sr-only"
              onChange={(e) => void onFiles(e)}
              disabled={importSkill.isPending}
            />
          </label>
        </div>
        {importSkill.isPending && <StatusBanner tone="info" busy title="Importing the brand skill" />}
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
                Review it below, then submit it for review; a different person publishes it.
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
