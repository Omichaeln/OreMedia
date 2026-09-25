import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Button, EmptyState, Field, Input } from '@oremedia/ui';
import { AddToggle, ColumnHeader } from '../../components/column-header';
import { toUiError } from '../../lib/errors';
import { useBrandContext } from '../brand/brand-context';
import { mergeRunIds, readRecentRuns, rememberRun } from './run-helpers';
import { RunDetail } from './run-detail';
import { RunsList } from './runs-list';
import { StartRunForm } from './start-run-form';
import { useAgentRunAudit, useAgentRuns } from './use-agent-runs';

const RUN_PARAM = 'run';

/**
 * Spec 21.1 `agents/`: runs, steps, costs, exceptions, as the v3 prototype lays them out: the runs in a list column
 * and the selected run beside them; "+" opens the start form in place of the run. The selected run is in the URL so
 * a link to it is stable.
 */
export function AgentRunsScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(RUN_PARAM);
  const hrefFor = (runId: string) => `?${RUN_PARAM}=${encodeURIComponent(runId)}`;
  const audit = useAgentRunAudit(brandId);
  const [deviceIds, setDeviceIds] = useState(() => readRecentRuns(companyId, brandId).map((r) => r.runId));
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!selectedId) return;
    setStarting(false); // a run the start form created replaces the form
    rememberRun({ companyId, brandId, runId: selectedId });
    setDeviceIds(readRecentRuns(companyId, brandId).map((r) => r.runId));
  }, [companyId, brandId, selectedId]);
  const runIds = useMemo(() => mergeRunIds(audit.data ?? [], deviceIds), [audit.data, deviceIds]);
  const runs = useAgentRuns(runIds);
  const auditUi = audit.isError ? toUiError(audit.error) : null;
  const historyNotice =
    auditUi?.kind === 'forbidden'
      ? 'Brand-wide history needs audit access (owner or admin). Showing runs started or opened on this device.'
      : null;
  const [openId, setOpenId] = useState('');
  const openById = (e: FormEvent) => {
    e.preventDefault();
    if (!openId.trim()) return;
    setStarting(false);
    setParams({ [RUN_PARAM]: openId.trim() });
  };

  return (
    <main id="main" className="flex min-h-full flex-col lg:flex-row">
      <section
        aria-labelledby="runs-title"
        className="flex shrink-0 flex-col border-border lg:w-80 lg:border-r"
        data-testid="runs"
      >
        <ColumnHeader
          id="runs-title"
          title="Agent runs"
          level={1}
          subtitle="State, cost, steps and tool calls with redacted inputs. Model reasoning is never stored."
          action={<AddToggle open={starting} label="New run" onToggle={() => setStarting(!starting)} />}
        />
        <RunsList
          runs={runIds.map((runId, i) => ({
            runId,
            run: runs[i]?.data,
            error: runs[i]?.error ?? null,
            isPending: runs[i]?.isPending ?? true,
          }))}
          selectedId={starting ? null : selectedId}
          hrefFor={hrefFor}
          onSelect={() => setStarting(false)}
          historyNotice={historyNotice}
          historyPending={audit.isPending}
          historyError={audit.isError && !historyNotice ? audit.error : null}
          onRetryHistory={() => void audit.refetch()}
        />
        <form className="mt-auto flex items-end gap-2 border-t border-border px-4 py-3" onSubmit={openById}>
          <Field label="Open a run by id" htmlFor="run-id" className="flex-1" hint="run_…">
            <Input id="run-id" value={openId} onChange={(e) => setOpenId(e.target.value)} />
          </Field>
          <Button type="submit" disabled={!openId.trim()}>
            Open
          </Button>
        </form>
      </section>
      <div className="min-w-0 flex-1 border-t border-border p-4 sm:p-6 lg:border-t-0">
        {starting ? (
          <StartRunForm companyId={companyId} brandId={brandId} brandName={brand.name} hrefFor={hrefFor} />
        ) : selectedId ? (
          <RunDetail key={selectedId} companyId={companyId} brandId={brandId} runId={selectedId} />
        ) : (
          <EmptyState
            title="No run selected"
            description="Choose a run to see its timeline, costs and anything that needs attention, or start one with +."
          />
        )}
      </div>
    </main>
  );
}
