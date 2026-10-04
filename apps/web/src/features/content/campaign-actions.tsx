import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Field, Input, StatusBanner } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { isoToLocalInput, localInputToIso } from '../publishing/publication-state';
import { campaignChip, campaignIsClosed, isClosedCampaignRefusal } from './content-helpers';
import type { CampaignDto } from './use-content';

const dayText = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** G12: name and run dates of a campaign (content.campaigns.update), version-checked like every edit. */
function EditCampaign({ campaign }: { campaign: CampaignDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [startsAt, setStartsAt] = useState(() => isoToLocalInput(campaign.startsAt));
  const [endsAt, setEndsAt] = useState(() => isoToLocalInput(campaign.endsAt));
  const update = useMutation(
    trpc.content.campaigns.update.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        void queryClient.invalidateQueries(trpc.content.campaigns.pathFilter());
      },
    }),
  );
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setName(campaign.name);
      setStartsAt(isoToLocalInput(campaign.startsAt));
      setEndsAt(isoToLocalInput(campaign.endsAt));
      update.reset();
    }
  };
  const from = localInputToIso(startsAt);
  const to = localInputToIso(endsAt);
  const ready = name.trim() !== '' && from !== null && to !== null;
  const ui = update.isError ? toUiError(update.error) : null;
  const endsIssue = ui?.details.find((d) => d.path === 'endsAt')?.issue;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && from && to)
      update.mutate({
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        name: name.trim(),
        startsAt: from,
        endsAt: to,
      });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => onOpenChange(true)}
        aria-label={`Edit ${campaign.name}`}
      >
        Edit
      </Button>
      <DialogContent title="Edit campaign" description="Its briefs and packages stay as they are.">
        <form
          id={`edit-campaign-${campaign.id}`}
          onSubmit={submit}
          className="flex flex-col gap-3"
          noValidate
        >
          <Field label="Campaign name" htmlFor="edit-campaign-name">
            <Input
              id="edit-campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Starts" htmlFor="edit-campaign-starts">
              <Input
                id="edit-campaign-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </Field>
            <Field label="Ends" htmlFor="edit-campaign-ends" error={endsIssue}>
              <Input
                id="edit-campaign-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </Field>
          </div>
          {ui && !endsIssue && (
            <StatusBanner
              tone="critical"
              title={ui.kind === 'forbidden' ? 'Permission denied' : 'The campaign was not saved'}
              description={ui.message}
            />
          )}
        </form>
        <DialogActions>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={`edit-campaign-${campaign.id}`}
            variant="primary"
            disabled={update.isPending || !ready}
            data-testid="save-campaign"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** G12: closes a draft or active campaign as completed (content.campaigns.close), behind a confirmation. */
function CloseCampaign({ campaign }: { campaign: CampaignDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const close = useMutation(
    trpc.content.campaigns.close.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        void queryClient.invalidateQueries(trpc.content.campaigns.pathFilter());
      },
    }),
  );
  const ui = close.isError ? toUiError(close.error) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) close.reset();
      }}
    >
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label={`Close ${campaign.name}`}
      >
        Close campaign
      </Button>
      <DialogContent
        role="alertdialog"
        title="Close this campaign?"
        description="It is marked completed and can no longer be edited. Its briefs, packages and scheduled posts are not changed."
      >
        {ui && (
          <StatusBanner
            tone="critical"
            title={ui.kind === 'forbidden' ? 'Permission denied' : 'The campaign was not closed'}
            description={ui.message}
          />
        )}
        <DialogActions>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={close.isPending}
            data-testid="confirm-close-campaign"
            onClick={() => close.mutate({ campaignId: campaign.id, expectedVersion: campaign.version })}
          >
            {close.isPending ? 'Closing…' : 'Close campaign'}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** G12: the selected campaign's summary above its briefs, with edit and close while it is open (draft or active). */
export function CampaignSummary({ campaign, canPlan }: { campaign: CampaignDto; canPlan: boolean }) {
  const chip = campaignChip(campaign.state);
  const open = !campaignIsClosed(campaign.state);
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3" data-testid="campaign-summary">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{campaign.name}</p>
        <Badge tone={chip.tone}>{chip.label}</Badge>
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {dayText(campaign.startsAt)} – {dayText(campaign.endsAt)}
      </p>
      {canPlan && open && (
        <div className="flex flex-wrap gap-2">
          <EditCampaign key={`${campaign.id}:${campaign.version}`} campaign={campaign} />
          <CloseCampaign campaign={campaign} />
        </div>
      )}
    </div>
  );
}

/**
 * G12: why a brief, a plan or a package was refused when its campaign is closed (the API names the campaign); any
 * other failure is shown as a request error under `title`.
 */
export function ContentWriteError({ error, title }: { error: unknown; title: string }) {
  const ui = toUiError(error);
  if (isClosedCampaignRefusal(ui.details))
    return (
      <StatusBanner
        tone="warning"
        title="This campaign is closed"
        description={ui.message}
        data-testid="campaign-closed"
      />
    );
  return <RequestError error={error} title={title} />;
}
