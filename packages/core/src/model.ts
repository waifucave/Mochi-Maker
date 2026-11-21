/**
 * The document model (design section 3).
 *
 * Every object has a stable UID, and the exportable kinds also have an export ID (written into the
 * runtime files) and a display name. Objects are immutable: commands replace them.
 *
 * Spaces (design 3.5): an object's positions are stored in its parent deformer's input space.
 * Without a deformer that is canvas pixels, y downward. Inside a warp it is normalized (u, v),
 * and inside a rotation it is canvas pixels relative to the rotation's origin.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import {
  ASSET_HASH_PATTERN,
  ExportId,
  F32,
  F32Points,
  Nullable,
  Rgb,
  U16Triangles,
  UidOf,
  type Kind,
} from './schema.js';

export type Uid = string;

// ---------------------------------------------------------------- rigs

export const Binding = Type.Object(
  {
    parameter: UidOf(['parameter']),
    keys: Type.Array(F32(), { description: 'ascending; a subset of the parameter key list' }),
  },
  { description: 'one interpolation axis: a parameter and the keys where keyforms exist' },
);
export type Binding = Static<typeof Binding>;

const keyformBase = {
  authored: Type.Boolean({
    description: 'false when the keyform was filled automatically and nobody has edited it yet',
  }),
};

export const MeshKeyform = Type.Object({
  ...keyformBase,
  positions: F32Points('vertex positions in the parent deformer space'),
  opacity: F32(),
  drawOrder: F32(),
  multiply: Rgb(),
  screen: Rgb(),
});
export const WarpKeyform = Type.Object({
  ...keyformBase,
  grid: F32Points('grid points, row-major, (rows+1)·(cols+1)'),
  opacity: F32(),
  multiply: Rgb(),
  screen: Rgb(),
});
export const RotationKeyform = Type.Object({
  ...keyformBase,
  angle: F32({ description: 'degrees' }),
  originX: F32(),
  originY: F32(),
  scale: F32({ description: '1 = natural size; the exporter adds the 1/ppu factor (design 3.5)' }),
  mirrorX: Type.Boolean(),
  mirrorY: Type.Boolean(),
  opacity: F32(),
  multiply: Rgb(),
  screen: Rgb(),
});
export const PartKeyform = Type.Object({
  ...keyformBase,
  drawOrder: F32(),
  opacity: F32({ description: 'the offscreen’s opacity, used while the part draws offscreen' }),
  multiply: Rgb(),
  screen: Rgb(),
});
export const GlueKeyform = Type.Object({ ...keyformBase, intensity: F32() });

export type MeshKeyform = Static<typeof MeshKeyform>;
export type WarpKeyform = Static<typeof WarpKeyform>;
export type RotationKeyform = Static<typeof RotationKeyform>;
export type PartKeyform = Static<typeof PartKeyform>;
export type GlueKeyform = Static<typeof GlueKeyform>;
export type AnyKeyform = MeshKeyform | WarpKeyform | RotationKeyform | PartKeyform | GlueKeyform;

const RigOf = <K extends TSchema>(keyform: K) =>
  Type.Object(
    {
      bindings: Type.Array(Binding),
      keyforms: Type.Array(keyform, {
        description: 'the full grid, Π(keys) entries; the first binding varies fastest',
      }),
    },
    { description: 'bindings and keyforms' },
  );

export interface Rig<K extends AnyKeyform = AnyKeyform> {
  bindings: Binding[];
  keyforms: K[];
}

// ---------------------------------------------------------------- blend shapes
//
// Difference-based interpolation (design 3.7; §1c.4); authoring it is not available in this
// build unless the `blendShapes` feature is on. A blend shape adds w·s to an object's normal result: s interpolates the
// shape's per-key deltas over a blend-shape parameter, and w is the minimum of its constraint
// curves (1 without constraints). The document stores deltas, one per key, with the base key's
// delta all zero, exactly as files store them.

export const MeshDelta = Type.Object({
  positions: F32Points('vertex offsets in the parent deformer space'),
  opacity: F32(),
  drawOrder: F32(),
  multiply: Rgb(),
  screen: Rgb(),
});
export const WarpDelta = Type.Object({
  grid: F32Points('grid-point offsets, row-major'),
  opacity: F32(),
  multiply: Rgb(),
  screen: Rgb(),
});
export const RotationDelta = Type.Object({
  angle: F32({ description: 'degrees' }),
  originX: F32(),
  originY: F32(),
  scale: F32(),
  opacity: F32(),
  multiply: Rgb(),
  screen: Rgb(),
});
export const PartDelta = Type.Object({
  drawOrder: F32(),
  opacity: F32({ description: 'offscreen opacity offset, used while the part draws offscreen' }),
  multiply: Rgb(),
  screen: Rgb(),
});
export const GlueDelta = Type.Object({ intensity: F32() });

export type MeshDelta = Static<typeof MeshDelta>;
export type WarpDelta = Static<typeof WarpDelta>;
export type RotationDelta = Static<typeof RotationDelta>;
export type PartDelta = Static<typeof PartDelta>;
export type GlueDelta = Static<typeof GlueDelta>;
export type AnyDelta = MeshDelta | WarpDelta | RotationDelta | PartDelta | GlueDelta;

export const BlendShapeConstraint = Type.Object(
  {
    parameter: UidOf(['parameter']),
    points: Type.Array(Type.Tuple([F32(), F32()]), {
      description: '(parameter value, weight), values strictly ascending; constant beyond the ends',
    }),
  },
  {
    description:
      'a weight curve over a parameter (any, even the blend shape’s own); the blend shape uses min(1, every curve)',
  },
);
export type BlendShapeConstraint = Static<typeof BlendShapeConstraint>;

const BlendShapeOf = <D extends TSchema>(delta: D) =>
  Type.Object(
    {
      parameter: UidOf(['parameter'], { description: 'a blend-shape parameter' }),
      keys: Type.Array(F32(), { description: 'ascending; a subset of the parameter key list' }),
      base: F32({ description: 'the base key, one of `keys`; its delta is all zero' }),
      deltas: Type.Array(delta, { description: 'one per key' }),
      constraints: Type.Array(BlendShapeConstraint),
    },
    { description: 'a blend shape' },
  );

export interface BlendShape<D extends AnyDelta = AnyDelta> {
  parameter: Uid;
  keys: number[];
  base: number;
  deltas: D[];
  constraints: BlendShapeConstraint[];
}

// ---------------------------------------------------------------- objects

const named = {
  exportId: ExportId({ description: 'the ID written into runtime files' }),
  name: Type.String({ description: 'display name' }),
};

export const Parameter = Type.Object({
  kind: Type.Literal('parameter'),
  uid: UidOf(['parameter']),
  ...named,
  group: Nullable(UidOf(['parameterGroup'])),
  min: F32(),
  max: F32(),
  default: F32(),
  repeat: Type.Boolean({ description: 'cyclic parameter' }),
  decimals: Type.Integer({
    minimum: 0,
    maximum: 9,
    description:
      'the editor’s display precision; the export always writes 3, the evaluation tolerance',
  }),
  type: Type.Union([Type.Literal('normal'), Type.Literal('blendShape')]),
  keys: Type.Array(F32(), { description: 'ascending key list; bindings use subsets of it' }),
});
export type Parameter = Static<typeof Parameter>;

export const ParameterGroup = Type.Object({
  kind: Type.Literal('parameterGroup'),
  uid: UidOf(['parameterGroup']),
  ...named,
  parent: Nullable(UidOf(['parameterGroup'])),
});
export type ParameterGroup = Static<typeof ParameterGroup>;

// ---------------------------------------------------------------- blend modes (version 6)

/**
 * Color functions of a blend mode, in code order (the code is the index). `normal`, `additive` and
 * `multiplicative` are the blends every version has; the others need version 6.
 */
