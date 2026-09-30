import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UsageRightsInput } from '@oremedia/contracts/assets';
import { Button, Field, Input, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { isoToZonedInput, zonedInputToIso } from '../publishing/publication-state';
import type { AssetDto } from './use-assets';

/**
 * Spec 9 asset lifecycle from the inspector (UX-05): approve a pending asset, retire a pending or approved one with a
 * reason (the machine's retire edge; there is no reject command in the API, so an unwanted pending asset is retired),
 * and record or update its usage rights. Each is the API's own command; the policy decides who may (asset.approve,
 * asset.manage_rights) and a refusal is shown as such, never hidden.
 */
export function AssetActions({ asset, timeZone }: { asset: AssetDto; timeZone: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [retireReason, setRetireReason] = useState('');
  const [confirmRetire, setConfirmRetire] = useState(false);
  const refresh = () => {
    intent.renew();
    void queryClient.invalidateQueries(trpc.assets.pathFilter());
  };
  const approve = useMutation(
    trpc.assets.approve.mutationOptions({ ...mutationIntent(intent.key), onSuccess: refresh }),
  );
  const retire = useMutation(
    trpc.assets.retire.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        setConfirmRetire(false);
        setRetireReason('');
        refresh();
      },
    }),
  );
  const error = approve.error ?? retire.error;
  const ui = error ? toUiError(error) : null;
  return (
    <section aria-label="Asset actions" className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex flex-wrap gap-2">
        {asset.state === 'pending_review' && (
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={approve.isPending}
            onClick={() => approve.mutate({ assetId: asset.id, expectedVersion: asset.version })}
          >
            {approve.isPending ? 'Approving…' : 'Approve'}
          </Button>
        )}
        {(asset.state === 'approved' || asset.state === 'pending_review') && !confirmRetire && (
          <Button type="button" size="sm" variant="danger" onClick={() => setConfirmRetire(true)}>
            Retire
          </Button>
        )}
      </div>
      {confirmRetire && (
        <form
          className="flex flex-col gap-2"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            retire.mutate({
              assetId: asset.id,
              expectedVersion: asset.version,
              ...(retireReason.trim() ? { reason: retireReason.trim() } : {}),
            });
          }}
        >
          <Field
            label="Reason for retiring (optional)"
            htmlFor={`retire-${asset.id}`}
            hint="The asset leaves every eligibility search; existing usages stay recorded."
          >
            <Input
              id={`retire-${asset.id}`}
              value={retireReason}
              onChange={(e) => setRetireReason(e.target.value)}
              maxLength={200}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="danger" disabled={retire.isPending}>
              {retire.isPending ? 'Retiring…' : 'Confirm retire'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRetire(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Approving or retiring needs asset.approve on this brand.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && error && (
        <RequestError error={error} title="The asset was not changed" />
      )}
      {asset.state !== 'retired' && asset.state !== 'rejected' && (
        <RightsForm asset={asset} timeZone={timeZone} />
      )}
    </section>
  );
}

/** Spec 9.2 usage rights: owner, licence, channel and territory scope, expiry; upserted on the asset. */
function RightsForm({ asset, timeZone }: { asset: AssetDto; timeZone: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const rights = asset.rights;
  const [open, setOpen] = useState(rights === null);
  const [owner, setOwner] = useState(rights?.owner ?? '');
  const [licenceRef, setLicenceRef] = useState(rights?.licenceRef ?? '');
  const [expires, setExpires] = useState(
    rights?.expiresAt ? isoToZonedInput(new Date(rights.expiresAt).toISOString(), timeZone) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const set = useMutation(
    trpc.assets.rights.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        void queryClient.invalidateQueries(trpc.assets.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!owner.trim()) {
      setError('Name the rights owner.');
      return;
    }
    const expiresAt = expires ? zonedInputToIso(expires, timeZone) : null;
    if (expires && !expiresAt) {
      setError('Enter a valid expiry.');
      return;
    }
    setError(null);
    set.mutate({
      assetId: asset.id,
      owner: owner.trim(),
      ...(licenceRef.trim() ? { licenceRef: licenceRef.trim() } : {}),
      // Channel and territory restrictions are kept as recorded; this form records the ownership and the term.
      permittedChannels: rights?.permittedChannels ?? 'all',
      territories: rights?.territories ?? 'all',
      ...(expiresAt ? { expiresAt } : {}),
      // The DTO's JSON columns are loosely typed; the contract's own parser narrows them (they were written by it).
      releases: UsageRightsInput.shape.releases.parse(rights?.releases ?? []),
      restrictions: UsageRightsInput.shape.restrictions.parse(rights?.restrictions ?? []),
    });
  };
  const ui = set.isError ? toUiError(set.error) : null;
  if (!open)
    return (
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {rights ? 'Update rights' : 'Record rights'}
        </Button>
      </div>
    );
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" noValidate data-testid="rights-form">
      <Field label="Rights owner" htmlFor={`rights-owner-${asset.id}`}>
        <Input
          id={`rights-owner-${asset.id}`}
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          required
        />
      </Field>
      <Field label="Licence reference (optional)" htmlFor={`rights-licence-${asset.id}`}>
        <Input
          id={`rights-licence-${asset.id}`}
          value={licenceRef}
          onChange={(e) => setLicenceRef(e.target.value)}
        />
      </Field>
      <Field
        label={`Rights expire (${timeZone}, optional)`}
        htmlFor={`rights-expires-${asset.id}`}
        hint="Leave empty for no expiry. A publication scheduled past the expiry is held."
        error={error ?? undefined}
      >
        <Input
          id={`rights-expires-${asset.id}`}
          type="datetime-local"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Recording rights needs asset.manage_rights on this brand.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={set.error} title="The rights were not recorded" />
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={set.isPending}>
          {set.isPending ? 'Saving…' : 'Save rights'}
        </Button>
        {rights && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
