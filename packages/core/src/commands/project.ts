import { Type } from '@sinclair/typebox';
import { Empty, defineCommand } from '../command.js';
import { MochiError } from '../errors.js';
import { f32 } from '../f32.js';
import { RefOf } from '../schema.js';
import type { DeformPath } from '../model.js';
import { checkExportId, without } from './helpers.js';
import { ReplaceArgs, planReplace } from '../replace.js';
import type { DocObject } from '../model.js';

export const projectSetCanvas = defineCommand({
  name: 'project.setCanvas',
  summary: 'Set the canvas size, pixels per unit and origin.',
  doc: `Sets the canvas in pixels. \`pixelsPerUnit\` is how many canvas pixels make one model unit in the
exported file, and the origin is the model-space origin, in pixels from the canvas's top-left corner.
Stored positions are not moved.`,
  args: Type.Object({
    width: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    height: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    pixelsPerUnit: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    originX: Type.Optional(Type.Number()),
    originY: Type.Optional(Type.Number()),
  }),
  result: Empty,
  errors: ['E_SCHEMA'],
  examples: [
    {
      description: 'A 2048 × 4096 canvas',
      args: { width: 2048, height: 4096, pixelsPerUnit: 2048 },
    },
  ],
  apply(d, a) {
    d.updateProject((p) => ({
      ...p,
      canvas: {
        width: f32(a.width ?? p.canvas.width),
        height: f32(a.height ?? p.canvas.height),
        pixelsPerUnit: f32(a.pixelsPerUnit ?? p.canvas.pixelsPerUnit),
        originX: f32(a.originX ?? p.canvas.originX),
        originY: f32(a.originY ?? p.canvas.originY),
      },
    }));
    return {};
  },
});

export const projectSetExportSettings = defineCommand({
  name: 'project.setExportSettings',
  summary: 'Set the export target version, minimum version, atlas size and file stem.',
  doc: `\`mocVersion\` is 'auto' or 3, 4 or 5. 'auto' picks the lowest version that carries every feature
the document uses, but never below \`minimumVersion\` (design 2.2).`,
  args: Type.Object({
    mocVersion: Type.Optional(
      Type.Union([Type.Literal('auto'), Type.Literal(3), Type.Literal(4), Type.Literal(5)]),
    ),
    minimumVersion: Type.Optional(Type.Union([Type.Literal(3), Type.Literal(4), Type.Literal(5)])),
    atlasSize: Type.Optional(
      Type.Union([Type.Literal(1024), Type.Literal(2048), Type.Literal(4096), Type.Literal(8192)]),
    ),
    fileStem: Type.Optional(Type.String({ minLength: 1, pattern: '^[^/\\\\:*?"<>|]+$' })),
    includeGuideImages: Type.Optional(Type.Boolean()),
  }),
  result: Empty,
  errors: ['E_SCHEMA'],
  examples: [{ description: 'Export version 5 at 4096', args: { mocVersion: 5, atlasSize: 4096 } }],
  apply(d, a) {
    d.updateProject((p) => ({
      ...p,
      exportSettings: {
        mocVersion: a.mocVersion ?? p.exportSettings.mocVersion,
        minimumVersion: a.minimumVersion ?? p.exportSettings.minimumVersion,
        atlasSize: a.atlasSize ?? p.exportSettings.atlasSize,
        fileStem: a.fileStem ?? p.exportSettings.fileStem,
        includeGuideImages: a.includeGuideImages ?? p.exportSettings.includeGuideImages,
      },
    }));
    return {};
  },
});