export const COLOR_BLENDS = [
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
] as const;
/** How the source's alpha combines with what is below it, in code order. */
export const ALPHA_BLENDS = ['over', 'atop', 'out', 'conjoint', 'disjoint'] as const;
export type ColorBlend = (typeof COLOR_BLENDS)[number];
export type AlphaBlend = (typeof ALPHA_BLENDS)[number];

export const BlendMode = Type.Object(
  {
    color: Type.Union(COLOR_BLENDS.map((c) => Type.Literal(c))),
    alpha: Type.Union(ALPHA_BLENDS.map((c) => Type.Literal(c))),
  },
  { description: 'a version 6 blend mode: a color function and an alpha mode' },
);
export type BlendMode = Static<typeof BlendMode>;

/** The file's code of a blend mode: the color function, and the alpha mode times 256. */
export const blendCode = (b: BlendMode): number =>
  COLOR_BLENDS.indexOf(b.color) | (ALPHA_BLENDS.indexOf(b.alpha) << 8);

/**
 * Whether every version can draw a blend mode: normal over, or the additive and multiplicative
 * functions (with any alpha mode, which they ignore).
 */
export const isCompatibleBlend = (b: BlendMode): boolean =>
  b.color === 'additive' ||
  b.color === 'multiplicative' ||
  (b.color === 'normal' && b.alpha === 'over');

