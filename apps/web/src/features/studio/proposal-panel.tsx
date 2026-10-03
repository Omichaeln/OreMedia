import { useEffect, useRef, useState } from 'react';
import { Badge, Button, StatusBanner, type Tone } from '@oremedia/ui';
import type { ElementDiff } from './diff';
import type { Proposal } from './types';

export interface ProposalPanelProps {
  proposal: Proposal;
  diff: ElementDiff[];
  headRevisionId: string;
  hasLocalWork: boolean;
  /** With a generation proposal, the ids of the groups the person kept. */
  onAccept: (groupIds?: string[]) => void;
  /** STU-1b: take a generation proposal that has blocking findings as the person's own edit (they fix them). */
  onAcceptAsMine?: (groupIds: string[]) => void;
  onModify: () => void;
  onReject: () => void;
}

const DIFF_TONE: Record<ElementDiff['kind'], Tone> = {
  added: 'good',
  changed: 'warning',
  removed: 'critical',
};

/** Spec 11.4/21.4: an agent proposal with its diff and findings; Accept commits, Modify loads it as local edits. */
export function ProposalPanel({
  proposal,
  diff,
  headRevisionId,
  hasLocalWork,
  onAccept,
  onAcceptAsMine,
  onModify,
  onReject,
}: ProposalPanelProps) {
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    headingRef.current?.focus(); // managed focus: a pending proposal is the next thing to decide (spec 21.3)
  }, [proposal.id]);
  const groups = proposal.generation?.groups ?? null;
  // STU-1b selective accept: every group is kept until the person leaves one out.
  const [kept, setKept] = useState<string[]>(() => groups?.map((g) => g.id) ?? []);
  useEffect(() => {
    setKept(proposal.generation?.groups.map((g) => g.id) ?? []);
  }, [proposal.id, proposal.generation]);
  const stale = proposal.baseRevisionId !== headRevisionId;
  const blocking = proposal.result.findings.filter((f) => f.severity === 'blocking');
  const acceptReason = proposal.result.blocking
    ? `Blocked by ${blocking.length} finding${blocking.length === 1 ? '' : 's'}; ask for a revised proposal or modify it yourself`
    : stale
      ? 'The document changed since this proposal was made; it needs to be proposed again'
      : hasLocalWork
        ? 'Save your pending changes first'
        : groups && kept.length === 0
          ? 'Keep at least one change'
          : undefined;
  return (
    <div className="flex flex-col gap-3" data-testid="proposal">
      <div
        ref={headingRef}
        tabIndex={-1}
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StatusBanner
          tone={proposal.result.blocking ? 'critical' : 'warning'}
          title="Agent proposal pending"
          description={
            <>
              {proposal.batch.summary}
              {proposal.source === 'simulated' && (
                <Badge tone="info" className="ml-2">
                  Development only
                </Badge>
              )}
            </>
          }
        />
      </div>
      {groups && (
        <fieldset className="flex flex-col gap-1 text-sm" data-testid="proposal-groups">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">
            Changes to keep ({kept.length} of {groups.length})
          </legend>
          {groups.map((g) => (
            <label key={g.id} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={kept.includes(g.id)}
                onChange={(e) =>
                  setKept((k) => (e.target.checked ? [...k, g.id] : k.filter((id) => id !== g.id)))
                }
              />
              <span>{g.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <ul className="flex flex-col gap-1 text-sm" aria-label="Proposed changes">
        {diff.length === 0 && <li className="text-muted-foreground">No visible change.</li>}
        {diff.map((d) => (
          <li key={`${d.kind}-${d.element.id}`} className="flex items-center gap-2">
            <Badge tone={DIFF_TONE[d.kind]}>{d.kind}</Badge>
            <span>{d.element.name}</span>
          </li>
        ))}
      </ul>
      {proposal.result.findings.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Findings">
          {proposal.result.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2">
              <Badge
                tone={f.severity === 'blocking' ? 'critical' : f.severity === 'warning' ? 'warning' : 'info'}
              >
                {f.severity}
              </Badge>
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => onAccept(groups ? kept : undefined)}
          disabledReason={acceptReason}
          data-testid="proposal-accept"
        >
          {groups && kept.length < groups.length ? `Accept ${kept.length} of ${groups.length}` : 'Accept'}
        </Button>
        {groups && proposal.result.blocking && onAcceptAsMine && (
          <Button
            size="sm"
            onClick={() => onAcceptAsMine(kept)}
            disabledReason={
              stale
                ? 'The document changed since this proposal was made'
                : hasLocalWork
                  ? 'Save your pending changes first'
                  : kept.length === 0
                    ? 'Keep at least one change'
                    : undefined
            }
          >
            Apply as my edit
          </Button>
        )}
        <Button size="sm" onClick={onModify}>
          Modify
        </Button>
        <Button size="sm" variant="danger" onClick={onReject}>
          Reject
        </Button>
      </div>
    </div>
  );
}
