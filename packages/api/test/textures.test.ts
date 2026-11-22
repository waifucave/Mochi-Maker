/**
 * Textures and models from others, with Mochi2D 0.24.0's caps (docs/limits.md): a crafted texture
 * past the caps, and a lying one (a few hundred bytes declaring a huge size), through each place
 * Mochi Maker reads a model or a picture it did not make: model import from a folder and from a
 * zip (API, command line, MCP), a project holding a crafted picture (its preview build, its
 * render, its export), Mochi2D's own loads and renders, and the export's check that it never
 * writes a texture Mochi2D refuses. Also: a model with a compressed motion sound, and pictures in
 * formats Mochi Maker does not read.
 */
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { LIMITS, MemoryAssetStore, MochiError, saveProject } from '@mochi-maker/core';
import { NodeFileSystem } from '@mochi-maker/core/node';
import { decodePng, readArt } from '@mochi-maker/art';
import { BUILD_TEXTURES, exportModel, importModel, type ExportProblem } from '@mochi-maker/export';
import { Project } from '@mochi-maker/api';
import { MochiMcpServer } from '@mochi-maker/mcp';
import { openPackRenderer } from '../src/conformance.js';
import { checkTextures } from '../../export/src/export.js';
import { main } from '../../cli/src/main.js';
import { golden13, golden3 } from '../../export/test/golden.js';

import { LIE, LIE_PAST, PAST, honest } from './crafted.js';

const mkdir = (name: string) => mkdtempSync(join(tmpdir(), `mochi-${name}-`));

// ---------------------------------------------------------------- a model from others

/** Golden 3's export, with its texture replaced. */
async function model(texture?: Uint8Array) {
  const g = await golden3();
  const r = await exportModel(g.session.doc, g.assets);
  const files = new Map(r.files);
  const stem = g.session.view.project().exportSettings.fileStem;
  const tex = [...files.keys()].find((p) => p.endsWith('.png'))!;
  if (texture) files.set(tex, texture);
  return { files, settings: `${stem}.model3.json`, tex };
}
function folderOf(files: Map<string, Uint8Array>) {
  const dir = mkdir('model');
  for (const [p, b] of files) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), b);
  }
  return dir;
}
function zipOf(files: Map<string, Uint8Array>) {
  const path = join(mkdir('zip'), 'model.zip');
  writeFileSync(path, zipSync(Object.fromEntries([...files].map(([p, b]) => [`m/${p}`, b]))));
  return path;
}

const refusal = (e: unknown) => ({
  code: (e as MochiError).code,
  message: (e as Error).message,
});

/** The words of the three refusals. */
function expectPast(r: { code?: string; message: string }) {
  expect(r.code).toBe('E_TOO_LARGE');
  expect(r.message).toMatch(/too large: 20000 × 1000 pixels, more than the 16384 pixels a side/);
}
function expectLie(r: { code?: string; message: string }) {
  expect(r.code).not.toBe('E_TOO_LARGE');
  expect(r.message).toMatch(/damaged or crafted: its image data holds less than the 8000 × 8000/);
  expect(r.message).not.toMatch(/too large/);
}
function expectLiePast(r: { code?: string; message: string }) {
  expect(r.code).toBe('E_TOO_LARGE');
  expect(r.message).toMatch(/100000 × 100000 pixels/);
}