/**
 * A part drawn offscreen (version 6): its contents are drawn into an image of their own, which is
 * then composited with the part keyforms' opacity and tints, this blend mode and these masks.
 */
export const Offscreen = Type.Object({
  blend: BlendMode,
  clip: Nullable(
    Type.Object({
      masks: Type.Array(UidOf(['artMesh'])),
      invert: Type.Boolean(),
    }),
  ),
});
export type Offscreen = Static<typeof Offscreen>;

export const Part = Type.Object({
  kind: Type.Literal('part'),
  uid: UidOf(['part']),
  ...named,
  parent: Nullable(UidOf(['part'])),
  children: Type.Array(UidOf(['part', 'artMesh']), { description: 'parts and meshes, in order' }),
  visibleAtStart: Type.Boolean({ description: 'initial opacity 1 (true) or 0 (false)' }),
  enabled: Type.Boolean(),
  sortingScope: Type.Union([Type.Literal('inherit'), Type.Literal('own')], {
    description: "'own': children sort among themselves and the part sorts as one item",
  }),
  guide: Type.Boolean({
    description: 'a guide image: a visual reference, exported only when the export settings ask',
  }),
  offscreen: Nullable(Offscreen, {
    description: 'drawn offscreen (version 6; needs its own sorting scope), or null',
  }),
  rig: RigOf(PartKeyform),
  blendShapes: Type.Array(BlendShapeOf(PartDelta)),
});
export type Part = Static<typeof Part>;

export const ArtMesh = Type.Object({
  kind: Type.Literal('artMesh'),
  uid: UidOf(['artMesh']),
  ...named,
  part: Nullable(UidOf(['part'])),
  deformer: Nullable(UidOf(['warp', 'rotation'])),
  layer: Nullable(UidOf(['layer'])),
  uv: F32Points('texture coordinates in the layer’s pixel space'),
  triangles: U16Triangles(),
  doubleSided: Type.Boolean(),
  enabled: Type.Boolean(),
  legacyBlend: Type.Union([
    Type.Literal('normal'),
    Type.Literal('additive'),
    Type.Literal('multiplicative'),
  ]),
  blend: Nullable(BlendMode, {
    description:
      'a version 6 blend mode beyond the legacy ones, or null for legacyBlend (isCompatibleBlend modes are kept as legacyBlend)',
  }),
  clip: Nullable(
    Type.Object({
      masks: Type.Array(UidOf(['artMesh'])),
      invert: Type.Boolean(),
    }),
  ),
  rig: RigOf(MeshKeyform),
  blendShapes: Type.Array(BlendShapeOf(MeshDelta)),
});
export type ArtMesh = Static<typeof ArtMesh>;

const deformerBase = {
  ...named,
  part: Nullable(UidOf(['part'], { description: 'owning part' })),
  parent: Nullable(UidOf(['warp', 'rotation'])),
  enabled: Type.Boolean(),
};

