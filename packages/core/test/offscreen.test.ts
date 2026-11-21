/**
 * Version 6 in the document: part offscreens and blend modes. The commands, the invariants that
 * keep an offscreen part in its own sorting scope, what deleting a mask does, and the migration
 * from project format 14.
 */
import { describe, expect, it } from 'vitest';
import {
  ALPHA_BLENDS,
  COLOR_BLENDS,
  DocView,
  MANIFEST,
  MemoryAssetStore,
  MemoryFileSystem,
  MochiError,
  blendCode,
  canonicalText,
  checkInvariants,
  isCompatibleBlend,
  loadProject,
  saveProject,
  type ArtMesh,
} from '@mochi-maker/core';
import { ASSET, fixtureSession } from './fixture.js';

const part = (s: ReturnType<typeof fixtureSession>, ref: string) =>
  s.view.getAs(s.view.resolve(ref, ['part'], 'ref'), 'part');
const mesh = (s: ReturnType<typeof fixtureSession>, ref: string) =>
  s.view.getAs(s.view.resolve(ref, ['artMesh'], 'ref'), 'artMesh');

describe('blend modes', () => {
  it('numbers the color functions and alpha modes as Mochi2D’s table does', () => {
    // Mochi2D's docs/moc-data.md, "Blend codes and offscreen flags", in code order.
    expect([...COLOR_BLENDS]).toEqual([
      'normal',
      'additive',
      'multiplicative',
      'add',
      'addGlow',
      'darken',
      'multiply',
      'colorBurn',
      'linearBurn',
      'lighten',
      'screen',
      'colorDodge',
      'overlay',
      'softLight',
      'hardLight',
      'linearLight',
      'hue',
      'color',
    ]);
    expect([...ALPHA_BLENDS]).toEqual(['over', 'atop', 'out', 'conjoint', 'disjoint']);
    // The table's example: 0x106 is atop + multiply.
    expect(blendCode({ color: 'multiply', alpha: 'atop' })).toBe(0x106);
  });

  it('codes a blend mode as the color function plus 256 times the alpha mode', () => {
    expect(blendCode({ color: 'normal', alpha: 'over' })).toBe(0);
    expect(blendCode({ color: 'overlay', alpha: 'atop' })).toBe(12 + 256);
    expect(blendCode({ color: 'color', alpha: 'disjoint' })).toBe(17 + 4 * 256);
    expect(isCompatibleBlend({ color: 'additive', alpha: 'atop' })).toBe(true);
    expect(isCompatibleBlend({ color: 'normal', alpha: 'out' })).toBe(false);
  });

  it('keeps the blends every version has as legacy blending', () => {
    const s = fixtureSession();
    s.run('mesh.update', {
      target: '@mesh:ArtMesh_Face',
      blend: { color: 'screen', alpha: 'over' },
    });
    expect(mesh(s, '@mesh:ArtMesh_Face').blend).toEqual({ color: 'screen', alpha: 'over' });
    s.run('mesh.update', {
      target: '@mesh:ArtMesh_Face',
      blend: { color: 'multiplicative', alpha: 'over' },
    });
    expect(mesh(s, '@mesh:ArtMesh_Face')).toMatchObject({
      blend: null,
      legacyBlend: 'multiplicative',
    } satisfies Partial<ArtMesh>);
    // Setting the legacy blending alone leaves the version 6 blend mode.
    s.run('mesh.update', { target: '@mesh:ArtMesh_Face', blend: { color: 'hue', alpha: 'over' } });
    s.run('mesh.update', { target: '@mesh:ArtMesh_Face', legacyBlend: 'normal' });
    expect(mesh(s, '@mesh:ArtMesh_Face').blend).toBeNull();
  });
});

