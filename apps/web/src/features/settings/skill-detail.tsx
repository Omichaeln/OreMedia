import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Field, Skeleton, StatusBanner, type Tone } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC, useTRPCClient } from '../../lib/trpc';
import { isZipFileName, stripSharedRoot, unpackPicked } from '../../lib/unzip';
import { useSkill, type SkillDetailDto } from './use-settings';

const VERSION_CHIP: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  sandbox_evaluation: { tone: 'info', label: 'Evaluating' },
  in_review: { tone: 'warning', label: 'Evaluated, awaiting publish' },
  published: { tone: 'good', label: 'Published' },
  retired: { tone: 'neutral', label: 'Retired' },
};
const when = (iso: string) => new Date(iso).toLocaleString();

/** UX-17: one version's lifecycle (spec 10.2): evaluate a draft, publish an evaluated one, bind it for this brand. */
function VersionRow({
  skill,
  version,
  brandId,
}: {
  skill: SkillDetailDto;
  version: SkillDetailDto['versions'][number];
  brandId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const refresh = () => {
    intent.renew();
    void queryClient.invalidateQueries(trpc.skills.pathFilter());
  };
  const evaluate = useMutation(
    trpc.skills.versions.evaluate.mutationOptions({ ...mutationIntent(intent.key), onSuccess: refresh }),
  );
  const publish = useMutation(
    trpc.skills.versions.publish.mutationOptions({ ...mutationIntent(intent.key), onSuccess: refresh }),
  );
  const bind = useMutation(
    trpc.skills.bindings.set.mutationOptions({ ...mutationIntent(intent.key), onSuccess: refresh }),
  );
  const results = skill.evaluations.filter((r) => r.skillVersionId === version.id);
  const latest = results.at(-1) ?? null;
  const boundHere = skill.bindings.some((b) => b.skillVersionId === version.id && b.brandId === brandId);
  const chip = VERSION_CHIP[version.state] ?? { tone: 'neutral' as Tone, label: version.state };
  const error = evaluate.error ?? publish.error ?? bind.error;
  const ui = error ? toUiError(error) : null;
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`skill-version-${version.number}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Version {version.number}</span>
        <Badge tone={chip.tone}>{chip.label}</Badge>
        {version.state === 'published' && (
          <span className="text-xs text-muted-foreground">rollout {version.rolloutPercent}%</span>
        )}
        {skill.activeVersionId === version.id && <Badge tone="good">Active</Badge>}
        {boundHere && <Badge tone="info">Bound to this brand</Badge>}
        <code className="text-xs text-muted-foreground">{version.packageHash.slice(0, 12)}…</code>
      </div>
      {latest && (
        <p className="text-xs text-muted-foreground" data-testid={`skill-eval-${version.number}`}>
          Last evaluation {when(latest.createdAt)}: {latest.passed ? 'passed' : 'failed'} ({latest.runs} run
          {latest.runs === 1 ? '' : 's'}, {latest.modelVersion}
          {Object.keys(latest.scores).length
            ? `; ${Object.entries(latest.scores)
                .map(([k, v]) => `${k} ${v.toFixed(2)}`)
                .join(', ')}`
            : ''}
          ).
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {version.state === 'draft' && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={evaluate.isPending}
            onClick={() => evaluate.mutate({ skillVersionId: version.id, expectedVersion: version.version })}
          >
            {evaluate.isPending ? 'Requesting…' : 'Evaluate'}
          </Button>
        )}
        {version.state === 'sandbox_evaluation' && (
          <span className="text-xs text-muted-foreground">
            The evaluation runs in the sandbox; this updates when it reports.
          </span>
        )}
        {version.state === 'in_review' && (
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={publish.isPending || latest?.passed === false}
            disabledReason={
              latest?.passed === false ? 'The last evaluation failed; fix and evaluate again' : undefined
            }
            onClick={() =>
              publish.mutate({
                skillVersionId: version.id,
                expectedVersion: version.version,
                rolloutPercent: 100,
              })
            }
          >
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        )}
        {version.state === 'published' && !boundHere && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={bind.isPending}
            onClick={() =>
              bind.mutate({ scope: 'brand', brandId, skillId: skill.id, skillVersionId: version.id })
            }
          >
            {bind.isPending ? 'Binding…' : 'Use for this brand'}
          </Button>
        )}
        {boundHere && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={bind.isPending}
            onClick={() => bind.mutate({ scope: 'brand', brandId, skillId: skill.id, skillVersionId: null })}
          >
            Unbind
          </Button>
        )}
      </div>
      {ui && (
        <StatusBanner
          tone="critical"
          title={ui.kind === 'forbidden' ? 'Permission denied' : 'Not changed'}
          description={`${ui.message}${ui.kind === 'forbidden' ? ' Evaluating needs skill.author; publishing needs skill.publish.' : ''}`}
        />
      )}
    </li>
  );
}

/** The manifest is manifest.json or SKILL.md's YAML front matter (spec 10.1); the server reads either. */
const hasManifestIn = (files: Array<{ path: string; content: string }>) =>
  files.some((f) => f.path === 'manifest.json') ||
  files.some((f) => f.path === 'SKILL.md' && /^---\r?\n/.test(f.content));

/**
 * Spec 10.1 import: a package's files (manifest.json or SKILL.md with front matter, references) become the next
 * draft version. The files are picked loose, as a folder, or as the `.skill` (zip) package Claude exports, which is
 * unpacked in the browser.
 */
export function SkillImportForm({ brandId }: { brandId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [scope, setScope] = useState<'tenant' | 'brand'>('brand');
  const importSkill = useMutation(
    trpc.skills.import.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setFiles([]);
        void queryClient.invalidateQueries(trpc.skills.pathFilter());
      },
    }),
  );
  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = '';
    setReadError(null);
    importSkill.reset();
    const read: Array<{ path: string; content: string }> = [];
    const text = new TextDecoder();
    try {
      for (const f of list) {
        if (isZipFileName(f.name)) {
          const entries = await unpackPicked(f);
          read.push(
            ...stripSharedRoot(entries.map((x) => ({ path: x.path, content: text.decode(x.bytes) }))),
          );
        } else {
          read.push({
            path:
              (f as File & { webkitRelativePath?: string }).webkitRelativePath
                ?.split('/')
                .slice(1)
                .join('/') || f.name,
            content: await f.text(),
          });
        }
      }
    } catch (err) {
      setFiles([]);
      setReadError(err instanceof Error ? err.message : String(err));
      return;
    }
    setFiles(read);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;
    importSkill.mutate({ files, scope, ...(scope === 'brand' ? { brandId } : {}) });
  };
  const ui = importSkill.isError ? toUiError(importSkill.error) : null;
  const hasManifest = hasManifestIn(files);
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 border-t border-border pt-3"
      noValidate
      data-testid="skill-import"
    >
      <Field
        label="Skill package files"
        htmlFor="skill-import-files"
        hint="A .skill package, or SKILL.md with front matter (or manifest.json) plus any references; declarative only (scripts are refused)."
      >
        <input
          id="skill-import-files"
          type="file"
          multiple
          accept=".skill,.zip,.md,.markdown,.txt,.json,.html,.htm,.css,.csv,.yaml,.yml"
          onChange={(e) => void onFiles(e)}
          className="text-sm"
        />
      </Field>
      {readError && <StatusBanner tone="critical" title="The package was not read" description={readError} />}
      {files.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? '' : 's'}: {files.map((f) => f.path).join(', ')}
          {!hasManifest && ' · manifest.json or SKILL.md front matter is missing'}
        </p>
      )}
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="text-xs font-medium text-muted-foreground">Scope</legend>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="skill-scope"
            checked={scope === 'brand'}
            onChange={() => setScope('brand')}
          />{' '}
          This brand
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="skill-scope"
            checked={scope === 'tenant'}
            onChange={() => setScope('tenant')}
          />{' '}
          Company
        </label>
      </fieldset>
      {importSkill.data && (
        <StatusBanner
          tone="good"
          title={`Imported ${importSkill.data.key} as draft version ${importSkill.data.number}`}
          description="Evaluate it, then publish; a version runs only once a person publishes it."
          data-testid="skill-imported"
        />
      )}
      {ui && (
        <StatusBanner
          tone="critical"
          title={ui.kind === 'forbidden' ? 'Permission denied' : 'The package was not imported'}
          description={`${ui.message}${ui.details.length ? ` ${ui.details.map((d) => `${d.path ?? ''} ${d.issue}`.trim()).join('; ')}` : ''}`}
        />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={importSkill.isPending || files.length === 0 || !hasManifest}
          disabledReason={
            files.length === 0
              ? 'Choose the package files'
              : !hasManifest
                ? 'The package needs manifest.json or SKILL.md front matter'
                : undefined
          }
        >
          {importSkill.isPending ? 'Importing…' : 'Import package'}
        </Button>
      </div>
    </form>
  );
}

/** UX-17: a skill's versions, evaluations and bindings with the lifecycle actions, and an export of any version. */
export function SkillDetail({ skillId, brandId }: { skillId: string; brandId: string }) {
  const client = useTRPCClient();
  const skill = useSkill(skillId);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exported, setExported] = useState<{ version: number; url: string } | null>(null);
  // A blob URL lives until revoked: release the previous one when it is replaced or the sheet closes.
  useEffect(
    () => () => {
      if (exported) URL.revokeObjectURL(exported.url);
    },
    [exported],
  );
  const exportVersion = async (versionId: string, number: number) => {
    setExportError(null);
    try {
      const pkg = await client.skills.export.query({ skillVersionId: versionId });
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      setExported({ version: number, url: URL.createObjectURL(blob) });
    } catch (err) {
      setExportError(toUiError(err).message);
    }
  };
  return (
    <section aria-label="Skill detail" className="flex flex-col gap-3">
      {skill.isPending && <Skeleton label="Loading skill" lines={3} />}
      {skill.isError && <RequestError error={skill.error} onRetry={() => void skill.refetch()} />}
      {skill.data && (
        <>
          <div>
            <p className="text-sm font-medium">{skill.data.title}</p>
            <p className="text-xs text-muted-foreground">
              <code>{skill.data.key}</code> · {skill.data.scope} · {skill.data.state}
            </p>
          </div>
          <ul className="divide-y divide-border" aria-label="Versions" data-testid="skill-versions">
            {[...skill.data.versions]
              .sort((a, b) => b.number - a.number)
              .map((v) => (
                <VersionRow key={v.id} skill={skill.data} version={v} brandId={brandId} />
              ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {skill.data.versions.map((v) => (
              <Button
                key={v.id}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void exportVersion(v.id, v.number)}
              >
                Export v{v.number}
              </Button>
            ))}
            {exported && (
              <a
                href={exported.url}
                download={`${skill.data.key}-v${exported.version}.json`}
                className="underline underline-offset-2"
                data-testid="skill-export-link"
              >
                Download {skill.data.key} v{exported.version}
              </a>
            )}
            {exportError && <span className="text-status-critical">{exportError}</span>}
          </div>
        </>
      )}
    </section>
  );
}
