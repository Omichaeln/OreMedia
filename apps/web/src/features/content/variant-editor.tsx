import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { SchemaFields, briefFromValues, type BriefValues, type ObjectSchema } from '../agents/schema-fields';
import { sameIdSet } from './content-helpers';
import type { PackageDocumentDto, PackageVariantDto } from './use-content';

export interface VariantEditorProps {
  variant: PackageVariantDto;
  /** The revision's pinned documents with their ready exports: the only media a variant may select. */
  documents: readonly PackageDocumentDto[];
  /** The channel capability's settings schema (RA-07), rendered as fields; null when the channel takes none. */
  settingsSchema: Record<string, unknown> | null;
  onDone: () => void;
}

/** The channel's stored settings as the schema form edits them: scalars as text, missing keys left empty. */
export function settingsValues(settings: Record<string, unknown>): BriefValues {
  const values: BriefValues = {};
  for (const [key, v] of Object.entries(settings))
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values[key] = String(v);
  return values;
}

const PUBLISH_MODE_OPTIONS = [
  { value: 'draft', label: 'Draft on the website (preview first)' },
  { value: 'publish', label: 'Live page (only when the connection allows it)' },
];

/**
 * Spec 14.1 channel variant editing: caption, alt texts (one per line, in media order), the channel's settings as
 * the fields its capability describes (RA-07: never JSON) and the media selection from the pinned revisions' ready
 * exports. The server re-runs the channel capability check on
 * every save and stores the findings, so the "Valid" badge is never stale after an edit. A website variant (R2-3)
 * carries the revision's article instead: the only setting is whether it lands as a draft or a live page (D-16:
 * draft by default), and it has no media or alt texts.
 */
export function VariantEditor({ variant, documents, settingsSchema, onDone }: VariantEditorProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [text, setText] = useState(variant.text);
  const [altTexts, setAltTexts] = useState(variant.altTexts.join('\n'));
  const schema = (settingsSchema ?? {}) as ObjectSchema;
  const [settings, setSettings] = useState<BriefValues>(() => settingsValues(variant.settings));
  const [settingsErrors, setSettingsErrors] = useState<Record<string, string>>({});
  const [exportIds, setExportIds] = useState<string[]>(variant.exportIds);
  const [publishMode, setPublishMode] = useState(
    variant.settings['publishMode'] === 'publish' ? 'publish' : 'draft',
  );
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
  const built = briefFromValues(schema, settings);
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
    setSettingsErrors(built.errors);
    if (Object.keys(built.errors).length > 0) return;
    update.mutate({
      channelVariantId: variant.id,
      expectedVersion: variant.version,
      text,
      altTexts: altTexts
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      settings: built.brief,
      exportIds,
    });
  };
  const ui = update.isError ? toUiError(update.error) : null;
  const unchanged = website
    ? publishMode === (variant.settings['publishMode'] === 'publish' ? 'publish' : 'draft')
    : text === variant.text &&
      altTexts === variant.altTexts.join('\n') &&
      sameIdSet(exportIds, variant.exportIds) &&
      JSON.stringify(built.brief) === JSON.stringify(variant.settings);
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
      <fieldset className="flex flex-col gap-2" data-testid="variant-settings">
        <legend className="text-xs font-medium text-muted-foreground">Channel settings</legend>
        {settingsSchema ? (
          <SchemaFields
            schema={schema}
            values={settings}
            errors={settingsErrors}
            onChange={(key, value) => setSettings((v) => ({ ...v, [key]: value }))}
            idPrefix={`variant-${variant.id}-settings`}
          />
        ) : (
          <p className="text-xs text-muted-foreground">No settings for this channel.</p>
        )}
      </fieldset>
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