describe('offscreens', () => {
  it('draws a part offscreen in its own sorting scope, and keeps it there', () => {
    const s = fixtureSession();
    expect(part(s, '@part:PartBody').sortingScope).toBe('inherit');
    s.run('part.setOffscreen', {
      target: '@part:PartBody',
      offscreen: true,
      masks: ['@mesh:ArtMesh_Face'],
    });
    const p = part(s, '@part:PartBody');
    expect(p.sortingScope).toBe('own');
    expect(p.offscreen).toEqual({
      blend: { color: 'normal', alpha: 'over' },
      clip: { masks: [mesh(s, '@mesh:ArtMesh_Face').uid], invert: false },
    });
    // Arguments left out keep their values.
    s.run('part.setOffscreen', { target: '@part:PartBody', offscreen: true, invert: true });
    expect(part(s, '@part:PartBody').offscreen!.clip).toEqual({
      masks: [mesh(s, '@mesh:ArtMesh_Face').uid],
      invert: true,
    });
    expect(() =>
      s.run('part.update', { target: '@part:PartBody', sortingScope: 'inherit' }),
    ).toThrow(MochiError);
    // The opacity and tints are keyform values of the part.
    s.run('keyform.set', {
      target: '@part:PartBody',
      all: true,
      values: { opacity: 0.5, multiply: [1, 0, 0], screen: [0, 0, 0.25] },
    });
    expect(part(s, '@part:PartBody').rig.keyforms[0]).toMatchObject({
      opacity: 0.5,
      multiply: [1, 0, 0],
      screen: [0, 0, 0.25],
    });
    s.run('part.setOffscreen', { target: '@part:PartBody', offscreen: false });
    expect(part(s, '@part:PartBody').offscreen).toBeNull();
    s.run('part.update', { target: '@part:PartBody', sortingScope: 'inherit' });
  });

  it('drops a deleted mask from an offscreen, and an offscreen out of its own scope is invalid', () => {
    const s = fixtureSession();
    s.run('part.setOffscreen', {
      target: '@part:PartBody',
      offscreen: true,
      masks: ['@mesh:ArtMesh_EyeL'],
    });
    s.run('mesh.delete', { target: '@mesh:ArtMesh_EyeL', cascade: true });
    expect(part(s, '@part:PartBody').offscreen!.clip).toBeNull();
    const p = part(s, '@part:PartBody');
    const broken = {
      ...s.doc,
      objects: { ...s.doc.objects, [p.uid]: { ...p, sortingScope: 'inherit' } },
    };
    expect(checkInvariants(new DocView(broken as typeof s.doc)).map((v) => v.path)).toContain(
      'sortingScope',
    );
  });

  it('migrates a format 14 project: no offscreens, opacity 1 and neutral tints', async () => {
    const s = fixtureSession();
    const fs = new MemoryFileSystem();
    const assets = new MemoryAssetStore();
    assets.blobs.set(ASSET, new Uint8Array([1, 2, 3]));
    await saveProject(fs, 'p.mochi', s.doc, assets);
    // Write it back as format 14 had it.
    const manifest = JSON.parse(await fs.readText(`p.mochi/${MANIFEST}`));
    await fs.writeText(`p.mochi/${MANIFEST}`, JSON.stringify({ ...manifest, version: 14 }));
    const parts = JSON.parse(await fs.readText('p.mochi/parts.json'));
    for (const p of parts.parts) {
      delete p.offscreen;
      for (const k of p.rig.keyforms) {
        delete k.opacity;
        delete k.multiply;
        delete k.screen;
      }
    }
    await fs.writeText('p.mochi/parts.json', JSON.stringify(parts));
    for (const path of [...fs.files.keys()].filter((p) => p.startsWith('p.mochi/meshes/'))) {
      const m = JSON.parse(await fs.readText(path));
      delete m.blend;
      await fs.writeText(path, JSON.stringify(m));
    }
    const back = await loadProject(fs, 'p.mochi');
    expect(canonicalText(back.doc)).toBe(canonicalText(s.doc));
  });
});
