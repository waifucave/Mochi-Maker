import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (pkg: string, file = 'index.ts') =>
  fileURLToPath(new URL(`../${pkg}/src/${file}`, import.meta.url));

// The editor bundles the workspace packages from their sources, like the tests do.
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@mochi-maker/core': src('core'),
      '@mochi-maker/geometry': src('geometry'),
      '@mochi-maker/art': src('art'),
      '@mochi-maker/export': src('export'),
      '@mochi-maker/api/browser': src('api', 'browser.ts'),
    },
  },
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 4096 },
});
