import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@mochi-maker/core/node': fileURLToPath(
        new URL('./packages/core/src/node.ts', import.meta.url),
      ),
      '@mochi-maker/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@mochi-maker/geometry': fileURLToPath(
        new URL('./packages/geometry/src/index.ts', import.meta.url),
      ),
      '@mochi-maker/art': fileURLToPath(new URL('./packages/art/src/index.ts', import.meta.url)),
      '@mochi-maker/export': fileURLToPath(
        new URL('./packages/export/src/index.ts', import.meta.url),
      ),
      '@mochi-maker/api': fileURLToPath(new URL('./packages/api/src/index.ts', import.meta.url)),
      '@mochi-maker/bridge': fileURLToPath(
        new URL('./packages/bridge/src/index.ts', import.meta.url),
      ),
      '@mochi-maker/mcp': fileURLToPath(new URL('./packages/mcp/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The tests and the conformance pack run with glue and blend-shape authoring on; the tests of
    // the off behavior pass their features explicitly.
    env: { MOCHI_MAKER_FEATURES: 'glue,blendShapes' },
  },
});
