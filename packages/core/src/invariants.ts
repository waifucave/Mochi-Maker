/**
 * Document invariants (design 4.2, validation tier 2). They must hold after every transaction; a
 * violation rolls the transaction back. They are also checked when a project is loaded.
 */
import { visitRefs } from './codec.js';
import type { DocReader } from './document.js';
import {
  OBJECT_SCHEMAS,
  exportNamespace,
  type AnyDelta,
  type AnyKeyform,
  type ArtMesh,
  type BlendShape,
  type DocObject,
  type Rig,
  type Uid,
} from './model.js';
import { gridSize } from './rig.js';
import { EXPORT_ID_PATTERN, type Kind } from './schema.js';

export interface Violation {
  uid: Uid;
  path: string;
  message: string;
}

export function checkInvariants(doc: DocReader): Violation[] {
  const out: Violation[] = [];
  const add = (uid: Uid, path: string, message: string) => out.push({ uid, path, message });
  const objects = [...doc.all()];
  const project = doc.project();
  if (!project) return [{ uid: 'project', path: '', message: 'the project object is missing' }];

  // References resolve to objects of the right kind.
  for (const o of objects) {
    visitRefs(OBJECT_SCHEMAS[o.kind], o, (ref, kinds, path) => {
      const target = doc.get(ref);
      if (path === 'uid') {
        if (ref !== o.uid) add(o.uid, path, 'uid field does not match the key');
        return;
      }
      if (!target) add(o.uid, path, `refers to ${ref}, which does not exist`);
      else if (!kinds.includes(target.kind))
        add(o.uid, path, `refers to ${ref}, a ${target.kind}; expected ${kinds.join(' or ')}`);
    });
  }

  // Export IDs: valid and unique per namespace.
  const seen = new Map<string, Uid>();
  for (const o of objects) {
    if (!('exportId' in o)) continue;
    const ns = exportNamespace(o.kind);
    if (!EXPORT_ID_PATTERN.test(o.exportId))
      add(o.uid, 'exportId', `"${o.exportId}" is not a valid export ID`);
    const key = `${ns}:${o.exportId}`;
    const other = seen.get(key);
    if (other) add(o.uid, 'exportId', `"${o.exportId}" is also used by ${other}`);
    else seen.set(key, o.uid);
  }

  checkOrderList(doc, project.parameterOrder, ['parameter'], 'parameterOrder', add);
  checkOrderList(doc, project.parameterGroupOrder, ['parameterGroup'], 'parameterGroupOrder', add);
  checkOrderList(doc, project.layerOrder, ['layer'], 'layerOrder', add);
  checkOrderList(doc, project.glueOrder, ['glue'], 'glueOrder', add);
  checkOrderList(doc, project.expressionOrder, ['expression'], 'expressionOrder', add);
  checkOrderList(doc, project.motionOrder, ['motion'], 'motionOrder', add);
  checkOrderList(doc, project.physicsOrder, ['physicsSetting'], 'physicsOrder', add);
  checkOrderList(doc, project.motionSyncOrder, ['motionSyncSetting'], 'motionSyncOrder', add);
  checkOrderList(doc, project.soundOrder, ['sound'], 'soundOrder', add);
  checkOrderList(doc, project.deformerOrder, ['warp', 'rotation'], 'deformerOrder', add);
  checkPartTree(doc, add);

  // Deformers: parents come first in deformerOrder, no cycles.
  const position = new Map(project.deformerOrder.map((u, i) => [u, i]));
  for (const d of doc.ofKind(['warp', 'rotation'])) {
    if (d.parent !== null && (position.get(d.parent) ?? Infinity) >= (position.get(d.uid) ?? -1))
      add(d.uid, 'parent', 'the parent deformer must come before its child in deformerOrder');
  }

  for (const o of objects) checkObject(doc, o, add);
  return out;
}

type Add = (uid: Uid, path: string, message: string) => void;

function checkOrderList(doc: DocReader, list: Uid[], kinds: Kind[], name: string, add: Add): void {
  const inList = new Set<Uid>();
  for (const u of list) {
    if (inList.has(u)) add('project', name, `${u} is listed twice`);
    inList.add(u);
  }
  for (const o of doc.ofKind(kinds))
    if (!inList.has(o.uid)) add('project', name, `${o.uid} is missing`);
}

