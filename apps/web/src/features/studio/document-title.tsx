import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input } from '@oremedia/ui';
import { useTRPC } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';

/**
 * STU-1a: the document title in the studio header, renamed in place (creative.documents.rename). Enter or Save
 * keeps it, Escape cancels; the title is a label and never creates a revision.
 */
export function DocumentTitle({ documentId, title }: { documentId: string; title: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [current, setCurrent] = useState(title);
  const [draft, setDraft] = useState<string | null>(null);
  const rename = useMutation(
    trpc.creative.documents.rename.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setCurrent(res.title);
        setDraft(null);
        queryClient.setQueryData(trpc.creative.documents.get.queryKey({ documentId }), (old) =>
          old ? { ...old, title: res.title } : old,
        );
        void queryClient.invalidateQueries(trpc.creative.documents.list.pathFilter());
      },
    }),
  );
  if (draft === null)
    return (
      <div className="flex min-w-0 items-center gap-1">
        <h1 className="truncate text-sm font-semibold" data-testid="document-title">
          {current}
        </h1>
        <Button size="sm" variant="ghost" onClick={() => setDraft(current)} aria-label={`Rename ${current}`}>
          Rename
        </Button>
      </div>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    if (!next) return;
    if (next === current) setDraft(null);
    else rename.mutate({ documentId, title: next });
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 items-center gap-1" noValidate>
      <label htmlFor="document-title-input" className="sr-only">
        Document title
      </label>
      <Input
        id="document-title-input"
        autoFocus
        value={draft}
        maxLength={200}
        className="h-8 w-56 max-w-full"
        aria-invalid={rename.isError || !draft.trim()}
        aria-describedby={rename.isError ? 'document-title-error' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(null);
          }
        }}
      />
      <Button size="sm" type="submit" variant="primary" disabled={rename.isPending || !draft.trim()}>
        {rename.isPending ? 'Saving…' : 'Save'}
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => setDraft(null)}>
        Cancel
      </Button>
      {rename.isError && (
        <span id="document-title-error" role="alert" className="text-xs text-status-critical">
          {toUiError(rename.error).message}
        </span>
      )}
    </form>
  );
}
