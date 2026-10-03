import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useAssetList } from '../assets/use-assets';
import { usePackages } from '../content/use-content';
import { useChannels } from '../publishing/use-publishing';
import { useReviewInboxPages } from '../review/use-review';
import { brandPath, useBrandContext } from './brand-context';

/** Per brand and browser: the person chose to go on without a channel (R1-D: a missing integration never blocks). */
const skipKey = (brandId: string) => `oremedia.setup.skip-channels.${brandId}`;
const readSkip = (brandId: string) => {
  try {
    return localStorage.getItem(skipKey(brandId)) === '1';
  } catch {
    return false;
  }
};

interface Step {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  /** Unknown while the read is pending or failed: shown as such, never as not done. */
  known: boolean;
  href: string;
  action: string;
  optional: boolean;
}

/**
 * R1-D: the onboarding journey as a checklist on the brand home while the brand is in setup: save the brand system
 * (the one gate), connect a channel or skip it, upload an asset, create the first package, ask for its review.
 * Every row reads the same data its screen does; "Finish setup" marks the brand active once the brand system is saved.
 */
export function SetupChecklist() {
  const { companyId, brandId, brand } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [skipped, setSkipped] = useState(() => readSkip(brandId));
  const channels = useChannels(brandId);
  const assets = useAssetList(brandId, {});
  const packages = usePackages(brandId);
  const inbox = useReviewInboxPages(brandId);
  const complete = useMutation(
    trpc.brand.completeSetup.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.brand.get.pathFilter());
        void queryClient.invalidateQueries(trpc.brand.list.pathFilter());
      },
    }),
  );
  const skipChannels = () => {
    try {
      localStorage.setItem(skipKey(brandId), '1');
    } catch {
      // storage blocked: the choice lasts for this visit
    }
    setSkipped(true);
  };
  const at = (rest: string) => brandPath(companyId, brandId, rest);
  const standards: Step = {
    key: 'standards',
    title: 'Save the brand system',
    detail:
      'Documents, variants and reviews all read the saved brand system; nothing can be created before it.',
    done: brand.publishedVersionId !== null,
    known: true,
    href: at('system'),
    action: 'Open brand system',
    optional: false,
  };
  const steps: Step[] = [
    standards,
    {
      key: 'channel',
      title: 'Connect a channel',
      detail: 'Posts publish through a connected channel. Without one, everything up to review still works.',
      done: (channels.data?.length ?? 0) > 0 || skipped,
      known: channels.isSuccess,
      href: at('settings?tab=channels'),
      action: 'Open channels',
      optional: true,
    },
    {
      key: 'asset',
      title: 'Upload an asset',
      detail: 'A logo, a photo or a document the first post can use; rights are recorded on the asset.',
      done: assets.items.length > 0,
      known: assets.isSuccess,
      href: at('assets'),
      action: 'Open assets',
      optional: true,
    },
    {
      key: 'package',
      title: 'Create the first package',
      detail: 'A package holds the copy and the creative for one post across its channels.',
      done: packages.items.length > 0,
      known: packages.isSuccess,
      href: at('campaigns'),
      action: 'Open campaigns',
      optional: true,
    },
    {
      key: 'review',
      title: 'Ask for its review',
      detail: 'A review request freezes what the reviewer sees; approval binds the release to it.',
      done: inbox.items.length > 0,
      known: inbox.isSuccess,
      href: at('review'),
      action: 'Open review',
      optional: true,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <Section
      id="setup-heading"
      title={`Getting started · ${doneCount} of ${steps.length}`}
      testId="setup-checklist"
    >
      <ol className="flex flex-col divide-y divide-border">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3 text-sm"
            data-testid="setup-step"
            data-step={s.key}
            data-done={s.done}
          >
            <div className="flex min-w-0 gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-xs tabular-nums"
              >
                {s.done ? '✓' : i + 1}
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span>{s.title}</span>
                  {s.done ? (
                    <Badge tone="good">Done</Badge>
                  ) : !s.known ? (
                    <Badge tone="neutral">Not read yet</Badge>
                  ) : s.optional ? (
                    <Badge tone="neutral" glyph={false}>
                      Optional
                    </Badge>
                  ) : (
                    <Badge tone="warning">Needed</Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">{s.detail}</p>
              </div>
            </div>
            {!s.done && (
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button asChild size="sm" variant={s.optional ? 'secondary' : 'primary'}>
                  <Link to={s.href}>{s.action}</Link>
                </Button>
                {s.key === 'channel' && (
                  <Button size="sm" variant="ghost" onClick={skipChannels}>
                    Skip for now
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          onClick={() => complete.mutate({ brandId, expectedVersion: brand.version })}
          disabled={!standards.done || complete.isPending}
          disabledReason={standards.done ? undefined : 'Save the brand system first'}
        >
          {complete.isPending ? 'Finishing…' : 'Finish setup'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Finishing marks the brand active; the optional steps stay open from their own screens.
        </span>
      </div>
      {complete.isError && <RequestError error={complete.error} title="Setup was not completed" />}
      {complete.isSuccess && (
        <StatusBanner tone="good" title="Setup complete" description="The brand is active." />
      )}
    </Section>
  );
}
