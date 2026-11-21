/**
 * The in-memory document and the draft that commands edit (design 3.9).
 *
 * A Document is an immutable normalized store: a map from UID to object. The singleton `project`
 * object holds the canvas, ordered lists and settings. `seq` is the UID counter. It only grows,
 * is never undone, and is saved with the project, so UIDs are never reused.
 */
import { visitRefs } from './codec.js';
import { MochiError } from './errors.js';
import { f32 } from './f32.js';
import {
  OBJECT_SCHEMAS,
  type DocObject,
  type ObjectByKind,
  type Project,
  type Uid,
} from './model.js';
import { REF_KIND_NAMES, UID_PATTERN, UID_PREFIX, type Kind } from './schema.js';

export interface Document {
  readonly objects: Readonly<Record<Uid, DocObject>>;
  readonly seq: number;
}

export interface CanvasInit {
  width: number;
  height: number;
  pixelsPerUnit?: number;
  originX?: number;
  originY?: number;
}

export function emptyDocument(canvas: CanvasInit = { width: 2048, height: 2048 }): Document {
  const project: Project = {
    kind: 'project',
    uid: 'project',
    canvas: {
      width: f32(canvas.width),
      height: f32(canvas.height),
      pixelsPerUnit: f32(canvas.pixelsPerUnit ?? canvas.width),
      originX: f32(canvas.originX ?? canvas.width / 2),
      originY: f32(canvas.originY ?? canvas.height / 2),
    },
    parameterOrder: [],
    parameterGroupOrder: [],
    root: [],
    deformerOrder: [],
    layerOrder: [],
    glueOrder: [],
    expressionOrder: [],
    motionOrder: [],
    soundOrder: [],
    physicsOrder: [],
    motionSyncOrder: [],
    physicsFps: 0,
    animationTemplates: [],
    deformPaths: [],
    hitAreas: [],
    standardGroups: { eyeBlink: [], lipSync: [] },
    combinedParameters: [],
    userData: [],
    pose: { fadeIn: null, groups: [] },
    importedFrom: null,
    stacks: [],
    exportSettings: {
      mocVersion: 5,
      minimumVersion: 5,
      atlasSize: 4096,
      fileStem: 'model',
      includeGuideImages: false,
    },
  };
  return { objects: { project }, seq: 1 };
}

/** One object-level change: the object before and after (undefined = absent). */
export interface Patch {
  uid: Uid;
  before: DocObject | undefined;
  after: DocObject | undefined;
}

export function applyPatches(
  doc: Document,
  patches: Patch[],
  direction: 'forward' | 'back',
): Document {
  const objects: Record<Uid, DocObject> = { ...doc.objects };
  for (const p of patches) {
    const v = direction === 'forward' ? p.after : p.before;
    if (v === undefined) delete objects[p.uid];
    else objects[p.uid] = v;
  }
  return { objects, seq: doc.seq };
}

export function uidNumber(uid: Uid): number {
  const i = uid.lastIndexOf('_');
  return i < 0 ? -1 : Number(uid.slice(i + 1));
}

/** Compares UIDs by kind prefix, then by number, for deterministic ordering. */
export function compareUids(a: Uid, b: Uid): number {
  const pa = a.slice(0, a.lastIndexOf('_'));
  const pb = b.slice(0, b.lastIndexOf('_'));
  if (pa !== pb) return pa < pb ? -1 : 1;
  return uidNumber(a) - uidNumber(b);
}

function describeObject(o: DocObject): string {
  const exportId = 'exportId' in o ? o.exportId : undefined;
  const name = 'name' in o ? o.name : undefined;
  let s = o.uid;
  if (exportId) s += ` (${exportId}`;
  if (name && name !== exportId) s += exportId ? `, "${name}"` : ` ("${name}"`;
  if (exportId || (name && name !== exportId)) s += ')';
  return s;
}

/** Read access shared by documents and drafts. */
export abstract class DocReader {
  abstract get(uid: Uid): DocObject | undefined;
  abstract all(): Iterable<DocObject>;

  project(): Project {
    return this.get('project') as Project;
  }

  /** The object with this UID and one of these kinds, or a structured error. */
  getAs<K extends Kind>(uid: Uid, kinds: K | readonly K[], path?: string): ObjectByKind[K] {
    const list = (Array.isArray(kinds) ? kinds : [kinds]) as readonly K[];
    const o = this.get(uid);
    if (o === undefined)
      throw new MochiError('E_NOT_FOUND', `No object has the UID ${uid}.`, path ? { path } : {});
    if (!list.includes(o.kind as K))
      throw new MochiError(
        'E_WRONG_KIND',
        `${describeObject(o)} is a ${o.kind}, but a ${list.join(' or ')} is needed here.`,
        path ? { path } : {},
      );
    return o as ObjectByKind[K];
  }

  ofKind<K extends Kind>(kinds: K | readonly K[]): ObjectByKind[K][] {
    const list = (Array.isArray(kinds) ? kinds : [kinds]) as readonly K[];
    const out: ObjectByKind[K][] = [];
    for (const o of this.all()) if (list.includes(o.kind as K)) out.push(o as ObjectByKind[K]);
    out.sort((a, b) => compareUids(a.uid, b.uid));
    return out;
  }

  describe(uid: Uid): string {
    const o = this.get(uid);
    return o ? describeObject(o) : uid;
  }