export const objectRename = defineCommand({
  name: 'object.rename',
  summary: 'Change an object’s export ID and/or display name.',
  doc: `Works for every kind with names. Other objects refer to it by UID, so nothing else changes.
Export IDs must be unique within their namespace (parameters, parameter groups, parts, meshes,
deformers, glues).`,
  args: Type.Object({
    target: RefOf([
      'parameter',
      'parameterGroup',
      'part',
      'artMesh',
      'warp',
      'rotation',
      'glue',
      'layer',
      'expression',
      'motion',
      'physicsSetting',
      'sound',
    ]),
    exportId: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  }),
  result: Empty,
  errors: ['E_DUPLICATE_ID', 'E_BAD_EXPORT_ID', 'E_NOT_FOUND'],
  examples: [
    {
      description: 'Rename a mesh',
      args: { target: 'mesh_0004', exportId: 'ArtMesh_EyeL', name: 'Left eye' },
    },
  ],
  apply(d, a) {
    const o = d.get(a.target)!;
    let r = o;
    if (a.exportId !== undefined) {
      if (!('exportId' in o))
        throw new MochiError('E_FIELD_NOT_APPLICABLE', `${o.kind} objects have no export ID.`, {
          path: 'args.exportId',
        });
      checkExportId(d, o.kind, a.exportId, o.uid);
      r = { ...r, exportId: a.exportId } as typeof r;
    }
    if (a.name !== undefined) r = { ...r, name: a.name } as typeof r;
    if (r !== o) d.put(r);
    return {};
  },
});

export const metaSetHitAreas = defineCommand({
  name: 'meta.setHitAreas',
  summary: 'Replace the list of hit areas (mesh and name).',
  doc: 'Hit areas are exported to the model settings file with the mesh’s export ID.',
  args: Type.Object({
    hitAreas: Type.Array(Type.Object({ mesh: RefOf(['artMesh']), name: Type.String() })),
  }),
  result: Empty,
  errors: ['E_NOT_FOUND'],
  examples: [
    {
      description: 'One hit area',
      args: { hitAreas: [{ mesh: '@mesh:ArtMesh_Face', name: 'Head' }] },
    },
  ],
  apply(d, a) {
    d.updateProject((p) => ({
      ...p,
      hitAreas: a.hitAreas.map((h) => ({ mesh: h.mesh, name: h.name })),
    }));
    return {};
  },
});

export const metaSetStandardGroups = defineCommand({
  name: 'meta.setStandardGroups',
  summary: 'Set the EyeBlink and LipSync parameter groups.',
  doc: 'Apps drive the EyeBlink parameters for automatic blinking and the LipSync parameters for lip sync.',
  args: Type.Object({
    eyeBlink: Type.Optional(Type.Array(RefOf(['parameter']))),
    lipSync: Type.Optional(Type.Array(RefOf(['parameter']))),
  }),
  result: Empty,
  errors: ['E_NOT_FOUND'],
  examples: [
    {
      description: 'Blink both eyes',
      args: { eyeBlink: ['@param:ParamEyeLOpen', '@param:ParamEyeROpen'] },
    },
  ],
  apply(d, a) {
    const dedupe = (l: string[]) => [...new Set(l)];
    d.updateProject((p) => ({
      ...p,
      standardGroups: {
        eyeBlink: a.eyeBlink ? dedupe(a.eyeBlink) : p.standardGroups.eyeBlink,
        lipSync: a.lipSync ? dedupe(a.lipSync) : p.standardGroups.lipSync,
      },
    }));
    return {};
  },
});

export const metaSetCombinedParameters = defineCommand({
  name: 'meta.setCombinedParameters',
  summary: 'Replace the pairs of parameters shown as one 2D control.',
  doc: 'Exported to the display-info file. Each pair names two different parameters.',
  args: Type.Object({
    pairs: Type.Array(Type.Tuple([RefOf(['parameter']), RefOf(['parameter'])])),
  }),
  result: Empty,
  errors: ['E_RANGE'],
  examples: [
    {
      description: 'Angle X and Y',
      args: { pairs: [['@param:ParamAngleX', '@param:ParamAngleY']] },
    },
  ],
  apply(d, a) {
    a.pairs.forEach(([x, y], i) => {
      if (x === y)
        throw new MochiError('E_RANGE', 'A pair needs two different parameters.', {
          path: `args.pairs[${i}]`,
        });
    });
    d.updateProject((p) => ({
      ...p,
      combinedParameters: a.pairs.map(([x, y]) => [x, y] as [string, string]),
    }));
    return {};
  },
});