export const Warp = Type.Object({
  kind: Type.Literal('warp'),
  uid: UidOf(['warp']),
  ...deformerBase,
  rows: Type.Integer({ minimum: 1, maximum: 256 }),
  cols: Type.Integer({ minimum: 1, maximum: 256 }),
  cellMode: Type.Union([Type.Literal('triangles'), Type.Literal('bilinear')]),
  rig: RigOf(WarpKeyform),
  blendShapes: Type.Array(BlendShapeOf(WarpDelta)),
});
export type Warp = Static<typeof Warp>;

export const Rotation = Type.Object({
  kind: Type.Literal('rotation'),
  uid: UidOf(['rotation']),
  ...deformerBase,
  baseAngle: F32({ description: 'degrees' }),
  rig: RigOf(RotationKeyform),
  blendShapes: Type.Array(BlendShapeOf(RotationDelta)),
});
export type Rotation = Static<typeof Rotation>;

export const Layer = Type.Object({
  kind: Type.Literal('layer'),
  uid: UidOf(['layer']),
  name: Type.String(),
  asset: Type.String({ pattern: ASSET_HASH_PATTERN.source, description: 'SHA-256 of the PNG' }),
  x: Type.Integer({ description: 'canvas position of the image’s top-left pixel' }),
  y: Type.Integer(),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  visible: Type.Boolean(),
  opacity: F32({
    minimum: 0,
    maximum: 1,
    description: 'the source layer’s opacity (informational)',
  }),
  blendMode: Type.String({
    description: 'the source layer’s blend mode, e.g. normal, multiply, screen (informational)',
  }),
  clipped: Type.Boolean({ description: 'clipped to the layer below in the source file' }),
  notes: Type.Array(Type.String(), { description: 'import notes, e.g. unsupported features' }),
  source: Nullable(Type.String({ description: 'where the layer was imported from' })),
  texturePage: Type.Boolean({
    description:
      'a whole texture page kept as it is (an imported model’s page): exported as its own page, unpacked, with its meshes’ UVs unchanged',
  }),
});
export type Layer = Static<typeof Layer>;

export const Glue = Type.Object({
  kind: Type.Literal('glue'),
  uid: UidOf(['glue']),
  exportId: ExportId(),
  name: Type.String(),
  meshA: UidOf(['artMesh']),
  meshB: UidOf(['artMesh']),
  pairs: Type.Array(
    Type.Tuple([Type.Integer({ minimum: 0 }), F32(), Type.Integer({ minimum: 0 }), F32()]),
    { description: '[vertex of A, weight of A, vertex of B, weight of B]' },
  ),
  rig: RigOf(GlueKeyform),
  blendShapes: Type.Array(BlendShapeOf(GlueDelta)),
});
export type Glue = Static<typeof Glue>;

const NullableNumber = () => Nullable(Type.Number());

export const Expression = Type.Object({
  kind: Type.Literal('expression'),
  uid: UidOf(['expression']),
  name: Type.String({ description: 'name in the model settings; also the file stem' }),
  fadeIn: NullableNumber(),
  fadeOut: NullableNumber(),
  entries: Type.Array(
    Type.Object({
      parameter: UidOf(['parameter']),
      value: Type.Number(),
      blend: Type.Union([Type.Literal('Add'), Type.Literal('Multiply'), Type.Literal('Overwrite')]),
    }),
  ),
});
export type Expression = Static<typeof Expression>;

export const MotionCurve = Type.Object({
  target: Type.Union([
    Type.Literal('model'),
    Type.Literal('parameter'),
    Type.Literal('partOpacity'),
  ]),
  model: Nullable(
    Type.Union([Type.Literal('EyeBlink'), Type.Literal('LipSync'), Type.Literal('Opacity')]),
  ),
  object: Nullable(UidOf(['parameter', 'part'])),
  fadeIn: NullableNumber(),
  fadeOut: NullableNumber(),
  segments: Type.Array(Type.Number(), {
    description:
      'first point, then segments: code (0 linear, 1 Bézier, 2 stepped, 3 inverse stepped) and points',
  }),
  auto: Type.Array(Type.Integer({ minimum: 0 }), {
    description:
      'indices of the Bézier segments that are Auto smooth: their handles follow the keys',
  }),
});
export type MotionCurve = Static<typeof MotionCurve>;

