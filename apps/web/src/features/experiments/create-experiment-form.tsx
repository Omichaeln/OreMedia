import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { DesignFields } from './design-fields';
import { EMPTY_DESIGN, parseDesign, type DesignForm } from './experiment-helpers';

export interface CreateExperimentFormProps {
  brandId: string;
  onCreated: (experimentId: string) => void;
}

/**
 * Spec 16.6 design: the pre-registration fields as a form. Creating stores a draft (`designed`); the design is frozen
 * with a hash only when the person pre-registers it from the detail. Contract validation runs before the request.
 */
export function CreateExperimentForm({ brandId, onCreated }: CreateExperimentFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [form, setForm] = useState<DesignForm>(EMPTY_DESIGN);
  const [issues, setIssues] = useState<Array<{ path: string; issue: string }>>([]);
  const create = useMutation(
    trpc.experiments.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setForm(EMPTY_DESIGN);
        void queryClient.invalidateQueries(trpc.experiments.pathFilter());
        void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
        onCreated(res.experimentId);
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseDesign(form);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setIssues([]);
    create.mutate({ brandId, design: parsed.design });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  const issue = (path: string) =>
    issues.find((i) => i.path === path)?.issue ?? ui?.details.find((d) => d.path === `design.${path}`)?.issue;

  return (
    <section aria-labelledby="create-experiment-title" id="create-experiment" className="flex flex-col gap-4">
      <h2 id="create-experiment-title" className="text-lg font-semibold">
        Design an experiment
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <DesignFields brandId={brandId} form={form} onChange={setForm} issue={issue} idPrefix="x" />
        {issues.length > 0 && (
          <StatusBanner
            tone="critical"
            title="The design is incomplete"
            description={issues.map((i) => `${i.path || 'design'}: ${i.issue}`).join('; ')}
            data-testid="design-issues"
          />
        )}
        {ui && ui.kind === 'forbidden' && (
          <StatusBanner
            tone="critical"
            title="Permission denied"
            description={`${ui.message} Designing an experiment needs experiment.manage for this brand.`}
            data-testid="create-denied"
          />
        )}
        {ui && ui.kind !== 'forbidden' && (
          <RequestError error={create.error} title="The experiment was not created" />
        )}
        <div>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create draft'}
          </Button>
        </div>
      </form>
    </section>
  );
}
