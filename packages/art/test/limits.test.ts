/**
 * The caps on what Mochi Maker reads from others (core's LIMITS, docs/limits.md), with crafted
 * files. Each crafted file is built by crafted.mjs and read there, in a fresh Node process, which
 * reports how much its peak memory grew while reading: the meter case shows the measure works (a
 * PNG whose data inflates to 256 MiB, decoded by fast-png alone, takes hundreds of MiB), and every
 * crafted case must be refused within a few MiB. A cap passed says "too large" (E_TOO_LARGE); a
 * file that is damaged or crafted to inflate past what it declares is refused as damaged.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  Budget,
  LIMITS,
  MemoryFileSystem,
  MochiError,
  formatSize,
  isTooLarge,
  loadProject,
  readCapped,
} from '@mochi-maker/core';
import { decodePng, encodePng, readZip } from '@mochi-maker/art';

const ROOT = join(import.meta.dirname, '../../..');
const PROBE = join(import.meta.dirname, 'crafted.mjs');
const run = promisify(execFile);

interface Probe {
  ok?: unknown;
  code?: string | null;
  message?: string;
  peakMiB: number;
}

let results: Record<string, Probe> = {};

/** Every case, at most four processes at a time (the meter takes most of a GiB). */
const CASES = [
  'meter',
  'png-side',
  'png-pixels',
  'png-bomb',
  'png-profile',
  'psd-ok',
  'psd-canvas',
  'psd-layer',
  'psd-layers',
  'psd-total',
  'psd-zip',
  'ora-entry',
  'ora-bomb',
  'ora-entries',
  'ora-layer',
  'art-file',
  'model-file',
  'model-total',
  'model-count',
  'project-file',
  'project-total',
  'template-entry',
  'template-bomb',
];

beforeAll(async () => {
  // The probe reads the built packages: bring them up to date (incremental).
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/typescript/bin/tsc'),
      '-b',
      'packages/geometry',
      'packages/core',
      'packages/art',
      'packages/export',
      'packages/api',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  const queue = [...CASES];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const { stdout } = await run(process.execPath, [PROBE, c], {
        cwd: ROOT,
        maxBuffer: 1 << 20,
      });
      results[c] = JSON.parse(stdout.trim().split('\n').at(-1)!) as Probe;
    }
  };
  results = {};
  await Promise.all([worker(), worker(), worker(), worker()]);
}, 300_000);

/** A refusal: its code, words, and how little memory it took. */
function refused(name: string, code: string, words: RegExp) {
  const r = results[name]!;
  expect(r.code, `${name}: ${r.message}`).toBe(code);
  expect(r.message).toMatch(words);
  if (code === 'E_TOO_LARGE') expect(r.message).toMatch(/too large/);
  else expect(r.message).not.toMatch(/too large/);
  expect(r.peakMiB, `${name}: peak memory`).toBeLessThan(48);
}

describe('the meter', () => {
  it('sees what an unchecked reader takes: fast-png alone on 256 MiB of image data', () => {
    expect(results.meter!.peakMiB).toBeGreaterThan(256);
  });
  it('reads a small hand-written PSD (the crafting is right)', () => {
    expect(results['psd-ok']).toMatchObject({ ok: { layers: 1, width: 8 } });
  });
});

describe('PNG', () => {
  it('refuses a declared size past the caps before decoding', () => {
    refused('png-side', 'E_TOO_LARGE', /100000 × 100000 pixels.*16384 pixels a side/);
    refused('png-pixels', 'E_TOO_LARGE', /16000 × 16000 pixels.*134,217,728 pixels/);
  });
  it('stops image data that inflates past what its size holds, as damaged', () => {
    refused('png-bomb', 'E_ASSET_FORMAT', /damaged or crafted.*64 × 64/);
  });
  it('refuses an embedded color profile past its cap', () => {
    refused('png-profile', 'E_TOO_LARGE', /color profile is too large.*16 MiB/);
  });
});

describe('PSD', () => {
  it('refuses a canvas, a layer, the number of layers and their total past the caps', () => {
    refused('psd-canvas', 'E_TOO_LARGE', /30000 × 30000 pixels/);
    refused('psd-layer', 'E_TOO_LARGE', /layer .*20000 × 20000 pixels/);
    refused('psd-layers', 'E_TOO_LARGE', /2,001 layers, more than the 2,000 layers/);
    refused('psd-total', 'E_TOO_LARGE', /layers, together, is too large.*268,435,456 pixels/);
  });
  it('stops a zip-compressed channel that inflates past its layer, as damaged', () => {
    refused('psd-zip', 'E_ASSET_FORMAT', /damaged or crafted.*compressed channel/);
  });
});

