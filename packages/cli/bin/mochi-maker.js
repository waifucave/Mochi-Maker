#!/usr/bin/env node
// Entry point for the `mochi-maker` command. The implementation is built into ../dist.
import('../dist/main.js').then(
  (m) => m.main(process.argv.slice(2)).then((code) => process.exit(code)),
  (e) => {
    process.stderr.write(
      `mochi-maker: cannot load the built CLI (run "npm run build" first): ${e.message}\n`,
    );
    process.exit(3);
  },
);
