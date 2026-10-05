import { defineConfig } from 'vitest/config';

const shared = {
  globals: false,
  environment: 'node' as const,
  passWithNoTests: true,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: [
            'packages/**/*.test.ts',
            'apps/**/*.test.ts',
            'tooling/eslint-config/**/*.test.js',
            'tooling/scripts/**/*.test.ts',
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/*.integration.test.ts',
            '**/*.cross-tenant.test.ts',
            '**/*.time-skipping.test.ts',
            '**/*.replay.test.ts',
          ],
        },
      },
      {
        test: {
          ...shared,
          name: 'integration',
          include: [
            'packages/**/*.integration.test.ts',
            'apps/**/*.integration.test.ts',
            // PR-09: the db-backup scripts against MySQL (infra/railway/db-backup).
            'tooling/scripts/**/*.integration.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Spec 19.4 / ledger T.4: workflows on Temporal's time-skipping test server (downloaded by the SDK; CI).
        test: {
          ...shared,
          name: 'time-skipping',
          include: [
            'packages/workflows/time-skipping/**/*.time-skipping.test.ts',
            // G26: each worker app's production start function against the same server, one workflow per queue.
            'apps/**/*.time-skipping.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
      {
        // Spec 19.4 release gate: retained workflow histories replayed against the candidate bundles. No server is
        // needed; an empty run is a failure (packages/workflows/replay, docs/runbooks/workflow-replay-histories.md).
        test: {
          ...shared,
          name: 'replay',
          include: ['packages/workflows/replay/**/*.replay.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: false,
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'cross-tenant',
          include: ['tooling/test-fixtures/**/*.cross-tenant.test.ts', 'apps/**/*.cross-tenant.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'], reportsDirectory: 'coverage' },
  },
});