export const Motion = Type.Object({
  kind: Type.Literal('motion'),
  uid: UidOf(['motion']),
  name: Type.String(),
  group: Type.String({ description: 'motion group in the model settings, e.g. Idle' }),
  duration: Type.Number({ minimum: 0 }),
  fps: Type.Number({ minimum: 0 }),
  loop: Type.Boolean(),
  restrictedBeziers: Type.Boolean(),
  fadeIn: NullableNumber(),
  fadeOut: NullableNumber(),
  curves: Type.Array(MotionCurve),
  events: Type.Array(Type.Object({ time: Type.Number(), value: Type.String() })),
  sound: Nullable(
    UidOf(['sound'], { description: 'a sound started with the motion (model settings `Sound`)' }),
  ),
  motionSync: Nullable(
    UidOf(['motionSyncSetting'], {
      description:
        'the motion-sync setting through which the sound moves the mouth (model settings `MotionSync`); null: lip sync, if any',
    }),
  ),
  workArea: Nullable(
    Type.Object(
      { start: Type.Number({ minimum: 0 }), end: Type.Number({ minimum: 0 }) },
      {
        description:
          'the part of the timeline that playback loops and exports render (editor-side, not exported); null: the whole motion',
      },
    ),
  ),
  markers: Type.Array(Type.Object({ time: Type.Number({ minimum: 0 }), name: Type.String() }), {
    description: 'timeline markers, in time order (editor-side, not exported)',
  }),
});
export type Motion = Static<typeof Motion>;

const PhysicsIO = {
  parameter: UidOf(['parameter']),
  weight: Type.Number({ description: 'percent' }),
  type: Type.Union([Type.Literal('X'), Type.Literal('Y'), Type.Literal('Angle')]),
  reflect: Type.Boolean(),
};
const Range3 = Type.Object({ min: Type.Number(), default: Type.Number(), max: Type.Number() });

export const PhysicsSetting = Type.Object({
  kind: Type.Literal('physicsSetting'),
  uid: UidOf(['physicsSetting']),
  name: Type.String(),
  inputs: Type.Array(Type.Object(PhysicsIO)),
  outputs: Type.Array(
    Type.Object({
      ...PhysicsIO,
      particle: Type.Integer({ minimum: 0 }),
      scale: Type.Number(),
    }),
  ),
  particles: Type.Array(
    Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      mobility: Type.Number(),
      delay: Type.Number(),
      acceleration: Type.Number(),
      radius: Type.Number(),
    }),
  ),
  normalization: Type.Object({ position: Range3, angle: Range3 }),
});
export type PhysicsSetting = Static<typeof PhysicsSetting>;

/**
 * A motion-sync setting: how a sound moves the mouth. Mochi2D analyses the sound into
 * the weights of audio elements (Silence and the vowels A, I, U, E, O); each element has a shape,
 * a value for each driven parameter, and the parameters take the shapes blended by the weights.
 * Exported as a `.motionsync3.json` (Mochi2D's `writeMotionSync`).
 */
