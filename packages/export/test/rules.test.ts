/**
 * Writer rules: every golden export keeps each rule, read
 * back from the written bytes; breaking each rule is caught; and the export refuses documents that
 * would break one.
 */
import { describe, expect, it } from 'vitest';
import { MochiError, type Document } from '@mochi-maker/core';
import {
  DECIMALS,
  EMPTY_GROUP_MAX,
  EMPTY_GROUP_MIN,
  checkWriterRules,
  expectedGroupRanges,
  exportModel,
  idProblem,
  padPositionRuns,
  positionRunFailures,
  truncateId,
  type ExportProblem,
} from '@mochi-maker/export';
import { readMoc, validateMoc, type MocData } from 'mochi2d/headless';
import { GOLDENS, golden1, golden3 } from './golden.js';

const utf8 = new TextEncoder();

async function goldenMoc(build: (typeof GOLDENS)[number]) {
  const g = await build();
  const r = await exportModel(g.session.doc, g.assets);
  const stem = g.session.view.project().exportSettings.fileStem;
  return { g, r, bytes: r.files.get(`${stem}.moc3`)!, ...readMoc(r.files.get(`${stem}.moc3`)!) };
}

const codes = (data: MocData, version = 5) => checkWriterRules(data, version).map((v) => v.code);

describe.each(GOLDENS.map((g) => [g.name, g] as const))('writer rules on %s', (_n, build) => {
  it('the written file keeps every rule, and passes the official level', async () => {
    const { bytes, data, version } = await goldenMoc(build);
    expect(validateMoc(bytes, { level: 'official' }).valid).toBe(true);
    expect(checkWriterRules(data, version)).toEqual([]);

    // Each rule, stated directly on the data read back.
    for (const ids of [
      data.parts.ids,
      data.deformers.ids,
      data.artMeshes.ids,
      data.parameters.ids,
      data.glues.ids,
    ])
      for (const id of ids) expect(utf8.encode(id).length).toBeLessThanOrEqual(63);
    for (const f of [
      data.parts.initiallyVisible,
      data.parts.enabled,
      data.deformers.enabled,
      data.artMeshes.enabled,
      data.parameters.repeat,
    ])
      for (const v of f) expect([0, 1]).toContain(v);
    expect([...data.deformers.visible].every((v) => v === 1)).toBe(true);
    expect([...data.artMeshes.visible].every((v) => v === 1)).toBe(true);
    expect([...data.parameters.decimals].every((d) => d === 3)).toBe(true);
    const am = data.artMeshes;
    for (let i = 0; i < am.ids.length; i++) {
      expect(am.triangleIndexCount[i]! % 3).toBe(0);
      const tri = data.triangleIndices.subarray(
        am.firstTriangleIndex[i]!,
        am.firstTriangleIndex[i]! + am.triangleIndexCount[i]!,
      );
      expect(Math.max(...tri)).toBeLessThan(am.vertexCount[i]!);
    }
    const pb = data.parameterBindings;
    for (let b = 0; b < pb.firstKey.length; b++)
      for (let k = pb.firstKey[b]! + 1; k < pb.firstKey[b]! + pb.keyCount[b]!; k++)
        expect(data.keys[k]!).toBeGreaterThan(data.keys[k - 1]!);
    data.parameters.min.forEach((min, i) =>
      expect(min).toBeLessThanOrEqual(data.parameters.max[i]!),
    );
    const ranges = expectedGroupRanges(data);
    expect([...data.drawOrderGroups.minDrawOrder]).toEqual(ranges.map((r) => r.min));
    expect([...data.drawOrderGroups.maxDrawOrder]).toEqual(ranges.map((r) => r.max));
    if (version >= 5)
      for (let i = 0; i < am.ids.length; i++)
        for (let k = 0; k < am.keyformCount[i]!; k++) {
          const at = am.firstKeyform[i]! + k;
          expect(data.artMeshKeyforms.multiplyColor![at]).toBe(am.firstColor![i]! + k);
          expect(data.artMeshKeyforms.screenColor![at]).toBe(am.firstColor![i]! + k);
        }
    expect(positionRunFailures(data)).toEqual([]);
  });
});

