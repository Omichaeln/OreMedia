import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { P5 } from './mock-phase5';
import { P6 } from './mock-phase6';
import { startStaticServer } from './static-server';

/**
 * Phase 6 screens (spec 16.9 intelligence workspace, 16.6 experiments, 13 campaigns and briefs, 14.7 channel
 * settings; spec 21.2 required states) in the BUILT app at phone width against the in-process mock transport.
 * Opt-in like the other smokes (`OREMEDIA_E2E=1`); the states come from mock-phase6.ts seeds and backdoors.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

describe.skipIf(!enabled)('phase 6 screens (built app in Chromium, mock transport, phone width)', () => {
  const backend = new MockBackend();
  const p6 = backend.phase6;
  /** A studio document the revise form can pin (creative.documents.list serves it). */
  const poster = backend.createDocument('Launch poster');
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const brandPath = (rest: string) =>
    `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;
  const open = async (rest: string) => {
    await page.goto('about:blank');
    await page.goto(`${origin}${brandPath(rest)}`);
  };
  const text = (testId: string) => page.getByTestId(testId).first().textContent();
  const count = (testId: string) => page.getByTestId(testId).count();
  const noHorizontalOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const requestsTo = (path: string) => backend.requests.filter((r) => r.path === path);

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
    page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  // ---- intelligence workspace (spec 16.9; spec 21.2 intelligence states) ----

  it('loading, then What changed with freshness, coverage, partial coverage and anomalies as text', async () => {
    // The workspace itself is prefetched by the route loader; the anomalies below it load in the screen.
    backend.delays.set('intelligence.anomalies.list', 1_500);
    // The screen opens on "What to do next", as the interface does; What changed is its own view.
    await open('intelligence?view=changed');
    await expect
      .poll(() => page.getByRole('status').filter({ hasText: 'Loading anomalies' }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    backend.delays.delete('intelligence.anomalies.list');
    await expect.poll(() => count('what-changed'), { timeout: 15_000 }).toBe(1);
    // Freshness and coverage sit in the strip under the heading (the interface's), the view's statement in it.
    const strip = await text('freshness');
    expect(strip).toContain('Fetched');
    expect(strip).toContain('h ago');
    expect(strip).toContain('Coverage');
    expect(strip).toContain('sources: qualified_enquiries, reach');
    expect(strip).toContain('no competitor monitoring');
    expect(await text('what-changed')).toContain('missing snapshots are reported as gaps, never as zero');
    expect(await count('coverage-partial')).toBe(1);
    expect(await count('stale')).toBe(0);
    await expect.poll(() => count('anomaly'), { timeout: 15_000 }).toBe(1);
    const anomaly = await text('anomaly');
    expect(anomaly).toContain('High severity');
    expect(anomaly).toContain('complaints');
    // The interface states an anomaly as one line: observed against its baseline (the bar chart is gone).
    expect(anomaly).toContain('observed 9 against a baseline of 2 (4.5× baseline)');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 45_000);

  it('What we learned separates hypotheses from experimentally supported findings; customer voice has its own tab', async () => {
    await page.getByRole('tab', { name: 'What we learned' }).click();
    await expect.poll(() => count('what-we-learned'), { timeout: 15_000 }).toBe(1);
    const learned = await text('what-we-learned');
    expect(learned).toContain('Hypothesis');
    expect(learned).toContain('Posts with a price in the first frame');
    expect(learned).toContain('Observations and hypotheses are not findings');
    const findings = await text('findings');
    expect(findings).toContain('Finding');
    expect(findings).toContain('Experimentally supported');
    expect(findings).not.toContain('Posts with a price');
    await page.getByRole('tab', { name: 'Customer voice' }).click();
    await expect.poll(() => count('cluster'), { timeout: 15_000 }).toBe(1);
    expect(await text('cluster')).toContain('Question');
    expect(await text('cluster')).toContain('14 messages');
    expect(await text('voice')).toContain('not a representative measure of market demand');
  }, 30_000);

  it('What to do next ranks recommendations with exactly their actions; accepting creates the brief', async () => {
    // Without a view in the URL the screen opens on "What to do next", as the interface does.
    await open('intelligence');
    await expect.poll(() => count('what-to-do-next'), { timeout: 15_000 }).toBe(1);
    expect(await page.getByRole('tab', { name: 'What to do next' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await expect.poll(() => count('recommendation'), { timeout: 15_000 }).toBe(4);
    const next = await text('what-to-do-next');
    expect(next).toContain('Ranking policy: baseline.');
    expect(await text('freshness')).toContain('Fetched');
    const first = page.getByTestId('recommendation').first();
    // The interface's "01"; the rank is named for assistive technology.
    expect(await first.textContent()).toContain('Rank 1');
    const actions = first.getByRole('group', { name: /Actions for/ }).getByRole('button');
    expect(await actions.allTextContents()).toEqual(['Create brief', 'Dismiss']);
    await first.getByRole('button', { name: 'Create brief' }).click();
    await first.getByLabel('Audience').fill('Customers abroad');
    await first.getByLabel('Message').fill('We ship to Ireland');
    await first.getByRole('button', { name: 'Accept: Create brief' }).click();
    await expect.poll(() => page.getByTestId('recommendation-accepted').count(), { timeout: 15_000 }).toBe(1);
    expect(p6.recommendations.get(P6.recommendations.brief)?.state).toBe('accepted');
    const briefId = p6.recommendations.get(P6.recommendations.brief)?.downstreamId ?? '';
    expect(await text('recommendation-accepted')).toContain(briefId);
    await page.getByTestId('recommendation-accepted').getByRole('link', { name: 'Open' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain(`campaigns?brief=${briefId}`);
    await expect.poll(() => text('brief-state'), { timeout: 15_000 }).toContain('Awaiting acceptance');
    expect(await text('brief-detail')).toContain(P6.recommendations.brief);
    expect(await text('brief-detail')).toContain('Suggested plan');
  }, 45_000);

  it('accepting Prepare test designs the experiment through fields: packages by title, metrics from the dictionary (RA-07: no JSON)', async () => {
    await open('intelligence?view=next');
    const card = page.getByTestId('recommendation').filter({ hasText: 'Test a question hook on carousels' });
    await expect.poll(() => card.count(), { timeout: 15_000 }).toBe(1);
    await card.getByRole('button', { name: 'Prepare test' }).click();
    const formId = `rec-${P6.recommendations.test2}`;
    // The hypothesis starts from the recommendation; no JSON editor is on the page.
    expect(await page.locator(`#${formId}-design-hypothesis`).inputValue()).toMatch(/price|question hook/);
    expect(await page.locator('textarea.font-mono').count()).toBe(0);
    await page.locator(`#${formId}-design-primary`).click();
    await page.getByRole('option', { name: /^clicks/ }).click();
    await page.locator(`#${formId}-design-v0-revision`).click();
    await page.getByRole('option', { name: /Autumn offer post/ }).click();
    // A second arm left unchosen is named on the field before any request is sent.
    const acceptsBefore = requestsTo('intelligence.recommendations.accept').length;
    await card.getByRole('button', { name: 'Accept: Prepare test' }).click();
    await expect.poll(() => count('design-issues'), { timeout: 15_000 }).toBe(1);
    expect(requestsTo('intelligence.recommendations.accept')).toHaveLength(acceptsBefore);
    await page.locator(`#${formId}-design-v1-revision`).click();
    await page.getByRole('option', { name: /Meet the team/ }).click();
    await card.getByRole('button', { name: 'Accept: Prepare test' }).click();
    await expect.poll(() => card.getByTestId('recommendation-accepted').count(), { timeout: 15_000 }).toBe(1);
    const experimentId = p6.recommendations.get(P6.recommendations.test2)?.downstreamId ?? '';
    expect(experimentId).toMatch(/^exp_/);
    expect(p6.experiment(experimentId).design).toMatchObject({
      primaryMetricKey: 'clicks',
      variants: [
        { label: 'A', contentRevisionId: P5.revisions.one },
        { label: 'B', contentRevisionId: P5.revisions.two },
      ],
    });
    expect(p6.experiment(experimentId).design.hypothesis).toMatch(/price|question hook/);
  }, 45_000);

  it('dismiss needs a reason, which is sent with the decision', async () => {
    await open('intelligence?view=next');
    await expect.poll(() => count('recommendation'), { timeout: 15_000 }).toBe(2);
    const card = page.getByTestId('recommendation').filter({ hasText: 'Test price-first carousels' });
    await card.getByRole('button', { name: 'Dismiss' }).click();
    const submit = card.locator('form').getByRole('button', { name: 'Dismiss' });
    expect(await submit.getAttribute('aria-disabled')).toBe('true');
    await card.getByLabel('Reason for dismissing').fill('We ran this test last quarter');
    await submit.click();
    await expect
      .poll(() => p6.recommendations.get(P6.recommendations.test)?.state, { timeout: 15_000 })
      .toBe('dismissed');
    expect(p6.recommendations.get(P6.recommendations.test)?.dismissalReason).toBe(
      'We ran this test last quarter',
    );
    // The decided card stays with its outcome after the workspace refreshes.
    await expect
      .poll(() => card.getAttribute('data-recommendation-state'), { timeout: 15_000 })
      .toBe('dismissed');
    expect(await card.textContent()).toContain('Dismissed');
    expect(typeof requestsTo('intelligence.recommendations.dismiss').at(-1)?.headers['idempotency-key']).toBe(
      'string',
    );
    // The interface's quick reasons dismiss in one step, sending the reason as written.
    const other = page
      .getByTestId('recommendation')
      .filter({ hasNot: page.getByText('Test price-first carousels') });
    await other.first().getByRole('button', { name: 'Dismiss' }).click();
    await other.first().getByRole('button', { name: 'Already doing it' }).click();
    await expect
      .poll(() => p6.recommendations.get(P6.recommendations.playbook)?.state, { timeout: 15_000 })
      .toBe('dismissed');
    expect(p6.recommendations.get(P6.recommendations.playbook)?.dismissalReason).toBe('Already doing it');
  }, 30_000);

  it('no objective: ranking is refused and the page links to set one', async () => {
    const objective = p6.objective;
    p6.objective = null;
    await open('intelligence?view=next');
    await expect.poll(() => count('no-objective'), { timeout: 15_000 }).toBe(1);
    expect(await text('no-objective')).toContain('recommendations are not ranked');
    const link = page.getByTestId('no-objective').getByRole('link', { name: 'Set an objective' });
    expect(await link.getAttribute('href')).toBe(brandPath('system'));
    expect(await text('what-to-do-next')).toContain('Unranked list.');
    expect(await text('what-to-do-next')).not.toContain('Rank 1');
    p6.objective = objective;
  }, 30_000);

  it('analyse now shows the running state until the analyst writes its insights', async () => {
    await open('intelligence?view=changed');
    await expect.poll(() => count('what-changed'), { timeout: 15_000 }).toBe(1);
    await page.getByRole('button', { name: 'Run brand analyst' }).click();
    // RA-07: the principal is picked by name and the run's limits are shown; no id is typed.
    await page.locator('#analyse-principal').click();
    await page.getByRole('option', { name: /Brand analyst/ }).click();
    await expect.poll(() => count('effective-limits'), { timeout: 15_000 }).toBe(1);
    expect(await text('effective-budget')).toContain('$1.50');
    expect(await text('denied-actions')).toContain('None');
    await page.getByRole('button', { name: 'Analyse now' }).click();
    await expect.poll(() => count('analysis-running'), { timeout: 15_000 }).toBe(1);
    expect(await text('analysis-running')).toContain('brand-analyst:');
    expect(p6.pendingAnalysis).toMatchObject({ servicePrincipalId: P6.principalId });
    p6.completeAnalysis();
    await expect.poll(() => count('analysis-running'), { timeout: 20_000 }).toBe(0);
    expect(await text('what-changed')).toContain('Saves rose 18%');
  }, 45_000);

  it('stale snapshots are marked with text next to the numbers', async () => {
    p6.makeStale();
    await open('intelligence?view=changed');
    await expect.poll(() => count('stale'), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await page.getByTestId('stale').first().textContent()).toContain('Stale');
    expect(await text('freshness')).toContain('d ago');
  }, 30_000);

  it('the playbook shows reconsider-by dates and lets an approver approve a proposal', async () => {
    await open('intelligence?view=playbook');
    await expect.poll(() => count('playbook-approved'), { timeout: 15_000 }).toBe(1);
    const approved = await text('playbook-approved');
    expect(approved).toContain('Reply to product questions within four hours.');
    expect(approved).toContain('Reconsider by');
    expect(approved).toContain('Due for review');
    const proposed = page.getByTestId('playbook-proposed');
    await expect
      .poll(() => proposed.getByRole('button', { name: 'Approve' }).count(), { timeout: 15_000 })
      .toBe(1);
    await proposed.getByRole('button', { name: 'Approve' }).click();
    await expect
      .poll(() => p6.playbook.get(P6.playbook.proposed)?.state, { timeout: 15_000 })
      .toBe('approved');
    await expect
      .poll(() => text('playbook-approved'), { timeout: 15_000 })
      .toContain('Use customer photos on Fridays.');
  }, 45_000);

  it('a role without playbook.approve sees no approve control, only why', async () => {
    backend.role = 'analyst';
    p6.playbook.set('pbe_other', {
      ...(p6.playbook.get(P6.playbook.approved) as NonNullable<ReturnType<typeof p6.playbook.get>>),
      id: 'pbe_other',
      practice: 'Post a behind-the-scenes photo each week.',
      state: 'proposed',
      approvedByUserId: null,
    });
    await page.reload();
    await open('intelligence?view=playbook');
    const proposed = page.getByTestId('playbook-proposed');
    await expect
      .poll(() => proposed.textContent(), { timeout: 15_000 })
      .toContain('Post a behind-the-scenes photo each week.');
    expect(await proposed.getByRole('button', { name: 'Approve' }).count()).toBe(0);
    expect(await proposed.textContent()).toContain('Approval needs a person with playbook.approve');
    backend.role = 'owner';
  }, 30_000);

  it('permission denied and a failed load are distinct states with a retry', async () => {
    backend.denied.add('intelligence.workspace.get');
    await open('intelligence');
    await expect
      .poll(() => page.getByRole('status').filter({ hasText: 'Permission denied' }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    expect(await page.locator('main').textContent()).toContain('intelligence.workspace.get');
    backend.denied.delete('intelligence.workspace.get');
    // Once for the route loader's prefetch, once for the screen's own read.
    backend.failNext.set('intelligence.workspace.get', 2);
    await open('intelligence?view=changed');
    await expect
      .poll(() => page.getByRole('alert').filter({ hasText: 'Something went wrong' }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => count('what-changed'), { timeout: 15_000 }).toBe(1);
  }, 45_000);

  it('no data: every view says so instead of estimating (empty recommendations too)', async () => {
    p6.clearAnalysis();
    await open('intelligence?view=changed');
    await expect.poll(() => text('what-changed'), { timeout: 15_000 }).toContain('No data yet');
    expect(await text('what-changed')).toContain('No analysis has run for this brand yet');
    await page.getByRole('tab', { name: 'What to do next' }).click();
    await expect.poll(() => text('what-to-do-next'), { timeout: 15_000 }).toContain('No recommendations');
  }, 30_000);

  // ---- experiments (spec 16.6) ----

  it('lists experiments with state chips and the mode label as text', async () => {
    await open('experiments');
    // The five seeded experiments and the one prepared from a recommendation above.
    await expect.poll(() => page.getByTestId(/^experiment-exp_/).count(), { timeout: 15_000 }).toBe(6);
    const list = await text('experiments');
    for (const label of ['Designed', 'Running', 'Analysed', 'Structured comparison', 'Randomised'])
      expect(list).toContain(label);
    // The conclusion label moved from the row to the detail's mode line, as the interface places it.
    await page.getByTestId(`experiment-${P6.experiments.inconclusive}`).click();
    await expect
      .poll(() => text('experiment-detail'), { timeout: 15_000 })
      .toContain('directional; not causal');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 30_000);

  it('create, pre-register (frozen hash shown), start and stop', async () => {
    // The screen keeps the open experiment in the address; the created one is whichever id replaces it.
    const shownBefore = new URL(page.url()).searchParams.get('experiment');
    await page.getByRole('button', { name: 'New experiment' }).click();
    await page.getByLabel('Hypothesis').fill('A question hook lifts enquiries');
    // RA-07: the metric comes from the dictionary and each arm is a content package picked by title; no key or
    // id is typed. A guardrail is a checkbox from the same dictionary.
    await page.locator('#x-primary').click();
    await page.getByRole('option', { name: /^clicks/ }).click();
    await page.getByRole('checkbox', { name: 'engagement_rate' }).check();
    await page.locator('#x-v0-revision').click();
    await page.getByRole('option', { name: /Autumn offer post/ }).click();
    await page.locator('#x-v1-revision').click();
    await page.getByRole('option', { name: /Meet the team/ }).click();
    await page.getByRole('button', { name: 'Create draft' }).click();
    const shownNow = () => new URL(page.url()).searchParams.get('experiment');
    await expect
      .poll(() => (shownNow() !== shownBefore ? shownNow() : null), { timeout: 15_000 })
      .toMatch(/^exp_/);
    const createdId = shownNow() ?? '';
    expect(p6.experiment(createdId).design).toMatchObject({
      primaryMetricKey: 'clicks',
      guardrailMetricKeys: ['engagement_rate'],
      variants: [
        { label: 'A', contentRevisionId: P5.revisions.one },
        { label: 'B', contentRevisionId: P5.revisions.two },
      ],
    });
    await expect.poll(() => text('experiment-state'), { timeout: 15_000 }).toContain('Designed');
    expect(await text('design-hash')).toContain('not frozen yet');
    await page.getByRole('button', { name: 'Pre-register (freeze design)' }).click();
    await expect.poll(() => text('experiment-state'), { timeout: 15_000 }).toContain('Pre-registered');
    expect(await text('design-hash')).toMatch(/[0-9a-f]{64}/);
    expect(await count('design-frozen')).toBe(1);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect.poll(() => text('experiment-state'), { timeout: 15_000 }).toContain('Running');
    await page.getByLabel('Stop reason (optional)').fill('Budget moved');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => text('experiment-state'), { timeout: 15_000 }).toContain('Stopped');
  }, 45_000);

  it('results show the verdict and the conclusion label; a guardrail breach is not supported', async () => {
    await open(`experiments?experiment=${P6.experiments.supported}`);
    await expect.poll(() => count('experiment-result'), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('experiment-result').getAttribute('data-verdict')).toBe('supported');
    expect(await text('experiment-result')).toContain('Supported');
    expect(await text('experiment-result')).toContain('Difference +');
    expect(await text('experiment-result')).toContain('95% interval');
    await open(`experiments?experiment=${P6.experiments.inconclusive}`);
    await expect
      .poll(() => text('conclusion-label'), { timeout: 15_000 })
      .toContain('directional; not causal');
    expect(await text('experiment-result')).toContain('Inconclusive');
    await open(`experiments?experiment=${P6.experiments.breach}`);
    await expect.poll(() => count('guardrail-breach'), { timeout: 15_000 }).toBe(1);
    expect(await text('guardrail-breach')).toContain('Guardrail breached: complaints');
    expect(await text('experiment-result')).toContain('Not supported');
  }, 45_000);

  it('no result before the sample and window: the refusal is explained', async () => {
    await open(`experiments?experiment=${P6.experiments.running}`);
    await expect
      .poll(() => text('results'), { timeout: 15_000 })
      .toContain('No result before the sample and window');
    const variants = p6.experiment(P6.experiments.running).variants;
    await page.locator(`#obs-${variants[0]?.id}-n`).fill('12');
    await page.locator(`#obs-${variants[0]?.id}-x`).fill('2');
    await page.locator(`#obs-${variants[1]?.id}-n`).fill('10');
    await page.locator(`#obs-${variants[1]?.id}-x`).fill('1');
    await page.getByRole('button', { name: 'Compute results' }).click();
    await expect.poll(() => count('results-refused'), { timeout: 15_000 }).toBe(1);
    const refused = await text('results-refused');
    expect(refused).toContain('The observation window has not ended');
    expect(refused).toContain('below the pre-registered minimum of 30 per arm');
  }, 30_000);

  it('a changed design is rejected as the API returns it', async () => {
    p6.changeDesign(P6.experiments.running);
    await page.getByRole('button', { name: 'Compute results' }).click();
    await expect.poll(() => count('design-changed'), { timeout: 15_000 }).toBe(1);
    const changed = await text('design-changed');
    expect(changed).toContain('Results are computed only against the pre-registered design');
    expect(changed).toContain('changed after pre-registration');
  }, 30_000);

  // ---- campaigns and briefs (spec 13, 21.2 campaign planner) ----

  it('campaigns show missed dates; a new campaign starts empty', async () => {
    await open('campaigns');
    await expect.poll(() => count(`campaign-${P6.campaigns.missed}`), { timeout: 15_000 }).toBe(1);
    expect(await text(`campaign-${P6.campaigns.missed}`)).toContain('Missed date');
    expect(await text(`campaign-${P6.campaigns.spring}`)).not.toContain('Missed date');
    await page.getByRole('button', { name: 'New campaign' }).click();
    await page.getByLabel('Campaign name').fill('Summer');
    await page.getByLabel('Starts').fill('2026-06-01T09:00');
    await page.getByLabel('Ends').fill('2026-06-30T18:00');
    await page.getByRole('button', { name: 'Create campaign' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(/campaign=cmp_/);
    await expect.poll(() => text('briefs'), { timeout: 15_000 }).toContain('No briefs yet');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 45_000);

  it('a campaign is edited and closed from the planner (G12); a closed campaign offers neither again', async () => {
    const spring = p6.campaigns.get(P6.campaigns.spring);
    if (!spring) throw new Error('seeded campaign missing');
    const saved = structuredClone(spring);
    await open(`campaigns?campaign=${P6.campaigns.spring}`);
    const summary = page.getByTestId('campaign-summary');
    await expect.poll(() => summary.textContent(), { timeout: 15_000 }).toContain('Spring launch');
    await summary.getByRole('button', { name: 'Edit Spring launch' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit campaign' });
    await dialog.getByLabel('Campaign name').fill('Spring relaunch');
    // An end before the start is refused by the API and shown on the field; nothing changes.
    await dialog.getByLabel('Ends').fill('2020-01-01T09:00');
    await dialog.getByTestId('save-campaign').click();
    await expect
      .poll(() => dialog.textContent(), { timeout: 15_000 })
      .toContain('must not be before startsAt');
    expect(spring.name).toBe('Spring launch');
    await dialog.getByLabel('Ends').fill('2030-06-30T18:00');
    await dialog.getByTestId('save-campaign').click();
    await expect.poll(() => spring.name, { timeout: 15_000 }).toBe('Spring relaunch');
    expect(spring.version).toBe(saved.version + 1);
    expect(requestsTo('content.campaigns.update').length).toBe(2);
    await expect.poll(() => summary.textContent(), { timeout: 15_000 }).toContain('Spring relaunch');
    expect(await text(`campaign-${P6.campaigns.spring}`)).toContain('Spring relaunch');

    await summary.getByRole('button', { name: 'Close Spring relaunch' }).click();
    await page.getByTestId('confirm-close-campaign').click();
    await expect.poll(() => spring.state, { timeout: 15_000 }).toBe('completed');
    await expect.poll(() => summary.textContent(), { timeout: 15_000 }).toContain('Completed');
    expect(await summary.getByRole('button').count()).toBe(0);

    // A closed campaign takes no new brief: the form says so, and the API's reason is shown when tried anyway.
    await page.getByRole('button', { name: /new brief/ }).click();
    expect(await page.getByTestId('briefs').textContent()).toContain(
      'The selected campaign is closed: it takes no new briefs.',
    );
    const briefsBefore = p6.briefs.size;
    await page.getByLabel('Audience').fill('Late joiners');
    await page.getByRole('button', { name: 'Create brief' }).click();
    const closedBanner = page.getByTestId('campaign-closed');
    await expect.poll(() => closedBanner.count(), { timeout: 15_000 }).toBe(1);
    expect(await closedBanner.textContent()).toContain(
      'The campaign "Spring relaunch" is closed: it takes no new briefs or content',
    );
    expect(p6.briefs.size).toBe(briefsBefore);
    // Nor is content attached to one of its briefs: accepting it into packages is refused with the same reason.
    await open(`campaigns?campaign=${P6.campaigns.spring}&brief=${P6.briefs.awaiting}`);
    await page.getByRole('button', { name: 'Accept brief' }).click();
    await expect.poll(() => page.getByTestId('campaign-closed').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('campaign-closed').textContent()).toContain('This campaign is closed');
    expect(p6.briefs.get(P6.briefs.awaiting)?.state).toBe('draft');
    Object.assign(spring, saved);
  }, 45_000);

  it('a brief awaiting acceptance is accepted, keeping its intent key across a failed attempt', async () => {
    await open(`campaigns?brief=${P6.briefs.awaiting}`);
    await expect.poll(() => count('brief-awaiting'), { timeout: 15_000 }).toBe(1);
    backend.failNext.set('content.briefs.accept', 1);
    const before = requestsTo('content.briefs.accept').length;
    await page.getByRole('button', { name: 'Accept brief' }).click();
    await expect.poll(() => requestsTo('content.briefs.accept').length, { timeout: 15_000 }).toBe(before + 1);
    await expect
      .poll(() => text('brief-detail'), { timeout: 15_000 })
      .toContain('The brief was not accepted');
    await page.getByRole('button', { name: 'Accept brief' }).click();
    await expect.poll(() => text('brief-state'), { timeout: 15_000 }).toContain('Accepted');
    const [failed, retried] = requestsTo('content.briefs.accept').slice(before);
    expect(typeof failed?.headers['idempotency-key']).toBe('string');
    expect(retried?.headers['idempotency-key']).toBe(failed?.headers['idempotency-key']);
    expect(p6.brief(P6.briefs.awaiting).state).toBe('accepted');
  }, 45_000);

  it('suggested and incomplete briefs are labelled with what is missing', async () => {
    await open(`campaigns?brief=${P6.briefs.suggested}`);
    await expect.poll(() => text('brief-detail'), { timeout: 15_000 }).toContain('Suggested plan');
    expect(await text('brief-awaiting')).toContain('suggested, not written by a person');
    await open(`campaigns?brief=${P6.briefs.incomplete}`);
    await expect.poll(() => count('brief-incomplete'), { timeout: 15_000 }).toBe(1);
    expect(await text('brief-incomplete')).toContain('Missing: audience, channels');
  }, 30_000);

  it('plan items (UX-09): the planner’s calendar is edited and dropped; accepting the brief creates one package per kept item; "Plan with agent" prefills a campaign_planning run', async () => {
    await open(`campaigns?brief=${P6.briefs.suggested}`);
    await expect.poll(() => count('plan-grid'), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => count(`plan-item-${P6.planItems.first}`), { timeout: 15_000 }).toBe(1);
    expect(await text(`plan-item-${P6.planItems.first}`)).toContain('proposed by an agent run');
    expect(await text(`plan-item-${P6.planItems.second}`)).toContain('no connection assigned');
    expect(await text('brief-awaiting')).toContain('Accepting creates 2 draft packages');
    // Edit the first item's theme and save; the row shows the new value from the server.
    const first = page.getByTestId(`plan-item-${P6.planItems.first}`);
    await first.getByLabel('Theme').fill('Shipping, answered');
    await first.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => backend.phase6.planItem(P6.planItems.first).theme, { timeout: 15_000 })
      .toBe('Shipping, answered');
    // Drop the second; the banner counts one; restore it and drop again to cover both moves.
    const second = page.getByTestId(`plan-item-${P6.planItems.second}`);
    await second.getByRole('button', { name: 'Drop' }).click();
    await expect
      .poll(() => text('brief-awaiting'), { timeout: 15_000 })
      .toContain('Accepting creates 1 draft package ');
    await second.getByRole('button', { name: 'Restore' }).click();
    await expect
      .poll(() => text('brief-awaiting'), { timeout: 15_000 })
      .toContain('Accepting creates 2 draft packages');
    await second.getByRole('button', { name: 'Drop' }).click();
    await expect
      .poll(() => text(`plan-item-${P6.planItems.second}`), { timeout: 15_000 })
      .toContain('Dropped');
    // A person adds an item by hand.
    await page.getByLabel('Date').last().fill('2026-11-09');
    await page.getByTestId('plan-grid').getByLabel('Theme').last().fill('Last call');
    await page.getByRole('button', { name: 'Add item' }).click();
    await expect
      .poll(() => text('brief-awaiting'), { timeout: 15_000 })
      .toContain('Accepting creates 2 draft packages');
    // "Plan with agent" opens the run form on campaign_planning with the brief prefilled.
    await page.getByRole('button', { name: 'Plan with agent' }).click();
    await expect
      .poll(() => page.getByRole('dialog', { name: 'Plan with agent' }).count(), { timeout: 15_000 })
      .toBe(1);
    const dialog = page.getByRole('dialog', { name: 'Plan with agent' });
    expect(await dialog.locator('#run-task').textContent()).toContain('campaign planning');
    expect(await dialog.locator('#run-brief-briefId').inputValue()).toBe(P6.briefs.suggested);
    expect(await dialog.locator('#run-brief-objective').inputValue()).toBe('Answer the shipping question');
    expect(await dialog.locator('#run-brief-channels').inputValue()).toContain('linkedin');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByRole('dialog').count(), { timeout: 15_000 }).toBe(0);
    // Accept: the two proposed items become packages under the brief; the dropped one stays dropped.
    const packagesBefore = [...backend.phase6.packages.values()].filter(
      (p) => p.briefId === P6.briefs.suggested,
    ).length;
    await page.getByRole('button', { name: 'Accept brief' }).click();
    await expect.poll(() => text('brief-state'), { timeout: 15_000 }).toContain('In progress');
    const packagesAfter = [...backend.phase6.packages.values()].filter(
      (p) => p.briefId === P6.briefs.suggested,
    );
    expect(packagesAfter.length - packagesBefore).toBe(2);
    expect(packagesAfter.map((p) => p.title).sort()).toEqual([
      '2026-11-02 · Shipping, answered',
      '2026-11-09 · Last call',
    ]);
    expect(backend.phase6.planItem(P6.planItems.first).state).toBe('materialised');
    expect(backend.phase6.planItem(P6.planItems.second).state).toBe('dropped');
    await expect
      .poll(() => text(`plan-item-${P6.planItems.first}`), { timeout: 15_000 })
      .toContain('Package created');
    await page
      .getByTestId(`plan-item-${P6.planItems.first}`)
      .getByRole('button', { name: 'Open package' })
      .click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(/package=pkg_/);
    expect(await noHorizontalOverflow()).toBe(true);
  }, 60_000);

  it('packages show revision states, superseded history and invalid variants with findings', async () => {
    await open(`campaigns?brief=${P6.briefs.accepted}&package=${P6.packages.review}`);
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('In review');
    expect(await text('revision-history')).toContain('Superseded');
    const invalid = page.locator('[data-testid="variant"][data-variant-valid="false"]');
    await expect.poll(() => invalid.count(), { timeout: 15_000 }).toBe(1);
    expect(await invalid.textContent()).toContain('Invalid');
    expect(await invalid.textContent()).toContain('caption is 310 characters; the channel allows 280');
    expect(await text('package-detail')).toContain('Needs reconnecting');
    await page.getByTestId(`package-${P6.packages.changes}`).click();
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Changes requested');
    expect(await text('revision-detail')).toContain('revise the package');
    await page.getByTestId(`package-${P6.packages.approved}`).click();
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Approved');
  }, 45_000);

  it('generate variants: one per channel, the invalid one lists its finding', async () => {
    const detail = page.getByTestId('package-detail');
    await expect.poll(() => detail.getByLabel(/Acme X \(x\)/).count(), { timeout: 15_000 }).toBe(1);
    await detail.getByLabel(/Acme X \(x\)/).check();
    await detail.getByLabel(/Acme LinkedIn \(linkedin\)/).check();
    await detail.getByRole('button', { name: 'Generate variants' }).click();
    await expect.poll(() => count('variants-generated'), { timeout: 15_000 }).toBe(1);
    expect(await text('variants-generated')).toContain('2 variants generated');
    await expect.poll(() => detail.getByTestId('variant').count(), { timeout: 15_000 }).toBe(2);
    const invalid = detail.locator('[data-testid="variant"][data-variant-valid="false"]');
    expect(await invalid.textContent()).toContain('caption is 34 characters; the channel allows 30');
  }, 45_000);

  it('revising supersedes the current revision and links the chosen studio documents', async () => {
    await page.getByTestId(`package-${P6.packages.changes}`).click();
    const detail = page.getByTestId('package-detail');
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Changes requested');
    await detail.getByLabel('Master copy').fill('Workshop dates for October and November.');
    // The documents come from creative.documents.list, not typed ids; the seeded package pins nothing yet.
    const picker = detail.getByTestId('document-picker');
    await expect.poll(() => picker.getByLabel(/Launch poster/).count(), { timeout: 15_000 }).toBe(1);
    await picker.getByLabel(/Launch poster/).check();
    await detail.getByRole('button', { name: 'Create next revision' }).click();
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Draft');
    expect(await text('revision-history')).toContain('Superseded');
    expect(requestsTo('content.packages.revise')).toHaveLength(1);
    const link = page.getByTestId('studio-links').getByRole('link', { name: 'Launch poster' });
    expect(await link.getAttribute('href')).toBe(brandPath(`studio/${poster.id}`));
    expect(await count('document-stale')).toBe(0);
    // A copy-only revision omits creativeDocumentIds: the server keeps the document (spec 6.3, no accidental detach).
    await detail.getByLabel('Master copy').fill('Workshop dates for October, November and December.');
    await detail.getByRole('button', { name: 'Create next revision' }).click();
    await expect.poll(() => requestsTo('content.packages.revise').length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => text('revision-history'), { timeout: 15_000 }).toContain('#3');
    expect(await page.getByTestId('studio-links').getByRole('link', { name: 'Launch poster' }).count()).toBe(
      1,
    );
  }, 45_000);

  it('editing a variant re-runs the capability check and stores the media selection (spec 14.1)', async () => {
    const detail = page.getByTestId('package-detail');
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Draft');
    await detail.getByLabel(/Acme X \(x\)/).check();
    await detail.getByRole('button', { name: 'Generate variants' }).click();
    await expect.poll(() => detail.getByTestId('variant').count(), { timeout: 15_000 }).toBe(1);
    const variant = detail.getByTestId('variant');
    expect(await variant.getAttribute('data-variant-valid')).toBe('false'); // 50 characters over X's 30
    await variant.getByRole('button', { name: /^Edit Acme X/ }).click();
    const editor = detail.getByTestId('variant-editor');
    await expect.poll(() => editor.count(), { timeout: 15_000 }).toBe(1);
    await editor.getByLabel('Caption').fill('Workshop dates for October.');
    await editor.getByLabel(/Launch poster · square_1080/).check();
    await editor.getByLabel('Alt texts').fill('Launch poster');
    // RA-07: the channel's settings are the fields its capability describes, never a JSON box.
    expect(await editor.locator('input[placeholder^="{"]').count()).toBe(0);
    expect(await editor.getByTestId('variant-settings').textContent()).toContain('Channel settings');
    await editor.getByLabel('Reply Settings (optional)').click();
    await page.getByRole('option', { name: 'following' }).click();
    await editor.getByLabel('Require Alt Text (optional)').click();
    await page.getByRole('option', { name: 'Yes' }).click();
    await editor.getByRole('button', { name: 'Save variant' }).click();
    await expect.poll(() => requestsTo('content.variants.update').length, { timeout: 15_000 }).toBe(1);
    const saved = [...backend.phase5.variants.values()].find(
      (v) => v.channelConnectionId !== null && v.version > 1,
    );
    expect(saved?.settings).toEqual({ replySettings: 'following', requireAltText: true });
    await expect
      .poll(() => detail.locator('[data-testid="variant"][data-variant-valid="true"]').count(), {
        timeout: 15_000,
      })
      .toBe(1);
    expect(await variant.textContent()).toContain('1 media item · 1 alt text');
    expect(await count('variant-editor')).toBe(0);
  }, 45_000);

  // ---- brand settings: channels (spec 14.7) ----

  it('channels show their status as text, with reconnect for an expired token', async () => {
    await open('settings');
    await expect.poll(() => count(`channel-${P5.channels.expired}`), { timeout: 15_000 }).toBe(1);
    const expired = page.getByTestId(`channel-${P5.channels.expired}`);
    expect(await expired.textContent()).toContain('Needs reconnecting');
    expect(await expired.textContent()).toContain('Token expired');
    expect(await expired.getByRole('button', { name: 'Reconnect' }).count()).toBe(1);
    expect(await page.getByTestId(`channel-${P5.channels.ok}`).textContent()).toContain('Connected');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 30_000);

  it('an uncertified provider is shown unavailable with the reason', async () => {
    // RA-01: the providers list says so before any click (the server's refusal path is covered below, for a
    // publisher who cannot read the list).
    const row = page.getByTestId('provider-facebook_page');
    await expect.poll(() => row.getByTestId('unavailable-reason').count(), { timeout: 15_000 }).toBe(1);
    expect(await row.textContent()).toContain('Unavailable');
    expect(await row.getByTestId('unavailable-reason').textContent()).toContain('Not certified');
    expect(
      await row.getByRole('button', { name: 'Connect Facebook Page' }).getAttribute('aria-disabled'),
    ).toBe('true');
  }, 30_000);

  it('RA-01: every channel provider is listed with its activation state and the reason it cannot be connected, credential references by name only', async () => {
    const ready = page.getByTestId('provider-linkedin_page');
    expect(await ready.getAttribute('data-provider-state')).toBe('ready');
    expect(await ready.textContent()).toContain('Ready');
    expect(await ready.getByTestId('credential-refs').textContent()).toContain(
      'PROVIDER_LINKEDIN_PAGE_SECRET_REF (set)',
    );
    const disabled = page.getByTestId('provider-x');
    expect(await disabled.getAttribute('data-provider-state')).toBe('disabled');
    expect(await disabled.getByTestId('unavailable-reason').textContent()).toContain(
      'Not enabled on this deployment',
    );
    expect(await disabled.getByRole('button', { name: 'Connect X' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    const missing = page.getByTestId('provider-instagram_business');
    expect(await missing.getAttribute('data-provider-state')).toBe('credentials_missing');
    expect(await missing.textContent()).toContain('Unavailable: credentials missing');
    expect(await missing.getByTestId('unavailable-reason').textContent()).toContain(
      'PROVIDER_INSTAGRAM_BUSINESS_SECRET_REF is not set',
    );
    expect(await missing.getByTestId('credential-refs').textContent()).toContain(
      'PROVIDER_INSTAGRAM_BUSINESS_SECRET_REF (not set)',
    );
    // Never a value: the names of the references only.
    expect(await page.getByTestId('providers').textContent()).not.toMatch(/secret-value|cid|csecret/);
    expect(await noHorizontalOverflow()).toBe(true);
  }, 30_000);

  it('PR-06: each provider lists every capability with its certification state; an uncertified one is labelled', async () => {
    const ready = page.getByTestId('provider-linkedin_page');
    const caps = ready.getByTestId('capability-certifications');
    const state = (capability: string) =>
      caps.locator(`[data-capability="${capability}"]`).getAttribute('data-capability-state');
    expect(await state('connect')).toBe('certified');
    expect(await state('publish_video')).toBe('uncertified');
    expect(await caps.locator('[data-capability="publish_video"]').textContent()).toContain(
      'Publish video: not certified',
    );
    // A provider that is not certified at all shows every capability it supports as not certified.
    const facebook = page.getByTestId('provider-facebook_page').getByTestId('capability-certifications');
    expect(await facebook.locator('[data-capability-state="certified"]').count()).toBe(0);
    expect(await facebook.locator('[data-capability-state="uncertified"]').count()).toBeGreaterThan(0);
    expect(await noHorizontalOverflow()).toBe(true);
  }, 30_000);

  it('RA-01: a channel shows its health as text beside its status, with the time of the last check', async () => {
    const ok = page.getByTestId(`channel-${P5.channels.ok}`);
    expect(await ok.getAttribute('data-channel-health')).toBe('ok');
    expect(await ok.textContent()).toContain('Healthy');
    expect(await ok.textContent()).toContain('Checked ');
    const expired = page.getByTestId(`channel-${P5.channels.expired}`);
    expect(await expired.getAttribute('data-channel-health')).toBe('revoked');
    expect(await expired.textContent()).toContain('Access revoked');
    expect(await expired.getByRole('button', { name: 'Reconnect' }).count()).toBe(1);
  }, 30_000);

  it('connect start gives the authorisation URL as a new-tab link (never an iframe); completion connects', async () => {
    const row = page.getByTestId('provider-linkedin_page');
    await row.getByRole('button', { name: 'Connect LinkedIn Page' }).click();
    const link = row.getByTestId('authorise-link');
    await expect.poll(() => link.count(), { timeout: 15_000 }).toBe(1);
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
    const href = (await link.getAttribute('href')) ?? '';
    expect(href.startsWith('https://provider.example/oauth/authorize')).toBe(true);
    // One callback for every brand: Meta and LinkedIn only accept redirect URIs registered exactly.
    expect(new URL(href).searchParams.get('redirect_uri')).toBe(`${origin}/connect/callback`);
    expect(await page.locator('iframe').count()).toBe(0);
    const state = new URL(href).searchParams.get('state') ?? '';
    // The provider sends the person to the callback, which hands state and code to this brand's settings page.
    await page.goto(`${origin}/connect/callback?state=${encodeURIComponent(state)}&code=auth_code_1`);
    await expect.poll(() => count('connect-callback'), { timeout: 15_000 }).toBe(1);
    expect(page.url()).toContain(`${brandPath('settings')}?state=`);
    await page.getByRole('button', { name: 'Finish connecting' }).click();
    await expect.poll(() => count('connect-completed'), { timeout: 15_000 }).toBe(1);
    expect(await text('connect-completed')).toContain('Connected: Acme LinkedIn Page (linkedin_page)');
    await expect.poll(() => text('channels'), { timeout: 15_000 }).toContain('Acme LinkedIn Page');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => page.url()).not.toContain('code=');
  }, 45_000);

  it('a login that manages several Pages: the person chooses one, only that one connects', async () => {
    const row = page.getByTestId('provider-linkedin_page');
    await row.getByRole('button', { name: 'Connect LinkedIn Page' }).click();
    await expect.poll(() => row.getByTestId('authorise-link').count(), { timeout: 15_000 }).toBe(1);
    const href = (await row.getByTestId('authorise-link').getAttribute('href')) ?? '';
    const state = new URL(href).searchParams.get('state') ?? '';
    await page.goto(`${origin}/connect/callback?state=${encodeURIComponent(state)}&code=auth_code_multi`);
    await expect.poll(() => count('connect-callback'), { timeout: 15_000 }).toBe(1);
    await page.getByRole('button', { name: 'Finish connecting' }).click();
    await expect.poll(() => count('connect-choose'), { timeout: 15_000 }).toBe(1);
    const choose = page.getByTestId('connect-choose');
    expect(await choose.getByRole('group', { name: 'Choose the account this brand connects' }).count()).toBe(
      1,
    );
    expect(await choose.getByRole('radio').count()).toBe(2);
    expect(await choose.getByRole('radio', { name: 'Ore Studio (LinkedIn Page)' }).count()).toBe(1);
    expect(await count('connect-completed')).toBe(0); // nothing connected before the choice
    const connectSelected = choose.getByRole('button', { name: 'Connect selected' });
    expect(await connectSelected.getAttribute('aria-disabled')).toBe('true');
    await choose.getByRole('radio', { name: 'Tar Studio (LinkedIn Page)' }).check();
    await connectSelected.click();
    await expect.poll(() => count('connect-completed'), { timeout: 15_000 }).toBe(1);
    expect(await text('connect-completed')).toContain('Connected: Tar Studio (linkedin_page)');
    await expect.poll(() => text('channels'), { timeout: 15_000 }).toContain('Tar Studio');
    expect(await text('channels')).not.toContain('Ore Studio');
    expect(backend.phase6.connectChoices.size).toBe(0); // one-shot: the choice is consumed
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => page.url()).not.toContain('code=');
  }, 45_000);

  it('cancelling the choice discards it and connects nothing', async () => {
    const row = page.getByTestId('provider-linkedin_page');
    await row.getByRole('button', { name: 'Connect LinkedIn Page' }).click();
    await expect.poll(() => row.getByTestId('authorise-link').count(), { timeout: 15_000 }).toBe(1);
    const href = (await row.getByTestId('authorise-link').getAttribute('href')) ?? '';
    const state = new URL(href).searchParams.get('state') ?? '';
    await page.goto(`${origin}/connect/callback?state=${encodeURIComponent(state)}&code=auth_code_multi`);
    await expect.poll(() => count('connect-callback'), { timeout: 15_000 }).toBe(1);
    await page.getByRole('button', { name: 'Finish connecting' }).click();
    await expect.poll(() => count('connect-choose'), { timeout: 15_000 }).toBe(1);
    await page.getByTestId('connect-choose').getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => count('connect-choose'), { timeout: 15_000 }).toBe(0);
    await expect.poll(() => page.url()).not.toContain('code=');
    expect(backend.phase6.connectChoices.size).toBe(0);
    expect(await text('channels')).not.toContain('Ore Studio');
  }, 45_000);

  it('reconnect rotates the expired channel back to Connected', async () => {
    const row = page.getByTestId(`channel-${P5.channels.expired}`);
    await row.getByRole('button', { name: 'Reconnect' }).click();
    await expect.poll(() => row.getByTestId('authorise-link').count(), { timeout: 15_000 }).toBe(1);
    const href = (await row.getByTestId('authorise-link').getAttribute('href')) ?? '';
    const state = new URL(href).searchParams.get('state') ?? '';
    await page.goto(`${origin}/connect/callback?state=${encodeURIComponent(state)}&code=auth_code_2`);
    await expect.poll(() => count('connect-callback'), { timeout: 15_000 }).toBe(1);
    await page.getByRole('button', { name: 'Finish connecting' }).click();
    await expect.poll(() => count('connect-completed'), { timeout: 15_000 }).toBe(1);
    await expect
      .poll(() => page.getByTestId(`channel-${P5.channels.expired}`).getAttribute('data-channel-status'), {
        timeout: 15_000,
      })
      .toBe('active');
  }, 45_000);

  it('a callback this browser did not start is not finished anywhere: the person is asked to start again', async () => {
    await page.goto(`${origin}/connect/callback?state=st_unknown&code=auth_code_x`);
    await expect.poll(() => count('connect-callback-unknown'), { timeout: 15_000 }).toBe(1);
    expect(await count('connect-callback')).toBe(0);
  }, 30_000);

  it('disconnect asks for confirmation, then the channel shows Disconnected', async () => {
    await open('settings');
    const row = page.getByTestId(`channel-${P5.channels.two}`);
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(1);
    await page.getByRole('button', { name: 'Keep connected' }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(0);
    expect(backend.phase5.channels.get(P5.channels.two)?.status).toBe('active');
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByTestId('confirm-disconnect').click();
    await expect.poll(() => row.getAttribute('data-channel-status'), { timeout: 15_000 }).toBe('disabled');
    expect(await row.textContent()).toContain('Disconnected');
    expect(await row.getByRole('button', { name: 'Connect again' }).count()).toBe(1);
    // RA-01: what happened on the remote side is said in words (X has no remote revoke in the mock).
    expect(await row.getByTestId('remote-revoke').textContent()).toContain('no remote revoke');
  }, 45_000);

  it('RA-01: a publisher, who cannot read the providers list, still gets the Release 1 list and the server’s refusal', async () => {
    backend.denied.add('operations.providers.list');
    await open('settings');
    const row = page.getByTestId('provider-facebook_page');
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
    expect(await row.getAttribute('data-provider-state')).toBe('unknown');
    await row.getByRole('button', { name: 'Connect Facebook Page' }).click();
    await expect.poll(() => row.getByTestId('unavailable-reason').count(), { timeout: 15_000 }).toBe(1);
    expect(await row.getByTestId('unavailable-reason').textContent()).toContain('Not certified');
    backend.denied.delete('operations.providers.list');
  }, 45_000);

  it('permission denied: the list and a connect attempt say so', async () => {
    backend.denied.add('publishing.channels.connect.start');
    const row = page.getByTestId('provider-instagram_business');
    await row.getByRole('button', { name: 'Connect Instagram Business' }).click();
    await expect.poll(() => row.getByTestId('connect-denied').count(), { timeout: 15_000 }).toBe(1);
    expect(await row.getByTestId('connect-denied').textContent()).toContain('channel.connect');
    backend.denied.delete('publishing.channels.connect.start');
    backend.denied.add('publishing.channels.list');
    await open('settings');
    await expect
      .poll(() => page.getByTestId('channels').textContent(), { timeout: 15_000 })
      .toContain('Permission denied');
    expect(await count('providers')).toBe(0);
    backend.denied.delete('publishing.channels.list');
  }, 45_000);
});