export const MotionSyncSetting = Type.Object({
  kind: Type.Literal('motionSyncSetting'),
  uid: UidOf(['motionSyncSetting']),
  name: Type.String({
    minLength: 1,
    description: 'the dictionary name, by which a motion picks the setting',
  }),
  useCase: Type.String({ description: 'e.g. Mouth' }),
  analysisType: Type.String({ description: 'the analysis the file names (CRI)' }),
  sampleRate: Type.Number({ minimum: 1, maximum: 120, description: 'analysis ticks per second' }),
  smoothing: Type.Number({
    minimum: 1,
    maximum: 100,
    description: 'how smooth the analysis results are: 1 intense, 100 smooth',
  }),
  blendRatio: Type.Number({
    minimum: 0,
    maximum: 1,
    description: "0: the likeliest element's shape; 1: the shapes blended by weight",
  }),
  parameters: Type.Array(
    Type.Object({
      parameter: UidOf(['parameter']),
      damper: Type.Number({ minimum: 0, description: 'the dead band' }),
      smooth: Type.Number({ minimum: 0, maximum: 100, description: 'smoothing weight, percent' }),
    }),
    { description: 'the driven parameters' },
  ),
  elements: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, description: 'Silence, A, I, U, E or O' }),
      name: Type.String(),
      enabled: Type.Boolean(),
      scale: Type.Number({ minimum: 0.1, maximum: 10, description: 'multiplies the weight' }),
    }),
  ),
  shapes: Type.Array(Type.Array(Type.Number()), {
    description: "shapes[e][k]: element e's value for driven parameter k",
  }),
});
export type MotionSyncSetting = Static<typeof MotionSyncSetting>;

export const Sound = Type.Object({
  kind: Type.Literal('sound'),
  uid: UidOf(['sound']),
  name: Type.String({ minLength: 1, description: 'display name; also the exported file name' }),
  asset: Type.String({
    pattern: ASSET_HASH_PATTERN.source,
    description: 'SHA-256 of the WAV file',
  }),
  sampleRate: Type.Integer({ minimum: 1 }),
  channels: Type.Integer({ minimum: 1 }),
  frames: Type.Integer({ minimum: 0, description: 'samples per channel' }),
});
export type Sound = Static<typeof Sound>;

/**
 * An animation template (the Template palette): a named run of parameter keys, matched by
 * parameter export ID, so it applies to any model with those IDs. Times start at 0.
 */
export const AnimationTemplate = Type.Object({
  name: Type.String({ minLength: 1 }),
  duration: Type.Number({
    minimum: 0,
    description: 'seconds: the length of the range it came from',
  }),
  curves: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, description: 'parameter export ID' }),
      keys: Type.Array(
        Type.Object({
          time: Type.Number({ minimum: 0 }),
          value: Type.Number(),
          interp: Type.Union([
            Type.Literal('linear'),
            Type.Literal('auto'),
            Type.Literal('step'),
            Type.Literal('inverseStep'),
            Type.Literal('bezier'),
          ]),
          handles: Type.Optional(
            Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]),
          ),
        }),
        { minItems: 1 },
      ),
    }),
  ),
});
export type AnimationTemplate = Static<typeof AnimationTemplate>;

/**
 * A deform path: an editor-side helper drawn over art meshes and
 * warps, whose points drag the points near it. Saved with the project, never exported. Targets
 * that no longer exist are ignored.
 */
export const DeformPath = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  targets: Type.Array(UidOf(['artMesh', 'warp'])),
  level: Type.Union([Type.Literal(2), Type.Literal(3)], {
    description: 'the edit level it belongs to',
  }),
  points: Type.Array(Type.Tuple([Type.Number(), Type.Number()]), {
    minItems: 1,
    description: 'canvas pixels',
  }),
  reach: Type.Number({ exclusiveMinimum: 0, description: 'canvas pixels' }),
});
export type DeformPath = Static<typeof DeformPath>;

/**
 * What an imported model's file has that the document otherwise derives (its own habits), kept so
 * that an unedited export writes the file's order and values again. Entries name UIDs; ones that
 * no longer exist are ignored, and objects not listed follow in the document's order.
 */
