import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BudgetExhaustedError } from '@oremedia/contracts/errors';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { budgetReservations, usageLedger } from '@oremedia/db/schema/billing';
import { newId } from '@oremedia/domain/ids';
import { budgets } from './budgets';
import { entitlements } from './entitlements';

const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'service_principal', id: 'sp_1' },
  brandIds: 'all',
  correlationId: 'corr_budget',
});

describe('budgets (spec 12.6) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const deadline = new Date(Date.now() + 3600_000);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: 'bud-' + tenantA.slice(-6).toLowerCase() });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('entitlements resolve to the pilot plan when no subscription exists; check() returns reasons', async () => {
    await runInTenant(ctx(tenantA), async () => {
      const set = await entitlements.resolve(tenantA);
      expect(set.limits.brands).toBe(5);
      expect(set.features.managed_autopublish).toBe(false);
      expect((await entitlements.check(tenantA, 'managed_autopublish')).reason).toBe('feature_not_in_plan');
      expect((await entitlements.check(tenantA, 'experiments')).allowed).toBe(true);
      expect((await entitlements.check(tenantA, 'channels')).allowed).toBe(true);
    });
  });

  it('parallel reservations cannot overspend the brand-day limit', async () => {
    await runInTenant(ctx(tenantA), () => budgets.setLimit(brandA, 'day', 10_000_000));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        runInTenant(ctx(tenantA), () => budgets.reserveSpend(brandA, newId('agentRun'), 3_000_000, deadline)),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const exhausted = results.filter(
      (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof BudgetExhaustedError,
    ).length;
    expect(ok).toBe(3); // 3 × 3,000,000 ≤ 10,000,000 < 4 × 3,000,000
    expect(exhausted).toBe(5);
    const held = await tdb.db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.tenantId, tenantA));
    expect(held.reduce((s, r) => s + r.reservedMicros, 0)).toBeLessThanOrEqual(10_000_000);
  });

  it('consumption is ledgered; exceeding the reservation ends with budget_exhausted; settle releases the remainder', async () => {
    const runId = newId('agentRun');
    await runInTenant(ctx(tenantA), async () => {
      await budgets.setLimit(brandA, 'day', 100_000_000);
      const r = await budgets.reserveSpend(brandA, runId, 1_000_000, deadline);
      await budgets.consume(r.id, brandA, 'model_tokens', 1200, 'tokens', 400_000, 'step_1');
      await budgets.consume(r.id, brandA, 'tool_call', 1, 'call', 100_000, 'step_2');
      await expect(
        budgets.consume(r.id, brandA, 'image_generation', 1, 'image', 800_000, 'step_3'),
      ).rejects.toBeInstanceOf(BudgetExhaustedError);
      await budgets.settle(runId);
      const row = (
        await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId))
      )[0]!;
      expect(row.state).toBe('settled');
      expect(row.consumedMicros).toBe(1_300_000);
      const ledger = await tdb.db.select().from(usageLedger).where(eq(usageLedger.reservationId, r.id));
      expect(ledger.length).toBe(3);
      await budgets.settle(runId); // idempotent
    });
  });

  it('a charge keyed by its tool call is ledgered once across retries; distinct calls each charge, also in parallel', async () => {
    const runId = newId('agentRun');
    await runInTenant(ctx(tenantA), async () => {
      await budgets.setLimit(brandA, 'day', 100_000_000);
      const r = await budgets.reserveSpend(brandA, runId, 1_000_000, deadline);
      const charge = (key: string, micros: number) =>
        budgets.consume(r.id, brandA, 'image_generation', 1, 'call', micros, 'step_1', key);
      // The activity is retried after the charge committed (Temporal re-runs dispatchTool for the same call).
      await charge('tool_call:a', 300_000);
      await charge('tool_call:a', 300_000);
      // Distinct calls of the same step in parallel, plus a duplicate delivery of one of them.
      await Promise.all([
        charge('tool_call:b', 100_000),
        charge('tool_call:c', 100_000),
        charge('tool_call:d', 100_000),
        charge('tool_call:e', 100_000),
        charge('tool_call:e', 100_000),
      ]);
      const reservation = async () =>
        (await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.id, r.id)))[0]!;
      expect((await reservation()).consumedMicros).toBe(700_000);
      const ledger = await tdb.db.select().from(usageLedger).where(eq(usageLedger.reservationId, r.id));
      expect(ledger.map((l) => l.idempotencyKey).sort()).toEqual([
        'tool_call:a',
        'tool_call:b',
        'tool_call:c',
        'tool_call:d',
        'tool_call:e',
      ]);
      // Overspend protection is unchanged: the charge is ledgered, the run ends; its retry still ends the run
      // and charges nothing more.
      await expect(charge('tool_call:f', 400_000)).rejects.toBeInstanceOf(BudgetExhaustedError);
      await expect(charge('tool_call:f', 400_000)).rejects.toBeInstanceOf(BudgetExhaustedError);
      expect((await reservation()).consumedMicros).toBe(1_100_000);
      // A closed reservation refuses even a charge it has already recorded.
      await budgets.settle(runId);
      await expect(charge('tool_call:a', 300_000)).rejects.toBeInstanceOf(BudgetExhaustedError);
      const after = await tdb.db.select().from(usageLedger).where(eq(usageLedger.reservationId, r.id));
      expect(after).toHaveLength(6);
    });
  });

  it('a cancelled run counts what it consumed toward the day and month caps; one that consumed nothing counts nothing', async () => {
    const brandB = newId('brand');
    await tdb.db.insert(brands).values({
      id: brandB,
      tenantId: tenantA,
      name: 'B',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await runInTenant(ctx(tenantA), async () => {
      await budgets.setLimit(brandB, 'day', 5_000_000);
      const before = await budgets.summary(brandB);
      expect(before.day.committedMicros).toBe(0);
      // Spent 1.5 of the 2 reserved, then cancelled: the remainder is released, the spend stays.
      const spentRun = newId('agentRun');
      const spent = await budgets.reserveSpend(brandB, spentRun, 2_000_000, deadline);
      await budgets.consume(spent.id, brandB, 'model_tokens', 900, 'tokens', 1_500_000, 'cancelled_step');
      await budgets.release(spentRun);
      // Reserved and released before anything ran: nothing is committed.
      const idleRun = newId('agentRun');
      await budgets.reserveSpend(brandB, idleRun, 2_000_000, deadline);
      await budgets.release(idleRun);
      const after = await budgets.summary(brandB);
      expect(after.reservations.map((r) => [r.state, r.consumedMicros]).sort()).toEqual([
        ['released', 0],
        ['released', 1_500_000],
      ]);
      expect(after.day.committedMicros).toBe(1_500_000);
      expect(after.month.committedMicros - before.month.committedMicros).toBe(1_500_000);
      expect(after.day.remainingMicros).toBe(3_500_000);
      // The cap holds with it: 3.5 remain, so a 4 reservation is refused and a 3.5 one fits.
      await expect(
        budgets.reserveSpend(brandB, newId('agentRun'), 4_000_000, deadline),
      ).rejects.toBeInstanceOf(BudgetExhaustedError);
      await expect(
        budgets.reserveSpend(brandB, newId('agentRun'), 3_500_000, deadline),
      ).resolves.toBeDefined();
    });
  });
  it('a cost incurred after the reservation closed is ledgered, counts toward the caps and is charged once per key', async () => {
    const brandC = newId('brand');
    await tdb.db.insert(brands).values({
      id: brandC,
      tenantId: tenantA,
      name: 'C',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await runInTenant(ctx(tenantA), async () => {
      await budgets.setLimit(brandC, 'day', 5_000_000);
      const runId = newId('agentRun');
      const r = await budgets.reserveSpend(brandC, runId, 2_000_000, deadline);
      await budgets.consume(r.id, brandC, 'model_tokens', 10, 'tokens', 1_000_000, 'step_1');
      await budgets.release(runId);
      // A model call that was already under way when the run was cancelled: the closed reservation still takes it.
      await expect(budgets.consume(r.id, brandC, 'model_tokens', 10, 'tokens', 1, 'late')).rejects.toThrow(
        BudgetExhaustedError,
      );
      const late = await budgets.consumeIncurred(
        r.id,
        brandC,
        'model_tokens',
        20,
        'tokens',
        1_500_000,
        'step_2',
        'late_key',
      );
      expect(late).toEqual({ closed: true, exceeded: false });
      // A replay of the same charge is not doubled.
      await budgets.consumeIncurred(
        r.id,
        brandC,
        'model_tokens',
        20,
        'tokens',
        1_500_000,
        'step_2',
        'late_key',
      );
      const ledgerRows = await tdb.db.select().from(usageLedger).where(eq(usageLedger.reservationId, r.id));
      expect(ledgerRows.map((l) => l.costMicros).sort()).toEqual([1_000_000, 1_500_000]);
      const summary = await budgets.summary(brandC);
      expect(summary.day.committedMicros).toBe(2_500_000);
      expect(summary.day.remainingMicros).toBe(2_500_000);
      await expect(
        budgets.reserveSpend(brandC, newId('agentRun'), 2_500_001, deadline),
      ).rejects.toBeInstanceOf(BudgetExhaustedError);
      await expect(
        budgets.reserveSpend(brandC, newId('agentRun'), 2_500_000, deadline),
      ).resolves.toBeDefined();
    });
  });
});
