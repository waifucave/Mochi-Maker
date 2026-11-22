/**
 * The model import within the caps on files from others: a texture whose declared size passes
 * the image caps is refused as too large (not as an unreadable file), before it is decoded.
 * The crafted files of every reader are tested in art/test/limits.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAssetStore } from '@mochi-maker/core';
import { encodePng } from '@mochi-maker/art';
import { exportModel, importModel } from '../src/index.js';
import { golden3 } from './golden.js';

describe('model import caps', () => {
  it('refuses a texture past the image caps as too large', async () => {
    const g = await golden3();
    const r = await exportModel(g.session.doc, g.assets);
    const stem = g.session.view.project().exportSettings.fileStem;
    const files = new Map(r.files);
    const texture = [...files.keys()].find((p) => p.endsWith('.png'))!;
    // A 1 × 1 PNG whose header says 100000 × 100000.
    const png = encodePng({ width: 1, height: 1, data: new Uint8Array(4) });
    new DataView(png.buffer, png.byteOffset).setUint32(16, 100_000);
    new DataView(png.buffer, png.byteOffset).setUint32(20, 100_000);
    files.set(texture, png);
    const e = await importModel(files, `${stem}.model3.json`, new MemoryAssetStore(), {
      date: '2026-11-22T00:00:00.000Z',
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'E_TOO_LARGE' });
    expect((e as Error).message).toMatch(/too large: 100000 × 100000 pixels/);
  });
});