export const metaSetUserData = defineCommand({
  name: 'meta.setUserData',
  summary: 'Replace the user-data strings attached to meshes, parts or parameters.',
  doc: 'Exported to the user-data file. Playback ignores user data; apps may read it.',
  args: Type.Object({
    entries: Type.Array(
      Type.Object({ target: RefOf(['artMesh', 'part', 'parameter']), value: Type.String() }),
    ),
  }),
  result: Empty,
  errors: ['E_NOT_FOUND'],
  examples: [
    {
      description: 'Tag a mesh',
      args: { entries: [{ target: '@mesh:ArtMesh_Face', value: 'face' }] },
    },
  ],
  apply(d, a) {
    d.updateProject((p) => ({
      ...p,
      userData: a.entries.map((e) => ({ target: e.target, value: e.value })),
    }));
    return {};
  },
});

export const poseSetGroups = defineCommand({
  name: 'pose.setGroups',
  summary: 'Replace the pose groups (mutually exclusive parts) and the pose fade time.',
  doc: `Each group lists parts of which only one is shown at a time; \`links\` are parts that copy an
entry's opacity. A part may appear in at most one group.`,
  args: Type.Object({
    fadeIn: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    groups: Type.Array(
      Type.Array(
        Type.Object({ part: RefOf(['part']), links: Type.Optional(Type.Array(RefOf(['part']))) }),
      ),
    ),
  }),
  result: Empty,
  errors: ['E_RANGE'],
  examples: [
    {
      description: 'Two arm poses',
      args: { groups: [[{ part: '@part:ArmA' }, { part: '@part:ArmB' }]] },
    },
  ],
  apply(d, a) {
    const seen = new Set<string>();
    a.groups.forEach((g, i) =>
      g.forEach((e, j) => {
        if (seen.has(e.part))
          throw new MochiError('E_RANGE', `${d.describe(e.part)} is in more than one pose entry.`, {
            path: `args.groups[${i}][${j}]`,
          });
        seen.add(e.part);
      }),
    );
    d.updateProject((p) => ({
      ...p,
      pose: {
        fadeIn: a.fadeIn === undefined ? p.pose.fadeIn : a.fadeIn,
        groups: a.groups
          .filter((g) => g.length > 0)
          .map((g) =>
            g.map((e) => ({ part: e.part, links: without([...new Set(e.links ?? [])], e.part) })),
          ),
      },
    }));
    return {};
  },
});

// ---------------------------------------------------------------- deform paths

const Points = () =>
  Type.Array(Type.Tuple([Type.Number(), Type.Number()]), {
    minItems: 1,
    description: 'canvas pixels',
  });
const pathIndex = (paths: readonly DeformPath[], id: number): number => {
  const i = paths.findIndex((p) => p.id === id);
  if (i < 0)
    throw new MochiError('E_NOT_FOUND', `There is no deform path ${id}.`, { path: 'args.id' });
  return i;
};

export const deformPathCreate = defineCommand({
  name: 'deformPath.create',
  summary: 'Save a deform path: an editor-side helper over art meshes and warps (never exported).',
  doc: `Paths belong to edit level 2 or 3. Dragging a path's points in the editor drags the points
of its targets within \`reach\` (canvas pixels) along; only the resulting keyform values are
exported. Returns the path's id.`,
  args: Type.Object({
    targets: Type.Array(RefOf(['artMesh', 'warp']), { minItems: 1 }),
    level: Type.Union([Type.Literal(2), Type.Literal(3)]),
    points: Points(),
    reach: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  }),
  result: Type.Object({ id: Type.Integer() }),
  errors: ['E_NOT_FOUND', 'E_WRONG_KIND'],
  examples: [
    {
      description: 'A path along the upper lip',
      args: {
        targets: ['@mesh:ArtMesh_Mouth'],
        level: 2,
        points: [
          [900, 1400],
          [1000, 1380],
          [1100, 1400],
        ],
      },
    },
  ],
  apply(d, a) {
    const targets = a.targets.map(
      (r, i) => d.getAs(r, ['artMesh', 'warp'], `args.targets[${i}]`).uid,
    );
    const paths = d.project().deformPaths;
    const id = paths.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    const path: DeformPath = {
      id,
      targets: [...new Set(targets)],
      level: a.level,
      points: a.points.map(([x, y]) => [x, y]),
      reach: a.reach ?? 60,
    };
    d.updateProject((p) => ({ ...p, deformPaths: [...p.deformPaths, path] }));
    return { id };
  },
});