describe('OpenRaster (Mochi2D’s zip reader, with our caps)', () => {
  it('refuses an entry declared past the caps, and too many entries', () => {
    refused('ora-entry', 'E_TOO_LARGE', /entry\.ora.*1 GiB/);
    refused('ora-entries', 'E_TOO_LARGE', /4,001 files, more than the 4,000 files/);
  });
  it('stops an entry that inflates past its declared size, as damaged', () => {
    refused('ora-bomb', 'E_ASSET_FORMAT', /damaged.*inflates past the 100 bytes/);
  });
  it('refuses a layer PNG past the image caps', () => {
    refused('ora-layer', 'E_TOO_LARGE', /layer\.ora\/a\.png is too large/);
  });
});

describe('files and folders on disk, by their sizes before reading', () => {
  it('refuses an art file past its cap', () => {
    refused('art-file', 'E_TOO_LARGE', /big\.psd is too large: 600 MiB.*512 MiB/);
  });
  it('reads a model folder within Mochi2D’s caps for models from strangers', () => {
    refused('model-file', 'E_TOO_LARGE', /texture\.png is too large: 100 MiB.*64 MiB/);
    refused('model-total', 'E_TOO_LARGE', /all files together, is too large: 300 MiB.*256 MiB/);
    refused('model-count', 'E_TOO_LARGE', /2,001 files.*2,000 files.*model's own folder/);
  });
  it('reads a project folder within its caps', () => {
    refused('project-file', 'E_TOO_LARGE', /parts\.json is too large: 100 MiB.*64 MiB/);
    refused('project-total', 'E_TOO_LARGE', /all its files together, is too large: 540 MiB/);
  });
  it('reads a template within the caps of a zipped project', () => {
    refused('template-entry', 'E_TOO_LARGE', /template\.json is too large: 1 GiB.*256 MiB/);
    refused('template-bomb', 'E_ASSET_FORMAT', /damaged.*inflates past the 10 bytes/);
  });
});

describe('the caps in process', () => {
  it('counts what an archive inflates, all entries together', async () => {
    const z = zipSync({ a: new Uint8Array(3000), b: new Uint8Array(3000) });
    const caps = { maxEntryBytes: 4000, maxTotalBytes: 5000, maxEntries: 10 };
    const e = await readZip('t.zip', z, caps).catch((x: unknown) => x);
    expect(isTooLarge(e)).toBe(true);
    expect((e as MochiError).message).toMatch(/t\.zip, all files read together, is too large/);
    expect((await readZip('t.zip', z, { ...caps, maxTotalBytes: 6000 })).size).toBe(2);
    // Not a zip at all: damaged, not too large.
    const bad = await readZip('x.zip', strToU8('hello'), caps).catch((x: unknown) => x);
    expect(bad).toMatchObject({ code: 'E_ASSET_FORMAT' });
  });

  it('refuses a project folder with more object files than the cap, before reading them', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeText('p/mochi-project.json', '{}');
    const empty = new Uint8Array(0);
    for (let i = 0; i <= LIMITS.projectFiles; i++) fs.files.set(`p/meshes/${i}.json`, empty);
    const e = await loadProject(fs, 'p').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'E_TOO_LARGE' });
    expect((e as Error).message).toMatch(/50,001 object files, more than the 50,000/);
  });

  it('reads a file within its cap, also where the file system cannot tell sizes', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeBytes('a.bin', new Uint8Array(100));
    await expect(readCapped(fs, 'a.bin', 99)).rejects.toThrow(/too large: 100 bytes/);
    const blind = { ...fs, size: undefined, readBytes: (p: string) => fs.readBytes(p) };
    await expect(readCapped(blind as never, 'a.bin', 99)).rejects.toThrow(/too large/);
    expect((await readCapped(fs, 'a.bin', 100)).length).toBe(100);
  });

  it('keeps a budget across layers and names the cap in the message', () => {
    const b = new Budget(10, 'The layers, together,', 'pixels');
    b.take(6);
    expect(() => b.take(5)).toThrow(/The layers, together, is too large: 11 pixels/);
    expect(formatSize(512 * 2 ** 20)).toBe('512 MiB');
    expect(formatSize(1.5 * 2 ** 30)).toBe('1.5 GiB');
    expect(formatSize(2000, 'files')).toBe('2,000 files');
  });

  it('decodes ordinary PNGs as before, at every size up to the caps’ edge', () => {
    for (const [w, h] of [
      [1, 1],
      [300, 7],
      [LIMITS.imageSide, 1],
    ] as const) {
      const data = new Uint8Array(w * h * 4).map((_, i) => (i * 7) & 255);
      const img = decodePng(encodePng({ width: w, height: h, data }));
      expect([img.width, img.height]).toEqual([w, h]);
      expect(Buffer.from(img.data).equals(Buffer.from(data))).toBe(true);
    }
  });
});