export const ImportKeep = Type.Object(
  {
    parts: Type.Array(Type.String(), { description: 'the parts’ index order in the file' }),
    artMeshes: Type.Array(Type.String(), { description: 'the art meshes’ index order' }),
    deformers: Type.Array(Type.String(), { description: 'the deformers’ index order' }),
    groups: Type.Array(Nullable(Type.String()), {
      description: 'the draw-order groups’ order: each group’s own-scope part, null for the top',
    }),
    values: Type.Array(Type.Tuple([Type.String(), Type.Number(), Type.Number()]), {
      description:
        '[path, document value, file value] for values with no exact float32 inverse: while the document still holds that value, the export writes the file’s',
    }),
    decimals: Type.Array(Type.Tuple([Type.String(), Type.Integer({ minimum: 0 })]), {
      description: '[parameter UID, decimal places] where the file does not have 3',
    }),
    hidden: Type.Array(Type.String(), {
      description: 'art meshes and deformers whose file flag says hidden',
    }),
    meshFlags: Type.Array(Type.Tuple([Type.String(), Type.Integer({ minimum: 0 })]), {
      description: '[art mesh UID, flag bits the document has no place for]',
    }),
    canvasFlags: Type.Integer({ minimum: 0 }),
    blendCodes: Type.Array(Type.Tuple([Type.String(), Type.Integer(), Type.Integer()]), {
      description:
        '[art mesh or part UID, the code the document gives, the file’s code] for version 6 blend codes the document holds otherwise: written while the document gives that code',
    }),
    offscreenFlags: Type.Array(Type.Tuple([Type.String(), Type.Integer({ minimum: 0 })]), {
      description: '[part UID, offscreen flag bits other than the inverted mask]',
    }),
    offscreens: Type.Array(Type.String(), {
      description: 'the parts drawn offscreen, in the file’s offscreen order',
    }),
    blendFlags: Type.Array(Type.Tuple([Type.String(), Type.Integer(), Type.Integer()]), {
      description:
        '[art mesh UID, the flag bits 0–1 the document gives, the file’s] in version 6 files, where the blend code, not these bits, gives the blending: written while the document gives those bits',
    }),
    ranges: Type.Array(
      Type.Tuple([
        Type.Integer({ minimum: 0 }),
        Type.Integer(),
        Type.Integer(),
        Type.Integer(),
        Type.Integer(),
      ]),
      {
        description:
          '[group index, the file’s min and max draw order, the reachable range its data gives] where the two differ: while the reachable range is unchanged, the export writes the file’s',
      },
    ),
  },
  { description: 'the imported file’s own order and values' },
);
export type ImportKeep = Static<typeof ImportKeep>;