function checkPartTree(doc: DocReader, add: Add): void {
  const project = doc.project();
  const placed = new Map<Uid, Uid>(); // child → container
  const place = (container: Uid, list: Uid[], path: string) => {
    for (const u of list) {
      if (placed.has(u)) add(container, path, `${u} appears in more than one children list`);
      placed.set(u, container);
      const o = doc.get(u);
      if (!o) continue;
      const parent = o.kind === 'part' ? o.parent : o.kind === 'artMesh' ? o.part : undefined;
      const expected = container === 'project' ? null : container;
      if (parent !== expected)
        add(
          u,
          o.kind === 'part' ? 'parent' : 'part',
          `is listed under ${container} but its parent is ${parent}`,
        );
    }
  };
  place('project', project.root, 'root');
  for (const p of doc.ofKind('part')) place(p.uid, p.children, 'children');
  for (const o of doc.ofKind(['part', 'artMesh']))
    if (!placed.has(o.uid)) add(o.uid, '', 'is not listed in any children list');
  // No cycles.
  for (const p of doc.ofKind('part')) {
    const visited = new Set<Uid>();
    let cur: Uid | null = p.uid;
    while (cur !== null) {
      if (visited.has(cur)) {
        add(p.uid, 'parent', 'the part tree has a cycle');
        break;
      }
      visited.add(cur);
      const o = doc.get(cur);
      cur = o && o.kind === 'part' ? o.parent : null;
    }
  }
}

function checkRig(
  doc: DocReader,
  o: DocObject & { rig: Rig },
  add: Add,
  shape: (k: AnyKeyform, i: number) => void,
): void {
  const params = new Set<Uid>();
  o.rig.bindings.forEach((b, j) => {
    const path = `rig.bindings[${j}]`;
    if (params.has(b.parameter)) add(o.uid, path, 'the parameter is bound twice');
    params.add(b.parameter);
    if (b.keys.length === 0) add(o.uid, path, 'a binding needs at least one key');
    for (let i = 1; i < b.keys.length; i++)
      if (!((b.keys[i] as number) > (b.keys[i - 1] as number)))
        add(o.uid, path, 'keys must be strictly ascending');
    const p = doc.get(b.parameter);
    if (p && p.kind === 'parameter') {
      if (p.type !== 'normal') add(o.uid, path, 'only normal parameters can be bound');
      for (const k of b.keys)
        if (!p.keys.includes(k))
          add(o.uid, path, `key ${k} is not in the key list of ${p.exportId}`);
    }
  });
  const n = gridSize(o.rig.bindings);
  if (o.rig.keyforms.length !== n)
    add(o.uid, 'rig.keyforms', `expected ${n} keyforms, found ${o.rig.keyforms.length}`);
  o.rig.keyforms.forEach((k, i) => {
    // Authored opacities stay in 0…1, so evaluation's clamp of blend-shape targets never changes a result.
    if ('opacity' in k && !(k.opacity >= 0 && k.opacity <= 1))
      add(o.uid, `rig.keyforms[${i}].opacity`, 'opacity must lie within 0…1');
    shape(k, i);
  });
}

/** Blend shapes: parameter, keys, base, one delta per key (the base one zero). */
function checkBlendShapes(
  doc: DocReader,
  o: DocObject & { blendShapes: BlendShape[] },
  add: Add,
  shape: (k: AnyDelta, path: string) => void,
): void {
  const params = new Set<Uid>();
  o.blendShapes.forEach((b, j) => {
    const path = `blendShapes[${j}]`;
    if (params.has(b.parameter)) add(o.uid, path, 'the parameter has two blend shapes here');
    params.add(b.parameter);
    const p = doc.get(b.parameter);
    if (p && p.kind === 'parameter') {
      if (p.type !== 'blendShape') add(o.uid, path, `${p.exportId} is not a blend-shape parameter`);
      for (const k of b.keys)
        if (!p.keys.includes(k))
          add(o.uid, path, `key ${k} is not in the key list of ${p.exportId}`);
    }
    if (b.keys.length === 0) add(o.uid, path, 'a blend shape needs at least one key');
    for (let i = 1; i < b.keys.length; i++)
      if (!((b.keys[i] as number) > (b.keys[i - 1] as number)))
        add(o.uid, path, 'keys must be strictly ascending');
    const base = b.keys.indexOf(b.base);
    if (base < 0) add(o.uid, `${path}.base`, `the base ${b.base} is not one of the keys`);
    if (b.deltas.length !== b.keys.length)
      add(o.uid, `${path}.deltas`, `expected ${b.keys.length} deltas, found ${b.deltas.length}`);
    b.deltas.forEach((d, i) => {
      shape(d, `${path}.deltas[${i}]`);
      if (i === base && !isZeroDelta(d))
        add(o.uid, `${path}.deltas[${i}]`, 'the base key’s delta must be all zero');
    });
    b.constraints.forEach((c, i) => {
      const cp = `${path}.constraints[${i}]`;
      if (c.points.length === 0) add(o.uid, cp, 'a constraint needs at least one point');
      if (c.points.some(([, w]) => w > 1)) add(o.uid, cp, 'constraint weights are at most 1');
      for (let k = 1; k < c.points.length; k++)
        if (!(c.points[k]![0] > c.points[k - 1]![0]))
          add(o.uid, cp, 'constraint values must be strictly ascending');
    });
  });
}

