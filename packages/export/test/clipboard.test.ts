/** The clipboard operations: copy with images, paste into another project and export. */
import { describe, expect, it } from 'vitest';
import { runItems } from '@mochi-maker/core';
import { OPERATIONS, exportModel } from '@mochi-maker/export';
import { golden1, golden15 } from './golden.js';

describe('clipboard.copy and clipboard.paste', () => {
  it('carry objects and their images into another project, which exports', async () => {
    const src = await golden15();
    const copy = await runItems(
      { session: src.session, assets: src.assets },
      'Copy',
      [{ name: 'clipboard.copy', args: { targets: ['@warp:Warp_Face'] } }],
      { operations: OPERATIONS, dryRun: true },
    );
    const { fragment } = copy.itemResults[0] as { fragment: { assets: Record<string, string> } };
    expect(Object.keys(fragment.assets).length).toBeGreaterThan(0);
    // Through JSON, as the system clipboard carries it.
    const carried = JSON.parse(JSON.stringify(fragment));
    const dst = await golden1();
    const before = dst.session.view.ofKind('artMesh').length;
    const r = await runItems(
      { session: dst.session, assets: dst.assets },
      'Paste',
      [{ name: 'clipboard.paste', args: { fragment: carried, part: '@part:PartBody' } }],
      { operations: OPERATIONS },
    );
    const res = r.itemResults[0] as { roots: string[]; unbound: { what: string; ref: string }[] };
    expect(dst.session.view.ofKind('artMesh').length).toBe(before + 3);
    expect(res.unbound.map((u) => u.ref)).toEqual(
      expect.arrayContaining(['ParamBend', 'Rotation_Head']),
    );
    const out = await exportModel(dst.session.doc, dst.assets);
    expect(out.report.counts.artMeshes).toBe(before + 3);
    dst.session.undo();
    expect(dst.session.view.ofKind('artMesh').length).toBe(before);
  });
});
