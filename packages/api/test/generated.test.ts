/** The generated method layer is current: one method per command, with its docs. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { generateMethodLayer } from '../src/codegen.js';

it('matches the command registry', () => {
  const path = join(import.meta.dirname, '../src/generated.ts');
  const text = generateMethodLayer();
  if (process.env.UPDATE_GENERATED === '1') writeFileSync(path, text);
  expect(readFileSync(path, 'utf8')).toBe(text);
});