/** True when every value of a delta is zero. */
export function isZeroDelta(d: AnyDelta): boolean {
  for (const v of Object.values(d)) {
    if (typeof v === 'number') {
      if (v !== 0) return false;
    } else if (!(v as ArrayLike<number>).length) continue;
    else for (const x of Array.from(v as ArrayLike<number>)) if (x !== 0) return false;
  }
  return true;
}

function checkObject(doc: DocReader, o: DocObject, add: Add): void {
  switch (o.kind) {
    case 'parameter': {
      if (!(o.min <= o.max)) add(o.uid, 'min', 'min must not exceed max');
      if (o.default < o.min || o.default > o.max)
        add(o.uid, 'default', 'the default must lie within [min, max]');
      o.keys.forEach((k, i) => {
        if (i > 0 && !(k > (o.keys[i - 1] as number)))
          add(o.uid, 'keys', 'keys must be strictly ascending');
        if (k < o.min || k > o.max) add(o.uid, 'keys', `key ${k} lies outside [min, max]`);
      });
      break;
    }
    case 'parameterGroup': {
      const seen = new Set<Uid>();
      let cur: Uid | null = o.uid;
      while (cur !== null) {
        if (seen.has(cur)) {
          add(o.uid, 'parent', 'the group tree has a cycle');
          break;
        }
        seen.add(cur);
        const g = doc.get(cur);
        cur = g && g.kind === 'parameterGroup' ? g.parent : null;
      }
      break;
    }
    case 'part':
      checkRig(doc, o, add, () => {});
      checkBlendShapes(doc, o, add, () => {});
      if (o.offscreen) {
        if (o.sortingScope !== 'own')
          add(o.uid, 'sortingScope', 'a part drawn offscreen needs its own sorting scope');
        const masks = new Set<Uid>();
        for (const m of o.offscreen.clip?.masks ?? []) {
          if (masks.has(m)) add(o.uid, 'offscreen.clip.masks', `${m} is listed twice`);
          masks.add(m);
        }
      }
      break;
    case 'artMesh': {
      const v = o.uv.length / 2;
      if (v > 65535) add(o.uid, 'uv', 'at most 65535 vertices');
      for (let i = 0; i < o.triangles.length; i++)
        if ((o.triangles[i] as number) >= v) {
          add(o.uid, 'triangles', `vertex index ${o.triangles[i]} ≥ vertex count ${v}`);
          break;
        }
      checkRig(doc, o, add, (k, i) => {
        if ('positions' in k && k.positions.length !== o.uv.length)
          add(o.uid, `rig.keyforms[${i}].positions`, `expected ${v} points`);
      });
      checkBlendShapes(doc, o, add, (k, path) => {
        if ('positions' in k && k.positions.length !== o.uv.length)
          add(o.uid, `${path}.positions`, `expected ${v} points`);
      });
      if (o.clip) {
        const masks = new Set<Uid>();
        for (const m of o.clip.masks) {
          if (m === o.uid) add(o.uid, 'clip.masks', 'a mesh cannot clip itself');
          if (masks.has(m)) add(o.uid, 'clip.masks', `${m} is listed twice`);
          masks.add(m);
        }
      }
      break;
    }
    case 'warp': {
      const points = (o.rows + 1) * (o.cols + 1);
      checkRig(doc, o, add, (k, i) => {
        if ('grid' in k && k.grid.length !== 2 * points)
          add(o.uid, `rig.keyforms[${i}].grid`, `expected ${points} grid points`);
      });
      checkBlendShapes(doc, o, add, (k, path) => {
        if ('grid' in k && k.grid.length !== 2 * points)
          add(o.uid, `${path}.grid`, `expected ${points} grid points`);
      });
      checkDeformerCycle(doc, o.uid, add);
      break;
    }
    case 'rotation':
      checkRig(doc, o, add, () => {});
      checkBlendShapes(doc, o, add, () => {});
      checkDeformerCycle(doc, o.uid, add);
      break;
    case 'glue': {
      if (o.meshA === o.meshB) add(o.uid, 'meshB', 'a glue needs two different meshes');
      const a = doc.get(o.meshA) as ArtMesh | undefined;
      const b = doc.get(o.meshB) as ArtMesh | undefined;
      o.pairs.forEach(([va, , vb], i) => {
        if (a && a.kind === 'artMesh' && va >= a.uv.length / 2)
          add(o.uid, `pairs[${i}]`, `vertex ${va} is not in mesh A`);
        if (b && b.kind === 'artMesh' && vb >= b.uv.length / 2)
          add(o.uid, `pairs[${i}]`, `vertex ${vb} is not in mesh B`);
      });
      checkRig(doc, o, add, () => {});
      checkBlendShapes(doc, o, add, () => {});
      break;
    }
    case 'physicsSetting':
      o.outputs.forEach((out, i) => {
        if (out.particle >= o.particles.length)
          add(o.uid, `outputs[${i}].particle`, 'no such particle');
      });
      break;
    case 'motionSyncSetting':
      if (o.shapes.length !== o.elements.length)
        add(o.uid, 'shapes', 'one shape per audio element is needed');
      o.shapes.forEach((row, e) => {
        if (row.length !== o.parameters.length)
          add(o.uid, `shapes[${e}]`, 'one value per driven parameter is needed');
      });
      break;
    case 'motion':
      o.curves.forEach((c, i) => {
        const path = `curves[${i}]`;
        if (c.target === 'model' && (c.model === null || c.object !== null))
          add(o.uid, path, 'a model curve names EyeBlink, LipSync or Opacity and no object');
        if (c.target !== 'model' && (c.object === null || c.model !== null))
          add(o.uid, path, 'the curve needs an object');
        const obj = c.object ? doc.get(c.object) : undefined;
        if (obj && c.target === 'parameter' && obj.kind !== 'parameter')
          add(o.uid, path, 'a parameter curve needs a parameter');
        if (obj && c.target === 'partOpacity' && obj.kind !== 'part')
          add(o.uid, path, 'a part-opacity curve needs a part');
        const codes: number[] = [];
        for (let k = 2; k < c.segments.length; k += c.segments[k] === 1 ? 7 : 3)
          codes.push(c.segments[k]!);
        for (const a of c.auto ?? [])
          if (codes[a] !== 1) add(o.uid, `${path}.auto`, `segment ${a} is not a Bézier segment`);
        const err = segmentError(c.segments);
        if (err) add(o.uid, `${path}.segments`, err);
      });
      break;
    default:
      break;
  }
}

function checkDeformerCycle(doc: DocReader, uid: Uid, add: Add): void {
  const seen = new Set<Uid>();
  let cur: Uid | null = uid;
  while (cur !== null) {
    if (seen.has(cur)) {
      add(uid, 'parent', 'the deformer tree has a cycle');
      return;
    }
    seen.add(cur);
    const d = doc.get(cur);
    cur = d && (d.kind === 'warp' || d.kind === 'rotation') ? d.parent : null;
  }
}

/** Checks the flat segment encoding of a motion curve (§3c.3). */
export function segmentError(seg: number[]): string | null {
  if (seg.length < 2) return 'a curve starts with a point (time, value)';
  let i = 2;
  let t = seg[0] as number;
  while (i < seg.length) {
    const code = seg[i] as number;
    const n = code === 1 ? 6 : code === 0 || code === 2 || code === 3 ? 2 : -1;
    if (n < 0) return `unknown segment code ${code} at index ${i}`;
    if (i + n > seg.length - 1) return `segment at index ${i} is cut off`;
    const end = seg[i + n - 1] as number;
    if (end < t) return `segment at index ${i} goes back in time`;
    t = end;
    i += n + 1;
  }
  return null;
}
