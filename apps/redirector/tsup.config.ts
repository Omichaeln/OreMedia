import { defineConfig } from 'tsup';

/** Same layout as apps/api: workspace packages inlined, third-party packages resolved from the image's node_modules. */
export default defineConfig({
  // main.ts is the configuration gate; it imports ./start.js only once the variables are present (as the workers do).
  entry: { main: 'src/main.ts', start: 'src/start.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@oremedia\//],
  skipNodeModulesBundle: true,
});