/** The singleton root object: canvas, ordered lists and project-wide settings. */
export const Project = Type.Object({
  kind: Type.Literal('project'),
  uid: Type.Literal('project'),
  canvas: Type.Object({
    width: F32({ description: 'pixels' }),
    height: F32(),
    pixelsPerUnit: F32(),
    originX: F32({ description: 'pixels from the left edge' }),
    originY: F32({ description: 'pixels from the top edge' }),
  }),
  parameterOrder: Type.Array(UidOf(['parameter'])),
  parameterGroupOrder: Type.Array(UidOf(['parameterGroup'])),
  root: Type.Array(UidOf(['part', 'artMesh']), { description: 'top of the part tree, in order' }),
  deformerOrder: Type.Array(UidOf(['warp', 'rotation']), {
    description: 'every deformer, parents before children',
  }),
  layerOrder: Type.Array(UidOf(['layer']), { description: 'bottom to top' }),
  glueOrder: Type.Array(UidOf(['glue']), { description: 'glues apply in this order' }),
  expressionOrder: Type.Array(UidOf(['expression'])),
  motionOrder: Type.Array(UidOf(['motion'])),
  soundOrder: Type.Array(UidOf(['sound'])),
  physicsOrder: Type.Array(UidOf(['physicsSetting'])),
  motionSyncOrder: Type.Array(UidOf(['motionSyncSetting']), {
    description: 'motion-sync settings, in file order',
  }),
  physicsFps: Type.Number({ minimum: 0, description: '0: the step equals the frame time' }),
  deformPaths: Type.Array(DeformPath, { description: 'editor-side helpers, not exported' }),
  animationTemplates: Type.Array(AnimationTemplate, {
    description: 'the Template palette, in its order; names are unique',
  }),
  hitAreas: Type.Array(Type.Object({ mesh: UidOf(['artMesh']), name: Type.String() })),
  standardGroups: Type.Object({
    eyeBlink: Type.Array(UidOf(['parameter'])),
    lipSync: Type.Array(UidOf(['parameter'])),
  }),
  combinedParameters: Type.Array(Type.Tuple([UidOf(['parameter']), UidOf(['parameter'])])),
  userData: Type.Array(
    Type.Object({ target: UidOf(['artMesh', 'part', 'parameter']), value: Type.String() }),
  ),
  pose: Type.Object({
    fadeIn: NullableNumber(),
    groups: Type.Array(
      Type.Array(Type.Object({ part: UidOf(['part']), links: Type.Array(UidOf(['part'])) })),
    ),
  }),
  importedFrom: Nullable(
    Type.Object(
      {
        format: Type.Literal('moc3'),
        date: Type.String({ description: 'when it was imported (ISO 8601, from the caller)' }),
        mocVersion: Type.Integer({ minimum: 1, maximum: 6 }),
        files: Type.Array(Type.String(), { description: 'the model folder’s files, as read' }),
        keep: Nullable(ImportKeep),
      },
      { description: 'the project was imported from a .moc3 model folder' },
    ),
  ),
  stacks: Type.Array(
    Type.Object({
      scope: Nullable(Type.String({ description: 'an own-scope part’s UID; null: the top level' })),
      entries: Type.Array(Type.String(), {
        description:
          'the group’s meshes and own-scope parts (UIDs), back to front among equal draw orders',
      }),
    }),
    {
      description:
        'explicit stacking orders of draw-order groups, where the part tree’s order cannot hold them (an imported model’s); objects not listed stack after their predecessor in the tree, and UIDs that no longer exist are ignored',
    },
  ),
  exportSettings: Type.Object({
    mocVersion: Type.Union([
      Type.Literal('auto'),
      Type.Literal(3),
      Type.Literal(4),
      Type.Literal(5),
      Type.Literal(6),
    ]),
    minimumVersion: Type.Union([Type.Literal(3), Type.Literal(4), Type.Literal(5)]),
    atlasSize: Type.Union([
      Type.Literal(1024),
      Type.Literal(2048),
      Type.Literal(4096),
      Type.Literal(8192),
    ]),
    fileStem: Type.String({ minLength: 1, description: 'base name of the exported files' }),
    includeGuideImages: Type.Boolean({
      description: 'export guide-image parts too (default false: they are left out)',
    }),
  }),
});
export type Project = Static<typeof Project>;

export const OBJECT_SCHEMAS = {
  project: Project,
  parameter: Parameter,
  parameterGroup: ParameterGroup,
  part: Part,
  artMesh: ArtMesh,
  warp: Warp,
  rotation: Rotation,
  layer: Layer,
  glue: Glue,
  expression: Expression,
  motion: Motion,
  physicsSetting: PhysicsSetting,
  motionSyncSetting: MotionSyncSetting,
  sound: Sound,
} as const satisfies Record<Kind, TSchema>;

export interface ObjectByKind {
  project: Project;
  parameter: Parameter;
  parameterGroup: ParameterGroup;
  part: Part;
  artMesh: ArtMesh;
  warp: Warp;
  rotation: Rotation;
  layer: Layer;
  glue: Glue;
  expression: Expression;
  motion: Motion;
  physicsSetting: PhysicsSetting;
  motionSyncSetting: MotionSyncSetting;
  sound: Sound;
}

export type DocObject = ObjectByKind[Kind];
export type Deformer = Warp | Rotation;
export type Riggable = Part | ArtMesh | Warp | Rotation | Glue;
/** Objects that can be blend-shape targets. */
export type ShapeTarget = Part | ArtMesh | Warp | Rotation | Glue;

/** Kinds whose export IDs share one namespace in the runtime files. */
export function exportNamespace(kind: Kind): string | null {
  switch (kind) {
    case 'parameter':
    case 'parameterGroup':
    case 'part':
    case 'artMesh':
    case 'glue':
      return kind;
    case 'warp':
    case 'rotation':
      return 'deformer';
    default:
      return null;
  }
}
