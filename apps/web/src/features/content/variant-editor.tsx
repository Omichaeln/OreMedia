import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { sameIdSet } from './content-helpers';
import type { PackageDocumentDto, PackageVariantDto } from './use-content';

export interface VariantEditorProps {
  variant: PackageVariantDto;
  /** The revision's pinned documents with their ready exports: the only media a variant may select. */
  documents: readonly PackageDocumentDto[];
  onDone: () => void;
}

/** Provider settings are a JSON object per channel capability; anything else is refused before it is sent. */
export function parseSettings(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

const PUBLISH_MODE_OPTIONS = [
  { value: 'draft', label: 'Draft on the website (preview first)' },
  { value: 'publish', label: 'Live page (only when the connection allows it)' },
];

/**
 * Spec 14.1 channel variant editing: caption, alt texts (one per line, in media order), provider settings and the
 * media selection from the pinned revisions' ready exports. The server re-runs the channel capability check on
 * every save and stores the findings, so the "Valid" badge is never stale after an edit. A website variant (R2-3)
 * carries the revision's article instead: the only setting is whether it lands as a draft or a live page (D-16:
 * draft by default), and it has no media or alt texts.
 */
export function VariantEditor({ variant, documents, onDone }: VariantEditorProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [text, setText] = useState(variant.text);
  const [altTexts, setAltTexts] = useState(variant.altTexts.join('\n'));
  const [settings, setSettings] = useState(
    Object.keys(variant.settings).length ? JSON.stringify(variant.settings, null, 2) : '',
  );
  const [exportIds, setExportIds] = useState<string[]>(variant.exportIds);
  const [publishMode, setPublishMode] = useState(
    variant.settings['publishMode'] === 'publish' ? 'publish' : 'draft',
  );
  const [error, setError] = useState<string | null>(null);
  const website = variant.destinationId !== null;
  const update = useMutation(
    trpc.content.variants.update.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.content.pathFilter());
        onDone();
      },
    }),
  );
  const options = documents.flatMap((d) => d.exports.map((e) => ({ document: d, export: e })));
  const toggle = (id: string) =>
    setExportIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const parsedSettings = parseSettings(settings);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (website) {
      update.mutate({
        channelVariantId: variant.id,
        expectedVersion: variant.version,
        text: variant.text,
        altTexts: [],
        settings: { publishMode },
        exportIds: [],
      });
      return;
    }
    const parsed = parsedSettings;
    if (!parsed.ok) {
      setError('Provider settings must be a JSON object, for example {"firstComment": "…"}.');
      return;
    }
    setError(null);
    update.mutate({
      channelVariantId: variant.id,
      expectedVersion: variant.version,
      text,
      altTexts: altTexts
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      settings: parsed.value,
      exportIds,
    });
  };
  const ui = update.isError ? toUiError(update.error) : null;
  const unchanged = website
    ? publishMode === (variant.settings['publishMode'] === 'publish' ? 'publish' : 'draft')
    : text === variant.text &&
      altTexts === variant.altTexts.join('\n') &&
      sameIdSet(exportIds, variant.exportIds) &&
      parsedSettings.ok &&
      JSON.stringify(parsedSettings.value) === JSON.stringify(variant.settings);
  if (website)
    return (
      <form
        onSubmit={submit}
        className="flex flex-col gap-2 rounded-md border border-border p-3"
        aria-label={`Edit variant ${variant.id}`}
        data-testid="variant-editor"
        noValidate
      >
        <Field
          label="Publish mode"
          htmlFor={`variant-${variant.id}-mode`}
          hint="Every write lands as a draft unless the website connection was granted live publishing; the server refuses the rest."
        >
          <Select
            id={`variant-${variant.id}-mode`}
            value={publishMode}
            onValueChange={setPublishMode}
            options={PUBLISH_MODE_OPTIONS}
          />
        </Field>
        {ui && ui.kind === 'forbidden' && (
          <StatusBanner
            tone="critical"
            title="Permission denied"
            description={`${ui.message} Editing a variant needs content.edit on a draft revision.`}
          />
        )}
        {ui && ui.kind !== 'forbidden' && (
          <RequestError error={update.error} title="The variant was not saved" />
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={update.isPending || unchanged}
            disabledReason={unchanged ? 'Nothing has changed' : undefined}
          >
            {update.isPending ? 'Saving…' : 'Save variant'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    );
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      aria-label={`Edit variant ${variant.id}`}
      data-testid="variant-editor"
      noValidate
    >
      <Field label="Caption" htmlFor={`variant-${variant.id}-text`}>
        <Textarea
          id={`variant-${variant.id}-text`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-muted-foreground">
          Media (ready exports of the pinned creative revisions, in selection order)
        </legend>
        {options.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No ready exports yet. Render the pinned documents in the studio, then choose them here.
          </p>
        )}
        {options.map(({ document, export: e }) => (
          <label key={e.exportId} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={exportIds.includes(e.exportId)}
              onChange={() => toggle(e.exportId)}
            />
            <span>
              {document.title} · {e.formatKey} {e.width}×{e.height}
              {document.stale ? ' · pinned revision is stale' : ''}
            </span>
          </label>
        ))}
      </fieldset>
      <Field
        label="Alt texts"
        htmlFor={`variant-${variant.id}-alt`}
        hint="One line per selected media item, in the same order."
      >
        <Textarea
          id={`variant-${variant.id}-alt`}
          value={altTexts}
          onChange={(e) => setAltTexts(e.target.value)}
          rows={2}
        />
      </Field>
      <Field
        label="Provider settings (JSON)"
        htmlFor={`variant-${variant.id}-settings`}
        hint="Channel-specific options the capability check understands; leave empty for none."
        error={error ?? undefined}
      >
        <Input
          id={`variant-${variant.id}-settings`}
          value={settings}
          onChange={(e) => setSettings(e.target.value)}
          placeholder='{"firstComment": "Shop now"}'
        />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Editing a variant needs content.edit on a draft revision.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={update.error} title="The variant was not saved" />
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={update.isPending || unchanged}
          disabledReason={unchanged ? 'Nothing has changed' : undefined}
        >
          {update.isPending ? 'Saving…' : 'Save variant'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