describe('writer rules catch each break', () => {
  it('golden 3 exact group ranges: root 300…500 (Part_Front reaches 300), Part_Back 500…500', async () => {
    const { data } = await goldenMoc(golden3);
    const ids = data.parts.ids;
    const o = data.drawOrderGroupObjects;
    const groupOf = (part: string) => {
      for (let j = 0; j < o.kind.length; j++)
        if (o.kind[j] === 1 && ids[o.index[j]!] === part) return o.nestedGroup[j]!;
      throw new Error(part);
    };
    const g = data.drawOrderGroups;
    expect([g.minDrawOrder[0], g.maxDrawOrder[0]]).toEqual([300, 600]);
    expect([g.minDrawOrder[groupOf('Part_Back')], g.maxDrawOrder[groupOf('Part_Back')]]).toEqual([
      500, 500,
    ]);
  });

  it('a part with its own sorting scope and no members gets the empty-group pair', async () => {
    const g = await golden1();
    g.session.runBatch('empty scope', [
      { name: 'part.create', args: { exportId: 'Part_Empty', sortingScope: 'own' } },
    ]);
    const r = await exportModel(g.session.doc, g.assets);
    const { data } = readMoc(r.files.get('golden1.moc3')!);
    const gs = data.drawOrderGroups;
    expect(gs.entryCount.length).toBe(2);
    expect([gs.minDrawOrder[1], gs.maxDrawOrder[1]]).toEqual([EMPTY_GROUP_MIN, EMPTY_GROUP_MAX]);
    // The root's range covers its members only: the mesh (500) and the empty part (500).
    expect([gs.minDrawOrder[0], gs.maxDrawOrder[0]]).toEqual([500, 500]);
    expect(validateMoc(r.files.get('golden1.moc3')!, { level: 'official' }).valid).toBe(true);
  });

  it('IDs: at most 63 UTF-8 bytes, well-formed, with a suggested fix', () => {
    expect(idProblem('a'.repeat(63))).toBeUndefined();
    expect(idProblem('é'.repeat(31))).toBeUndefined(); // 62 bytes
    expect(idProblem('é'.repeat(32))?.code).toBe('id-length'); // 64 bytes
    expect(idProblem('\uD800x')?.code).toBe('id-utf8');
    expect(idProblem('a\0b')?.code).toBe('id-utf8');
    expect(idProblem('')?.code).toBe('id-empty');
    expect(truncateId('é'.repeat(32))).toBe('é'.repeat(31));
    expect(truncateId('a'.repeat(62) + '😀')).toBe('a'.repeat(62)); // no half code points
    expect(idProblem('é'.repeat(32))!.fix).toContain(`"${'é'.repeat(31)}"`);
  });

  it('each rule, broken in golden 3’s data, is reported with its code', async () => {
    const fresh = async () => (await goldenMoc(golden3)).data;
    const cases: [string, (d: MocData) => void][] = [
      ['id-length', (d) => (d.artMeshes.ids[0] = 'x'.repeat(64))],
      ['id-utf8', (d) => (d.parameters.ids[0] = 'P\uDC00')],
      ['flag-value', (d) => (d.parts.enabled[0] = 2)],
      ['display-flag', (d) => (d.artMeshes.visible[0] = 0)],
      ['decimals', (d) => (d.parameters.decimals[0] = 2)],
      ['triangle-index', (d) => (d.triangleIndices[0] = d.artMeshes.vertexCount[0]!)],
      ['triangle-count', (d) => (d.artMeshes.triangleIndexCount[0] = 5)],
      ['keys-order', (d) => (d.keys[d.parameterBindings.firstKey[0]! + 1] = d.keys[0]!)],
      ['parameter-range', (d) => (d.parameters.min[0] = 2)],
      ['key-magnitude', (d) => (d.keys[d.keys.length - 1] = 32768)],
      ['group-range', (d) => (d.drawOrderGroups.minDrawOrder[0] = 0)],
      ['color-index', (d) => (d.artMeshKeyforms.multiplyColor![0] = 99)],
      ['position-run', (d) => (d.artMeshKeyforms.firstPosition[0] = d.keyformPositions.length)],
    ];
    for (const [code, breakIt] of cases) {
      const d = await fresh();
      expect(codes(d), code).toEqual([]);
      breakIt(d);
      expect(codes(d), code).toContain(code);
    }
  });

  it('keys equal in float32 count as not increasing', async () => {
    const { data } = await goldenMoc(golden3);
    const f = data.parameterBindings.firstKey[0]!;
    data.keys[f] = 1;
    data.keys[f + 1] = 1 + 1e-9; // stored as float32: the same value as 1
    data.keys[f + 2] = 2;
    expect(codes(data)).toContain('keys-order');
  });

  it('position runs: padding makes the official level’s form hold', async () => {
    const { data } = await goldenMoc(golden1);
    const n = data.keyformPositions.length;
    // Move keyform 0's start so that mesh 0's run (8 floats) would end 6 floats past the end.
    data.artMeshKeyforms.firstPosition[0] = n - 2;
    expect(positionRunFailures(data)).toEqual([{ kind: 'artMeshes', index: 0, end: n + 6 }]);
    expect(padPositionRuns(data)).toBe(6);
    expect(data.keyformPositions.length).toBe(n + 6);
    expect(positionRunFailures(data)).toEqual([]);
    expect(padPositionRuns(data)).toBe(0);
  });
});

describe('the export refuses documents that break a writer rule', () => {
  it('a 64-byte export ID (from a hand-edited project) is refused with a fix', async () => {
    const g = await golden1();
    const doc = g.session.doc;
    const mesh = Object.values(doc.objects).find((o) => o.kind === 'artMesh')!;
    const bad: Document = {
      ...doc,
      objects: { ...doc.objects, [mesh.uid]: { ...mesh, exportId: 'é'.repeat(32) } as never },
    };
    const err = await exportModel(bad, g.assets).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MochiError);
    expect((err as MochiError).code).toBe('E_EXPORT');
    const problems = (err as MochiError).details!.problems as ExportProblem[];
    const p = problems.find((x) => x.source === 'writer-rules')!;
    expect(p.code).toBe('id-length');
    expect(p.uid).toBe(mesh.uid);
    expect(p.fix).toContain('object.rename');
    expect(p.message).toContain('64 bytes');
  });

  it('decimal places are always written as 3, whatever the display precision', async () => {
    const g = await golden1();
    g.session.runBatch('decimals', [
      { name: 'param.update', args: { target: '@param:ParamA', decimals: 1 } },
    ]);
    const r = await exportModel(g.session.doc, g.assets);
    expect([...readMoc(r.files.get('golden1.moc3')!).data.parameters.decimals]).toEqual([DECIMALS]);
  });
});
