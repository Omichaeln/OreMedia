import { Button, Field, Input, Skeleton, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { usePackages } from '../content/use-content';
import { useMetricDefinitions } from '../measurement/use-measurement';
import {
  ALLOCATION_METHODS,
  modeLabel,
  MODES,
  STOPPING_RULES,
  UNIT_TYPES,
  type DesignForm,
  type VariantRow,
} from './experiment-helpers';

export interface DesignFieldsProps {
  brandId: string;
  form: DesignForm;
  onChange: (form: DesignForm) => void;
  /** The problem to show beside a field, by the design's own path (`variants.0.contentRevisionId`). */
  issue: (path: string) => string | undefined;
  /** Control ids are `${idPrefix}-…` so two forms on one page never collide. */
  idPrefix: string;
}

const label = (s: string) => s.replace(/_/g, ' ');

/**
 * Spec 16.6 pre-registration as fields, shared by the experiments screen and a recommendation's Prepare test
 * (RA-07): a variant is the current revision of one of the brand's content packages picked by title, the primary
 * metric and the guardrails come from the metric dictionary (D-15); no id or key is typed.
 */
export function DesignFields({ brandId, form, onChange, issue, idPrefix }: DesignFieldsProps) {
  const packages = usePackages(brandId);
  const definitions = useMetricDefinitions();
  const set = <K extends keyof DesignForm>(key: K, value: DesignForm[K]) =>
    onChange({ ...form, [key]: value });
  const setVariant = (i: number, patch: Partial<VariantRow>) =>
    set(
      'variants',
      form.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)),
    );
  // A package without a revision yet has nothing to test; it is left out rather than offered as an empty arm.
  const revisionOptions = packages.items.flatMap((p) =>
    p.currentRevisionId ? [{ value: p.currentRevisionId, label: `${p.title} · ${label(p.state)}` }] : [],
  );
  const metricKeys = [...new Set((definitions.data ?? []).map((d) => d.key))].sort();
  const metricOptions = metricKeys.map((key) => {
    const d = (definitions.data ?? []).find((x) => x.key === key);
    return { value: key, label: d ? `${key} (${d.unit})` : key };
  });
  const toggleGuardrail = (key: string) =>
    set(
      'guardrailMetricKeys',
      form.guardrailMetricKeys.includes(key)
        ? form.guardrailMetricKeys.filter((k) => k !== key)
        : [...form.guardrailMetricKeys, key],
    );
  return (
    <>
      <Field label="Hypothesis" htmlFor={`${idPrefix}-hypothesis`} error={issue('hypothesis')}>
        <Textarea
          id={`${idPrefix}-hypothesis`}
          value={form.hypothesis}
          onChange={(e) => set('hypothesis', e.target.value)}
          rows={2}
          required
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Mode"
          htmlFor={`${idPrefix}-mode`}
          hint="A structured comparison is directional; not causal. Only a randomised design can support causal claims."
        >
          <Select
            id={`${idPrefix}-mode`}
            value={form.mode}
            onValueChange={(v) => set('mode', v)}
            options={MODES.map((m) => ({ value: m, label: modeLabel(m) }))}
          />
        </Field>
        <Field
          label="Primary metric"
          htmlFor={`${idPrefix}-primary`}
          hint={
            definitions.isPending
              ? 'Loading the metric dictionary…'
              : 'From the metric dictionary; the verdict is read on this metric.'
          }
          error={issue('primaryMetricKey')}
        >
          <Select
            id={`${idPrefix}-primary`}
            value={form.primaryMetricKey}
            onValueChange={(v) => set('primaryMetricKey', v)}
            placeholder="Choose a metric"
            options={metricOptions}
            disabled={definitions.isPending}
          />
        </Field>
      </div>
      {definitions.isError && (
        <RequestError
          error={definitions.error}
          onRetry={() => void definitions.refetch()}
          title="The metric dictionary did not load"
        />
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted-foreground">
          Guardrail metrics (optional; a primary win with a guardrail breach is not supported)
        </legend>
        {definitions.isPending && <Skeleton label="Loading the metric dictionary" lines={1} />}
        {definitions.isSuccess && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Guardrail metrics">
            {metricKeys
              .filter((k) => k !== form.primaryMetricKey)
              .map((key) => (
                <li key={key}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.guardrailMetricKeys.includes(key)}
                      onChange={() => toggleGuardrail(key)}
                      disabled={
                        !form.guardrailMetricKeys.includes(key) && form.guardrailMetricKeys.length >= 10
                      }
                    />
                    {key}
                  </label>
                </li>
              ))}
          </ul>
        )}
        {issue('guardrailMetricKeys') && (
          <p role="alert" className="text-xs text-status-critical">
            {issue('guardrailMetricKeys')}
          </p>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted-foreground">
          Variants (content packages differing only in the tested attribute; each arm is the package’s current
          revision)
        </legend>
        {packages.isPending && <Skeleton label="Loading content packages" lines={1} />}
        {packages.isError && (
          <RequestError
            error={packages.error}
            onRetry={() => void packages.refetch()}
            title="The content packages did not load"
          />
        )}
        {packages.isSuccess && packages.items.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No content packages yet; create two under Campaigns before designing a test.
          </p>
        )}
        {form.variants.map((v, i) => (
          <div key={i} className="grid grid-cols-[4rem_1fr_5rem] items-end gap-2">
            <Field label="Label" htmlFor={`${idPrefix}-v${i}-label`} error={issue(`variants.${i}.label`)}>
              <Input
                id={`${idPrefix}-v${i}-label`}
                value={v.label}
                onChange={(e) => setVariant(i, { label: e.target.value })}
              />
            </Field>
            <Field
              label="Content package"
              htmlFor={`${idPrefix}-v${i}-revision`}
              error={issue(`variants.${i}.contentRevisionId`)}
            >
              <Select
                id={`${idPrefix}-v${i}-revision`}
                value={v.contentRevisionId}
                onValueChange={(id) => setVariant(i, { contentRevisionId: id })}
                placeholder="Choose a package"
                options={revisionOptions}
                disabled={packages.isPending}
              />
            </Field>
            <Field
              label="Weight"
              htmlFor={`${idPrefix}-v${i}-weight`}
              error={issue(`variants.${i}.allocationWeight`)}
            >
              <Input
                id={`${idPrefix}-v${i}-weight`}
                type="number"
                min={0}
                step="any"
                value={v.allocationWeight}
                onChange={(e) => setVariant(i, { allocationWeight: e.target.value })}
              />
            </Field>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={form.variants.length >= 6}
            disabledReason={form.variants.length >= 6 ? 'At most six variants' : undefined}
            onClick={() =>
              set('variants', [
                ...form.variants,
                {
                  label: String.fromCharCode(65 + form.variants.length),
                  contentRevisionId: '',
                  allocationWeight: '1',
                },
              ])
            }
          >
            Add variant
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={form.variants.length <= 2}
            disabledReason={form.variants.length <= 2 ? 'At least two variants' : undefined}
            onClick={() => set('variants', form.variants.slice(0, -1))}
          >
            Remove last variant
          </Button>
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Allocation method" htmlFor={`${idPrefix}-allocation`} error={issue('allocationMethod')}>
          <Select
            id={`${idPrefix}-allocation`}
            value={form.allocationMethod}
            onValueChange={(v) => set('allocationMethod', v)}
            options={ALLOCATION_METHODS.map((m) => ({ value: m, label: label(m) }))}
          />
        </Field>
        <Field label="Unit of randomisation" htmlFor={`${idPrefix}-unit`} error={issue('unitType')}>
          <Select
            id={`${idPrefix}-unit`}
            value={form.unitType}
            onValueChange={(v) => set('unitType', v)}
            options={UNIT_TYPES.map((u) => ({ value: u, label: label(u) }))}
          />
        </Field>
        <Field
          label="Minimum sample per arm"
          htmlFor={`${idPrefix}-sample`}
          hint="From a power calculation."
          error={issue('minSamplePerArm')}
        >
          <Input
            id={`${idPrefix}-sample`}
            type="number"
            min={1}
            value={form.minSamplePerArm}
            onChange={(e) => set('minSamplePerArm', e.target.value)}
          />
        </Field>
        <Field
          label="Observation window (hours)"
          htmlFor={`${idPrefix}-window`}
          error={issue('observationWindowHours')}
        >
          <Input
            id={`${idPrefix}-window`}
            type="number"
            min={1}
            value={form.observationWindowHours}
            onChange={(e) => set('observationWindowHours', e.target.value)}
          />
        </Field>
        <Field label="Stopping rule" htmlFor={`${idPrefix}-stopping`}>
          <Select
            id={`${idPrefix}-stopping`}
            value={form.stoppingRule}
            onValueChange={(v) => set('stoppingRule', v)}
            options={STOPPING_RULES.map((r) => ({ value: r, label: label(r) }))}
          />
        </Field>
        <Field label="Alpha" htmlFor={`${idPrefix}-alpha`} error={issue('stoppingRule.alpha')}>
          <Input
            id={`${idPrefix}-alpha`}
            type="number"
            min={0}
            max={1}
            step="0.01"
            value={form.alpha}
            onChange={(e) => set('alpha', e.target.value)}
          />
        </Field>
      </div>
    </>
  );
}
