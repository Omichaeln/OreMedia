import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DefaultLogger, Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { WORKFLOWS_SRC, historyPath } from './catalogue';

/**
 * Proof that the replay gate catches an incompatible change (spec 19.4). A COPY of a deployed workflow file is
 * changed the way an unsafe edit would change it (an activity call added before an existing one, a timer removed,
 * two activity calls reordered), bundled exactly as the candidate bundles are, and its retained history is replayed:
 * replay must fail with a nondeterminism error. The unchanged copy, bundled the same way, must replay cleanly, so the
 * failure is the change and nothing else. The deployed workflow files are never touched.
 */
Runtime.install({ logger: new DefaultLogger('WARN') });

interface Mutation {
  name: string;
  file: string;
  workflowType: string;
  history: string;
  /** Each `find` must occur exactly once in the copy. */
  edits: Array<[find: string, replace: string]>;
}
const MUTATIONS: Mutation[] = [
  {
    name: 'an activity call added before an existing one',
    file: 'publication.workflow.v1.ts',
    workflowType: 'publicationWorkflowV1',
    history: 'published-immediately',
    edits: [
      [
        'const claim = await control.claimForDispatch(',
        'await control.markRetryEligible(input);\n    const claim = await control.claimForDispatch(',
      ],
    ],
  },
  {
    name: 'a durable timer removed (the wait until due is skipped)',
    file: 'publication.workflow.v1.ts',
    workflowType: 'publicationWorkflowV1',
    history: 'published-after-wait',
    edits: [['if (waitMs <= 0) break;', 'break;']],
  },
  {
    name: 'two activity calls reordered',
    file: 'brand-change-impact.workflow.v1.ts',
    workflowType: 'brandChangeImpactWorkflowV1',
    history: 'fact-revoked',
    edits: [
      [
        '  const approvals = await acts.invalidateApprovals(input);\n',
        "  const early =\n    input.change.kind === 'fact_revoked'\n      ? await acts.applyFactRevocation({ ...input, factId: input.change.factId })\n      : null;\n  const approvals = await acts.invalidateApprovals(input);\n",
      ],
      [
        'const facts = await acts.applyFactRevocation({ ...input, factId: input.change.factId });',
        'const facts = early!;',
      ],
    ],
  },
];

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Bundles a copy of `file` (edited) as a one-workflow queue entry, outside the source tree. */
async function bundleCopy(file: string, workflowType: string, edits: Mutation['edits']) {
  let source = readFileSync(join(WORKFLOWS_SRC, file), 'utf8');
  for (const [find, replace] of edits) {
    expect(source.split(find).length - 1, `"${find}" must occur once in ${file}`).toBe(1);
    source = source.replace(find, replace);
  }
  const dir = mkdtempSync(join(tmpdir(), 'oremedia-replay-negative-'));
  dirs.push(dir);
  writeFileSync(join(dir, file), source);
  writeFileSync(join(dir, 'entry.ts'), `export { ${workflowType} } from './${file.replace(/\.ts$/, '')}';\n`);
  return bundleWorkflowCode({
    workflowsPath: join(dir, 'entry.ts'),
    // The copy lives outside the package: resolve @temporalio/workflow from the package's own dependencies.
    webpackConfigHook: (config) => ({
      ...config,
      resolve: { ...config.resolve, modules: [join(WORKFLOWS_SRC, '..', 'node_modules'), 'node_modules'] },
    }),
  });
}

const replay = async (workflowBundle: Awaited<ReturnType<typeof bundleCopy>>, m: Mutation) =>
  Worker.runReplayHistory(
    { workflowBundle },
    JSON.parse(readFileSync(historyPath(m.workflowType, m.history), 'utf8')),
    `${m.workflowType}/${m.history}`,
  ).then(
    () => undefined,
    (err: Error) => err,
  );

describe('an intentionally incompatible workflow change fails replay of its retained history', () => {
  it.each(MUTATIONS)('$name: $workflowType/$history', async (m) => {
    const unchanged = await replay(await bundleCopy(m.file, m.workflowType, []), m);
    expect(unchanged, 'the unchanged copy must replay cleanly').toBeUndefined();
    const changed = await replay(await bundleCopy(m.file, m.workflowType, m.edits), m);
    expect(changed?.name, 'the changed copy must fail replay').toBe('DeterminismViolationError');
    expect(changed?.message).toMatch(/nondeterminism/i);
  });
});
