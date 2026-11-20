import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe('the core', () => {
  it('uses Node APIs only in node.ts, so it runs in browsers and workers', () => {
    const offenders = files(SRC).filter(
      (f) =>
        !f.endsWith('/node.ts') && /from 'node:|require\(|process\./.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('has no randomness or clock in the command path', () => {
    const offenders = files(SRC).filter((f) =>
      /Math\.random|Date\.now|new Date\(|performance\.now/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
