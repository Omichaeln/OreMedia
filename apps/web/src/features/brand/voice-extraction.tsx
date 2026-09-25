import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, StatusBanner } from '@oremedia/ui';
import { rememberRun } from '../agents/run-helpers';
import { brandPath, useBrandContext } from './brand-context';
import { useTRPC } from '../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';

/**
 * Spec 8.2 onboarding: an agent reads the imported guidelines and proposes this draft's voice and vocabulary (tone,
 * audiences, preferred and avoided terms, prohibited phrases, examples). The proposal replaces the saved voice only
 * if nobody has changed it since the run started; people review, edit and publish.
 */
export function VoiceExtraction({ versionId, unsaved }: { versionId: string; unsaved: boolean }) {
  const { companyId, brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [principalId, setPrincipalId] = useState('');
  const start = useMutation(
    trpc.brand.onboarding.start.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        rememberRun({ companyId, brandId, runId: res.runId });
        void queryClient.invalidateQueries(trpc.operations.audit.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    start.mutate({ brandId, versionId, servicePrincipalId: principalId.trim() });
  };
  const ui = start.isError ? toUiError(start.error) : null;
  const fieldIssue = (path: string) => ui?.details.find((d) => d.path === path)?.issue;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-border p-2" noValidate>
      <div>
        <h4 className="text-sm font-medium">Extract voice and vocabulary</h4>
        <p className="text-xs text-muted-foreground">
          An agent reads these guidelines and proposes this draft&apos;s voice: summary, tone, audiences,
          terms to use and avoid, banned phrases and examples. If anyone edits the voice while it works, their
          edit is kept and the proposal is dropped.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Agent principal"
          htmlFor="voice-extraction-principal"
          hint="sp_… of an active agent principal that may edit brand standards."
          error={fieldIssue('servicePrincipalId')}
        >
          <Input
            id="voice-extraction-principal"
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={start.isPending}
          disabledReason={
            unsaved
              ? 'Save or discard your changes first'
              : principalId.trim()
                ? undefined
                : 'Enter an agent principal id first'
          }
        >
          {start.isPending ? 'Starting…' : 'Extract voice and vocabulary'}
        </Button>
      </div>
      {ui && (
        <StatusBanner
          tone="critical"
          title={ui.kind === 'forbidden' ? 'Not started' : 'Not started: check the request'}
          description={[
            ui.message,
            ...ui.details.filter((d) => d.path !== 'servicePrincipalId').map((d) => d.issue),
          ].join(' · ')}
        />
      )}
      {start.isSuccess && (
        <StatusBanner
          tone="info"
          title="The agent is reading the guidelines"
          description={
            <>
              Its proposal replaces this draft&apos;s voice when the run finishes; reopen the version to see
              it.{' '}
              <Link
                className="underline"
                to={`${brandPath(companyId, brandId, 'agents')}?run=${encodeURIComponent(start.data.runId)}`}
              >
                Follow the run
              </Link>
            </>
          }
        />
      )}
    </form>
  );
}
