import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@oremedia\//],
  skipNodeModulesBundle: true,
  // Drizzle reads SQL plus its journal from disk at runtime; ship the same migration bundle as the API image.
  onSuccess: async () => {
    await cp('../../packages/db/migrations', 'dist/migrations', { recursive: true });
  },
});
