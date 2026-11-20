/**
 * The lowering cache: after value edits of every kind, its result equals a full
 * lowering bit for bit; structural edits take the full path.
 */
import { describe, expect, it } from 'vitest';
import { DocView, type DocObject, type Session, type Uid } from '@mochi-maker/core';
import type { MocData } from 'mochi2d/headless';
import { LoweringCache, lowerDocument, type TexturePlacement } from '../src/index.js';
import { GOLDENS } from './golden.js';

/** Every typed array of two model data, compared byte for byte. */
function sameBytes(a: MocData, b: MocData, path = 'data'): void {
  const walk = (x: unknown, y: unknown, p: string) => {
    if (ArrayBuffer.isView(x)) {
      const bx = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      const by = new Uint8Array(
        (y as ArrayBufferView).buffer,
        (y as ArrayBufferView).byteOffset,
        (y as ArrayBufferView).byteLength,
      );
      expect(bx.length, p).toBe(by.length);
      for (let i = 0; i < bx.length; i++)
        if (bx[i] !== by[i]) expect(`${p}[byte ${i}]`).toBe('equal');
    } else if (x && typeof x === 'object') {
      expect(Object.keys(y as object).sort(), p).toEqual(Object.keys(x).sort());
      for (const [k, v] of Object.entries(x))
        walk(v, (y as Record<string, unknown>)[k], `${p}.${k}`);
    } else expect(y, p).toEqual(x);
  };
  walk(a, b, path);
}

const placementOf = (s: Session) => {
  const m = new Map<Uid, TexturePlacement>();
  for (const l of s.view.ofKind('layer'))
    m.set(l.uid, { page: 0, pageWidth: 1024, pageHeight: 1024, offsetX: 7, offsetY: 3 });
  return m;
};

/** A value edit of an object's first keyform, or null for kinds without one. */
function valueEdit(o: DocObject): { name: string; args: unknown }[] | null {
  if (!('rig' in o) || ('blendShapes' in o && o.blendShapes.length)) return null;
  const rig = o.rig as {
    bindings: { parameter: Uid; keys: number[] }[];
    keyforms: Record<string, unknown>[];
  };
  const cell = Object.fromEntries(rig.bindings.map((b) => [b.parameter, b.keys[0]!]));
  const k = rig.keyforms[0]!;
  const pairs = (a: ArrayLike<number>, d: number) => {
    const out: [number, number][] = [];
    for (let i = 0; i < a.length; i += 2) out.push([a[i]! + d, a[i + 1]! - d / 2]);
    return out;
  };
  let values: Record<string, unknown>;
  if (o.kind === 'artMesh')
    values = {
      positions: pairs(k.positions as Float32Array, o.deformer ? 0.01 : 3.5),
      opacity: 0.625,
      drawOrder: (k.drawOrder as number) + 7,
      multiply: [0.5, 0.25, 1],
      screen: [0.1, 0, 0.2],
    };
  else if (o.kind === 'warp')
    values = {
      grid: pairs(k.grid as Float32Array, o.parent ? 0.01 : 2.25),
      opacity: 0.75,
      multiply: [1, 0.5, 0.5],
    };
  else if (o.kind === 'rotation')
    values = {
      angle: (k.angle as number) + 12.5,
      originX: (k.originX as number) + 1.5,
      originY: (k.originY as number) - 2,
      scale: (k.scale as number) * 1.25,
      opacity: 0.5,
      screen: [0.2, 0.2, 0],
    };
  else if (o.kind === 'part') values = { drawOrder: (k.drawOrder as number) + 11 };
  else if (o.kind === 'glue') values = { intensity: 0.375 };
  else return null;
  const calls = [
    {
      name: 'keyform.set',
      args: { target: o.uid, ...(rig.bindings.length ? { cell } : {}), values },
    },
  ];
  if (o.kind === 'artMesh')
    calls.push({
      name: 'mesh.moveUv',
      args: { target: o.uid, vertices: [0], offset: [1.5, -0.5] } as never,
    });
  if (o.kind === 'rotation')
    calls.push({ name: 'deformer.update', args: { target: o.uid, baseAngle: 15 } as never });
  return calls;
}

describe('the lowering cache', () => {
  it('equals a full lowering after value edits of every kind, in every golden', async () => {
    let rewrites = 0;
    for (const make of GOLDENS) {
      const g = await make();
      const placement = placementOf(g.session);
      const cache = new LoweringCache();
      for (const version of [5, 4, 3] as const) {
        if (version !== 5 && g.session.view.ofKind('artMesh').some((m) => m.blendShapes.length))
          continue;
        cache.clear();
        cache.lower(g.session.doc, { version, placement });
        for (const o of [...g.session.view.all()]) {
          const calls = valueEdit(o);
          if (!calls) continue;
          try {
            g.session.transact('edit', (tx) => calls.forEach((c) => tx.run(c.name, c.args)));
          } catch {
            continue; // e.g. a value out of range for this object
          }
          const got = cache.lower(g.session.doc, { version, placement });
          const want = lowerDocument(new DocView(g.session.doc), { version, placement });
          sameBytes(want.data, got.data, `${g.name} v${version} ${o.uid}`);
          expect(got.uids).toEqual(want.uids);
          if (cache.stats.mode === 'values') rewrites++;
          g.session.undo();
        }
      }
    }
    expect(rewrites).toBeGreaterThan(50);
  }, 120_000);

  it('takes the full path for structure, and copes with undo', async () => {
    const g = await GOLDENS[0]!();
    const cache = new LoweringCache();
    const placement = placementOf(g.session);
    cache.lower(g.session.doc, { version: 5, placement });
    g.session.transact('add', (tx) =>
      tx.run('mesh.addVertices', { target: '@mesh:ArtMesh_Square', points: [[20, 20]] }),
    );
    cache.lower(g.session.doc, { version: 5, placement });
    expect(cache.stats.mode).toBe('full');
    g.session.transact('move', (tx) =>
      tx.run('mesh.moveVertices', { target: '@mesh:ArtMesh_Square', all: true, offset: [4, 0] }),
    );
    const got = cache.lower(g.session.doc, { version: 5, placement });
    expect(cache.stats).toEqual({ mode: 'values', rewritten: 1 });
    sameBytes(lowerDocument(new DocView(g.session.doc), { version: 5, placement }).data, got.data);
    // The data handed out is the caller's: writing into it does not reach the cache.
    got.data.keyformPositions.fill(123);
    g.session.undo();
    const back = cache.lower(g.session.doc, { version: 5, placement });
    sameBytes(lowerDocument(new DocView(g.session.doc), { version: 5, placement }).data, back.data);
    // Another placement (a new atlas) lowers in full.
    cache.lower(g.session.doc, { version: 5, placement: placementOf(g.session) });
    expect(cache.stats.mode).toBe('full');
  });
});
