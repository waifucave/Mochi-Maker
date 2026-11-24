/**
 * The desktop's folder reads: a project or model folder is checked against the caps by its
 * files' sizes on disk before any file is read, with the caps the core's LIMITS has.
 */
import { mkdtempSync, mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@mochi-maker/core';
import { CAPS, checkFileSize, readFolder } from '../src/projectfs.js';

/**
 * The limit for the tests here that build folders past a cap on disk: the longest took 0.32 s.
 */
const WORK = 30_000;

const MiB = 2 ** 20;

function folder(files: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-desktop-'));
  for (const [p, size] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), '');
    truncateSync(join(dir, p), size); // sparse
  }
  return dir;
}

describe('desktop folder reads', () => {
  it('uses the core’s caps', () => {
    expect(CAPS.project).toEqual(LIMITS.projectArchive);
    expect(CAPS.model).toEqual(LIMITS.model);
    expect(CAPS.fileBytes).toBe(LIMITS.fileBytes);
  });

  it('refuses a folder over a cap before reading it', { timeout: WORK }, async () => {
    const before = process.memoryUsage().arrayBuffers;
    await expect(readFolder(folder({ 'a.png': 100 * MiB }), CAPS.model)).rejects.toThrow(
      /a\.png is too large: 100 MiB, more than the 64 MiB/,
    );
    const many: Record<string, number> = {};
    for (let i = 0; i < 6; i++) many[`t${i}.png`] = 60 * MiB;
    await expect(readFolder(folder(many), CAPS.model)).rejects.toThrow(
      /all files together, is too large: 360 MiB, more than the 256 MiB/,
    );
    const count: Record<string, number> = {};
    for (let i = 0; i <= 2000; i++) count[`f/${i}`] = 1;
    await expect(readFolder(folder(count), CAPS.model)).rejects.toThrow(
      /too large: 2,001 files, more than the 2,000 files/,
    );
    await expect(checkFileSize(join(folder({ 'x.psd': 600 * MiB }), 'x.psd'))).rejects.toThrow(
      /too large: 600 MiB, more than the 512 MiB/,
    );
    // Nothing of the 600 MiB (or 360 MiB) was read.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * MiB);
    // Within the caps, the files are read.
    const ok = await readFolder(folder({ 'a.json': 10, 'b/c.png': 20 }), CAPS.model);
    expect(ok.map(([p, b]) => [p, b.length]).sort()).toEqual([
      ['a.json', 10],
      ['b/c.png', 20],
    ]);
  });
});