describe('model import', () => {
  it('imports the same model from a folder and from a zip', async () => {
    const { files } = await model();
    const a = await Project.importModel(folderOf(files), mkdir('a'), { date: 'd' });
    const b = await Project.importModel(zipOf(files), mkdir('b'), { date: 'd' });
    expect(Object.keys(b.project.session.doc.objects).length).toBe(
      Object.keys(a.project.session.doc.objects).length,
    );
    expect(b.report.skipped).toEqual(a.report.skipped);
    await a.project.close();
    await b.project.close();
  });

  it('refuses a texture past the caps, and a lying one, from a folder and from a zip', async () => {
    for (const [texture, expectation] of [
      [PAST, expectPast],
      [LIE, expectLie],
      [LIE_PAST, expectLiePast],
    ] as const) {
      const { files } = await model(texture);
      for (const from of [folderOf(files), zipOf(files)]) {
        const e = await Project.importModel(from, mkdir('p'), { date: 'd' }).catch(refusal);
        expectation(e as { code: string; message: string });
      }
    }
  });

  it('refuses them through the command line and the MCP server', async () => {
    const quiet = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    ];
    let stderr = '';
    quiet[1]!.mockImplementation((s) => ((stderr += String(s)), true));
    try {
      const code = await main(['import-model', zipOf((await model(PAST)).files), mkdir('c')]);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/too large: 20000 × 1000 pixels/);
    } finally {
      for (const q of quiet) q.mockRestore();
    }
    const root = mkdir('mcp');
    const lie = folderOf((await model(LIE)).files);
    const target = join(root, 'p');
    const server = new MochiMcpServer({ allowDirs: [root, lie] });
    const r = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'mochi_project',
        arguments: { action: 'importModel', model: lie, path: target },
      },
    })) as { result: { isError?: boolean; structuredContent: { error: { message: string } } } };
    expect(r.result.isError).toBe(true);
    expectLie({ message: r.result.structuredContent.error.message });
    await server.close();
  });

  it('refuses an oversized file in a model folder or a model zip, before reading it', async () => {
    const { files } = await model();
    const big = new Uint8Array(LIMITS.model.maxEntryBytes + 1);
    files.set('motions/big.motion3.json', big);
    for (const from of [folderOf(files), zipOf(files)]) {
      const e = await Project.importModel(from, mkdir('p'), { date: 'd' }).catch(refusal);
      expect(e).toMatchObject({ code: 'E_TOO_LARGE' });
      expect((e as { message: string }).message).toMatch(/big\.motion3\.json is too large: 64 MiB/);
    }
  });

  it('leaves out a compressed motion sound, saying what it is', async () => {
    const g = await golden13();
    const r = await exportModel(g.session.doc, g.assets);
    const files = new Map(r.files);
    const wav = [...files.keys()].find((p) => p.endsWith('.wav'))!;
    // An MP3 frame header, then nothing: what a renamed MP3 starts with.
    files.set(
      wav,
      Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]),
    );
    const back = await importModel(files, 'golden13.model3.json', new MemoryAssetStore(), {
      date: 'd',
    });
    expect(back.report.skipped).toEqual([
      expect.objectContaining({
        what: `sound ${wav}`,
        why: expect.stringMatching(
          /It is MP3 audio\. A project keeps motion sounds as WAV files only/,
        ),
      }),
    ]);
    // The motion itself comes along, without its sound.
    const motions = Object.values(back.document.objects).filter((o) => o.kind === 'motion');
    expect(motions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- a project from others

describe('a project holding a crafted picture', () => {
  /** Golden 3 saved as a project folder, its first layer's picture replaced. */
  async function project(picture: Uint8Array) {
    const g = await golden3();
    const dir = mkdir('proj');
    await saveProject(new NodeFileSystem(), dir, g.session.doc, g.assets);
    const asset = readdirSync(join(dir, 'assets')).find((f) => f.endsWith('.png'))!;
    writeFileSync(join(dir, 'assets', asset), picture);
    return Project.open(dir);
  }

  it('refuses it in the export and the render, before Mochi2D sees it', async () => {
    for (const [picture, expectation] of [
      [PAST, expectPast],
      [LIE, expectLie],
    ] as const) {
      const p = await project(picture);
      expectation((await p.export(mkdir('out')).catch(refusal)) as never);
      expectation((await p.render({ width: 32, height: 32 }).catch(refusal)) as never);
      await p.close();
    }
  });
});

// ---------------------------------------------------------------- what Mochi2D is given

describe('the caps Mochi Maker passes Mochi2D', () => {
  it('are LIMITS, with its own builds checked against what an export may hold', () => {
    expect(LIMITS.textures).toEqual({
      maxSide: LIMITS.imageSide,
      maxPixels: LIMITS.imagePixels,
      maxTotalPixels: LIMITS.layerPixels,
    });
    expect(LIMITS.modelFiles).toEqual({
      maxFileBytes: LIMITS.model.maxEntryBytes,
      maxTotalBytes: LIMITS.model.maxTotalBytes,
    });
    expect(BUILD_TEXTURES).toEqual({ maxSide: 16384, maxPixels: 2 ** 27, maxTotalPixels: 2 ** 30 });
  });

  it('an export never holds a texture Mochi2D refuses by default, and warns past the caps for others', () => {
    const pages = (n: number) => {
      const files = new Map<string, Uint8Array>();
      const page = honest(8192, 8192);
      for (let i = 0; i < n; i++) files.set(`t/${i}.png`, page);
      return files;
    };
    const run = (files: Map<string, Uint8Array>) => {
      const problems: ExportProblem[] = [];
      checkTextures([...files.keys()], files, problems);
      return problems.map((p) => [p.severity, p.code]);
    };
    expect(run(pages(4))).toEqual([]); // 2^28 pixels: within the caps for models from others
    expect(run(pages(5))).toEqual([['warning', 'textures-past-caps-for-others']]);
    expect(run(pages(17))).toEqual([['error', 'textures-too-large']]); // past 2^30
    const one = new Map([['t/a.png', LIE]]);
    expect(run(one)).toEqual([['error', 'texture-refused']]); // Mochi2D: too short to hold it
  });
});

// ---------------------------------------------------------------- pictures in other formats

describe('pictures that are not PNG', () => {
  const JPEG = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0,
    0, 17, 8, 0, 16, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
  const AVIF = Uint8Array.from([
    0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0, 0x61, 0x76, 0x69,
    0x66,
  ]);
  const TIFF = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);

  it('are refused as art, naming the format', async () => {
    const dir = mkdir('art');
    const fs = new NodeFileSystem();
    for (const [name, bytes, words] of [
      ['a.png', JPEG, /a\.png is a JPEG image, not a PNG\. Mochi Maker reads PNG images/],
      ['b.png', AVIF, /b\.png is an AVIF image, not a PNG.*not a texture format models can use/],
      ['c.png', TIFF, /c\.png is a TIFF image/],
    ] as const) {
      writeFileSync(join(dir, name), bytes);
      await expect(readArt({ fs } as never, join(dir, name))).rejects.toThrow(words);
    }
    expect(() => decodePng(JPEG, 'x')).toThrow(/x is a JPEG image/);
  });

  it('are refused as a model’s texture, naming the format', async () => {
    const { files, settings } = await model(JPEG);
    const e = await importModel(files, settings, new MemoryAssetStore(), { date: 'd' }).catch(
      refusal,
    );
    expect(e).toMatchObject({ code: 'E_MODEL_IMPORT' });
    expect((e as { message: string }).message).toMatch(/The texture .* is a JPEG image, not a PNG/);
  });
});

// ---------------------------------------------------------------- Mochi2D's renders

const renderer = await openPackRenderer().catch(() => null);
afterAll(() => renderer?.close());
const required = process.env.MOCHI_MAKER_REQUIRE_RENDER === '1';

describe.runIf(renderer !== null || required)('Mochi2D’s render, with the caps passed', () => {
  it('refuses a texture within Mochi2D’s defaults but past Mochi Maker’s, and a lying one', async () => {
    expect(renderer, 'rendering needs Playwright and Chromium').not.toBeNull();
    const size = { width: 16, height: 16 };
    const { files, settings } = await model();
    await expect(renderer!.render(files, settings, size)).resolves.toMatchObject({ width: 16 });
    // 16,384 × 16,384: 2^28 pixels, Mochi2D's default cap, past BUILD_TEXTURES' 2^27.
    const big = await model(honest(16384, 16384));
    const e = await renderer!.render(big.files, big.settings, size).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: 'TextureLimitError', kind: 'pixels', limit: 2 ** 27 });
    const lie = await model(LIE);
    const f = await renderer!.render(lie.files, lie.settings, size).catch((x: unknown) => x);
    expect(f).toMatchObject({ name: 'TextureFormatError' });
  }, 120_000);
});