  /**
   * Resolves a reference: a UID, `@kind:ExportId`, or `@kind~"Display name"` (or `@kind~Name`).
   */
  resolve(ref: string, kinds: readonly Kind[], path?: string): Uid {
    const info = path ? { path } : {};
    if (UID_PATTERN.test(ref)) {
      this.getAs(ref, kinds, path);
      return ref;
    }
    const m = /^@([a-z]+)([:~])(.+)$/.exec(ref);
    if (!m)
      throw new MochiError(
        'E_BAD_REF',
        `"${ref}" is not a reference. Use a UID such as mesh_0004, @mesh:ExportId or @mesh~"Display name".`,
        info,
      );
    const [, kindName, sep, rawName] = m as unknown as [string, string, string, string];
    const refKinds = REF_KIND_NAMES[kindName];
    if (!refKinds)
      throw new MochiError('E_BAD_REF', `Unknown kind "${kindName}" in "${ref}".`, {
        ...info,
        details: { kinds: Object.keys(REF_KIND_NAMES) },
      });
    const searchKinds = refKinds.filter((k) => kinds.includes(k));
    if (searchKinds.length === 0)
      throw new MochiError(
        'E_WRONG_KIND',
        `"${ref}" names a ${kindName}, but a ${kinds.join(' or ')} is needed here.`,
        info,
      );
    const name = sep === '~' ? rawName.replace(/^"(.*)"$/, '$1') : rawName;
    const matches = this.ofKind(searchKinds).filter((o) =>
      sep === ':' ? 'exportId' in o && o.exportId === name : 'name' in o && o.name === name,
    );
    if (matches.length === 1) return (matches[0] as DocObject).uid;
    if (matches.length === 0)
      throw new MochiError(
        'E_NOT_FOUND',
        `No ${kindName} has the ${sep === ':' ? 'export ID' : 'name'} "${name}".`,
        info,
      );
    throw new MochiError(
      'E_AMBIGUOUS_REF',
      `${matches.length} objects are named "${name}". Use a UID or an export ID.`,
      {
        ...info,
        details: { candidates: matches.map((o) => describeObject(o)) },
      },
    );
  }

  /** Every place that refers to `uid`, as (object UID, path). Uses the schemas' reference fields. */
  referencesTo(uid: Uid): { from: Uid; path: string }[] {
    const out: { from: Uid; path: string }[] = [];
    for (const o of this.all()) {
      if (o.uid === uid) continue;
      visitRefs(OBJECT_SCHEMAS[o.kind], o, (ref, _kinds, path) => {
        if (ref === uid && path !== 'uid') out.push({ from: o.uid, path });
      });
    }
    out.sort(
      (a, b) => compareUids(a.from, b.from) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    return out;
  }
}

export class DocView extends DocReader {
  private list: DocObject[] | undefined;
  private readonly byKind = new Map<string, DocObject[]>();

  constructor(readonly doc: Document) {
    super();
  }
  get(uid: Uid): DocObject | undefined {
    return this.doc.objects[uid];
  }
  all(): Iterable<DocObject> {
    return (this.list ??= Object.values(this.doc.objects));
  }
  /** Cached per kind list: the document is immutable, so the view never changes. */
  override ofKind<K extends Kind>(kinds: K | readonly K[]): ObjectByKind[K][] {
    const key = Array.isArray(kinds) ? kinds.join(',') : (kinds as string);
    let r = this.byKind.get(key);
    if (!r) {
      r = super.ofKind(kinds);
      this.byKind.set(key, r);
    }
    return [...r] as ObjectByKind[K][];
  }
}

/** A mutable view over a document. Commands write through it; the transaction collects patches. */
export class Draft extends DocReader {
  private readonly changes = new Map<Uid, DocObject | undefined>();
  private seq: number;

  constructor(readonly base: Document) {
    super();
    this.seq = base.seq;
  }

  get(uid: Uid): DocObject | undefined {
    return this.changes.has(uid) ? this.changes.get(uid) : this.base.objects[uid];
  }

  *all(): Iterable<DocObject> {
    for (const [uid, o] of Object.entries(this.base.objects)) {
      if (this.changes.has(uid)) continue;
      yield o;
    }
    for (const o of this.changes.values()) if (o !== undefined) yield o;
  }

  put(obj: DocObject): void {
    this.changes.set(obj.uid, obj);
  }

  remove(uid: Uid): void {
    this.changes.set(uid, undefined);
  }

  updateProject(fn: (p: Project) => Project): void {
    this.put(fn(this.project()));
  }

  /** A new UID for an object of this kind. Deterministic: a counter, never reused. */
  allocate(kind: Exclude<Kind, 'project'>): Uid {
    const n = this.seq++;
    return `${UID_PREFIX[kind]}_${String(n).padStart(4, '0')}`;
  }

  /** The changed document and the patches that lead to it. */
  finish(): { doc: Document; patches: Patch[] } {
    const patches: Patch[] = [];
    const objects: Record<Uid, DocObject> = { ...this.base.objects };
    const uids = [...this.changes.keys()].sort(compareUids);
    for (const uid of uids) {
      const before = this.base.objects[uid];
      const after = this.changes.get(uid);
      if (before === after) continue;
      patches.push({ uid, before, after });
      if (after === undefined) delete objects[uid];
      else objects[uid] = after;
    }
    return { doc: { objects, seq: this.seq }, patches };
  }
}