export const deformPathUpdate = defineCommand({
  name: 'deformPath.update',
  summary: 'Move a deform path’s points, or change its reach.',
  doc: 'The points replace the old ones (the same number or not).',
  args: Type.Object({
    id: Type.Integer(),
    points: Type.Optional(Points()),
    reach: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  }),
  result: Empty,
  errors: ['E_NOT_FOUND'],
  examples: [],
  apply(d, a) {
    const paths = d.project().deformPaths;
    const i = pathIndex(paths, a.id);
    const next = [...paths];
    next[i] = {
      ...paths[i]!,
      ...(a.points ? { points: a.points.map(([x, y]) => [x, y] as [number, number]) } : {}),
      ...(a.reach !== undefined ? { reach: a.reach } : {}),
    };
    d.updateProject((p) => ({ ...p, deformPaths: next }));
    return {};
  },
});

export const deformPathDelete = defineCommand({
  name: 'deformPath.delete',
  summary: 'Delete a deform path (the keyforms it shaped stay).',
  doc: 'Only the helper goes.',
  args: Type.Object({ id: Type.Integer() }),
  result: Empty,
  errors: ['E_NOT_FOUND'],
  examples: [],
  apply(d, a) {
    const paths = d.project().deformPaths;
    const i = pathIndex(paths, a.id);
    d.updateProject((p) => ({ ...p, deformPaths: paths.filter((_, j) => j !== i) }));
    return {};
  },
});

// ---------------------------------------------------------------- find and replace

const Change = Type.Object({
  uid: Type.String(),
  kind: Type.String(),
  field: Type.Union([Type.Literal('exportId'), Type.Literal('name')]),
  from: Type.String(),
  to: Type.String(),
});

export const objectsReplaceText = defineCommand({
  name: 'objects.replaceText',
  summary:
    'Find and replace in the export IDs and names of parameters, parts, deformers and meshes.',
  doc: `Plain text, or a JavaScript regular expression with \`pattern: true\` (\`$1\` in the replacement
inserts a group). \`fields\` limits it to export IDs or names, \`kinds\` to some of parameter, part,
warp, rotation and artMesh. Other objects refer to these by UID, so bindings, masks, physics, the
pose, expressions and motion curves stay attached, and the exported files carry the new IDs and
names. The whole result is checked first: an invalid or duplicate export ID refuses the command and
changes nothing (a dry run lists the changes). Returns every change.`,
  args: ReplaceArgs,
  result: Type.Object({ changes: Type.Array(Change) }),
  errors: ['E_RANGE', 'E_BAD_EXPORT_ID', 'E_DUPLICATE_ID'],
  examples: [
    {
      description: 'Left to right in IDs and names',
      args: { find: 'Left', replace: 'Right' },
    },
    {
      description: 'Swap a suffix with a pattern, in export IDs only',
      args: { find: '_L$', replace: '_Left', pattern: true, fields: ['exportId'] },
    },
  ],
  apply(d, a) {
    const { changes, problems } = planReplace(d, a);
    if (problems.length)
      throw new MochiError(problems[0]!.code, problems.map((p) => p.message).join(' '), {
        path: 'args.replace',
      });
    for (const c of changes) {
      const o = d.get(c.uid)!;
      d.put({ ...o, [c.field]: c.to } as DocObject);
    }
    return { changes };
  },
});
