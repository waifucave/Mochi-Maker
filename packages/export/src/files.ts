/**
 * The JSON files of an exported model (design 4.3, step 4): settings, display info, expressions,
 * motions, physics, pose and user data. Objects are named by their export IDs. Counts are computed
 * from the content. Text is deterministic: two-space indentation, keys in a fixed order, UTF-8
 * without a byte-order mark, LF line endings.
 */
import type {
  DocReader,
  Expression,
  Motion,
  MotionSyncSetting,
  PhysicsSetting,
  Uid,
} from '@mochi-maker/core';
import { writeMotionSync } from 'mochi2d/headless';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function jsonText(value: Json): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** A file name from a free-form name: path separators and reserved characters replaced. */
export function safeFileName(name: string): string {
  const s = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim();
  return s === '' || s === '.' || s === '..' ? '_' : s;
}

function exportIdOf(doc: DocReader, uid: Uid): string {
  const o = doc.get(uid);
  return o && 'exportId' in o ? o.exportId : uid;
}

export interface ModelFiles {
  stem: string;
  moc: string;
  textures: string[];
  physics: string | null;
  /** The .motionsync3.json, when the project has motion-sync settings. */
  motionSync: string | null;
  pose: string | null;
  userData: string | null;
  displayInfo: string;
  expressions: { name: string; file: string; uid: Uid }[];
  /**
   * `motionSync`: the name of the motion-sync setting that the sound drives; null
   * without a sound or a setting.
   */
  motions: {
    group: string;
    file: string;
    uid: Uid;
    sound: string | null;
    motionSync: string | null;
  }[];
  /** WAV files of the sounds that motions start, by sound UID. */
  sounds: { uid: Uid; file: string }[];
}

/** Decides every file name of the export. Expression and motion names that collide get suffixes. */
export function planFiles(
  doc: DocReader,
  stem: string,
  pageCount: number,
  pageSizeLabel: number,
): ModelFiles {
  const project = doc.project();
  const unique = (dir: string, names: string[], ext: string) => {
    const used = new Set<string>();
    return names.map((n) => {
      let base = safeFileName(n);
      let k = 2;
      while (used.has(base.toLowerCase())) base = `${safeFileName(n)}_${k++}`;
      used.add(base.toLowerCase());
      return `${dir}/${base}${ext}`;
    });
  };
  const expressions = project.expressionOrder.map((u) => doc.get(u) as Expression);
  const motions = project.motionOrder.map((u) => doc.get(u) as Motion);
  const expFiles = unique(
    'expressions',
    expressions.map((e) => e.name),
    '.exp3.json',
  );
  const motionFiles = unique(
    'motions',
    motions.map((m) => m.name),
    '.motion3.json',
  );
  const hasPose = project.pose.groups.length > 0;
  // Sounds that some motion starts, in the project's sound order.
  const used = new Set(motions.map((m) => m.sound).filter((u): u is Uid => u !== null));
  const sounds = project.soundOrder.filter((u) => used.has(u));
  const soundFiles = unique(
    'sounds',
    sounds.map((u) => (doc.get(u) as { name: string }).name),
    '.wav',
  );
  const soundFile = new Map(sounds.map((u, i) => [u, soundFiles[i]!]));
  return {
    stem,
    moc: `${stem}.moc3`,
    textures: Array.from(
      { length: pageCount },
      (_, i) => `${stem}.${pageSizeLabel}/texture_${String(i).padStart(2, '0')}.png`,
    ),
    physics: project.physicsOrder.length > 0 ? `${stem}.physics3.json` : null,
    motionSync: project.motionSyncOrder.length > 0 ? `${stem}.motionsync3.json` : null,
    pose: hasPose ? `${stem}.pose3.json` : null,
    userData: project.userData.length > 0 ? `${stem}.userdata3.json` : null,
    displayInfo: `${stem}.cdi3.json`,
    expressions: expressions.map((e, i) => ({ name: e.name, file: expFiles[i]!, uid: e.uid })),
    motions: motions.map((m, i) => ({
      group: m.group,
      file: motionFiles[i]!,
      uid: m.uid,
      sound: m.sound ? soundFile.get(m.sound)! : null,
      motionSync:
        m.sound && m.motionSync ? doc.getAs(m.motionSync, 'motionSyncSetting').name : null,
    })),
    sounds: sounds.map((u) => ({ uid: u, file: soundFile.get(u)! })),
  };
}

export function modelSettings(doc: DocReader, files: ModelFiles): Json {
  const project = doc.project();
  const refs: { [key: string]: Json } = { Moc: files.moc, Textures: files.textures };
  if (files.physics) refs.Physics = files.physics;
  if (files.motionSync) refs.MotionSync = files.motionSync;
  if (files.pose) refs.Pose = files.pose;
  if (files.userData) refs.UserData = files.userData;
  refs.DisplayInfo = files.displayInfo;
  if (files.expressions.length > 0)
    refs.Expressions = files.expressions.map((e) => ({ Name: e.name, File: e.file }));
  if (files.motions.length > 0) {
    const groups: { [key: string]: Json } = {};
    for (const m of files.motions) {
      const list = (groups[m.group] ??= []) as Json[];
      const entry: { [key: string]: Json } = { File: m.file };
      if (m.sound) entry.Sound = m.sound;
      if (m.motionSync) entry.MotionSync = m.motionSync;
      list.push(entry);
    }
    refs.Motions = groups;
  }
  const out: { [key: string]: Json } = {
    Version: 3,
    FileReferences: refs,
    Groups: [
      {
        Target: 'Parameter',
        Name: 'EyeBlink',
        Ids: project.standardGroups.eyeBlink.map((u) => exportIdOf(doc, u)),
      },
      {
        Target: 'Parameter',
        Name: 'LipSync',
        Ids: project.standardGroups.lipSync.map((u) => exportIdOf(doc, u)),
      },
    ],
  };
  if (project.hitAreas.length > 0)
    out.HitAreas = project.hitAreas.map((h) => ({ Id: exportIdOf(doc, h.mesh), Name: h.name }));
  return out;
}

export function displayInfo(doc: DocReader): Json {
  const project = doc.project();
  const params = project.parameterOrder.map((u) => doc.getAs(u, 'parameter'));
  const groups = project.parameterGroupOrder.map((u) => doc.getAs(u, 'parameterGroup'));
  const parts = doc.ofKind('part');
  const out: { [key: string]: Json } = {
    Version: 3,
    Parameters: params.map((p) => ({
      Id: p.exportId,
      GroupId: p.group ? exportIdOf(doc, p.group) : '',
      Name: p.name,
    })),
    ParameterGroups: groups.map((g) => ({
      Id: g.exportId,
      GroupId: g.parent ? exportIdOf(doc, g.parent) : '',
      Name: g.name,
    })),
    Parts: parts.map((p) => ({ Id: p.exportId, Name: p.name })),
  };
  if (project.combinedParameters.length > 0)
    out.CombinedParameters = project.combinedParameters.map(([a, b]) => [
      exportIdOf(doc, a),
      exportIdOf(doc, b),
    ]);
  return out;
}

export function expressionFile(doc: DocReader, e: Expression): Json {
  const out: { [key: string]: Json } = { Type: 'Live2D Expression' };
  if (e.fadeIn !== null) out.FadeInTime = e.fadeIn;
  if (e.fadeOut !== null) out.FadeOutTime = e.fadeOut;
  out.Parameters = e.entries.map((x) => ({
    Id: exportIdOf(doc, x.parameter),
    Value: x.value,
    Blend: x.blend,
  }));
  return out;
}

/** Number of points and segments of a curve in the flat segment encoding (§3c.3). */
export function curveCounts(segments: number[]): { segments: number; points: number } {
  let s = 0;
  let p = 1;
  for (let i = 2; i < segments.length;) {
    const code = segments[i]!;
    const n = code === 1 ? 3 : 1;
    s++;
    p += n;
    i += 1 + 2 * n;
  }
  return { segments: s, points: p };
}

export function motionFile(doc: DocReader, m: Motion): Json {
  const order = { model: 0, parameter: 1, partOpacity: 2 } as const;
  // Curves must come as model, then parameter, then part-opacity runs (§3c.2).
  const curves = m.curves
    .map((c, i) => ({ c, i }))
    .sort((a, b) => order[a.c.target] - order[b.c.target] || a.i - b.i)
    .map((x) => x.c);
  let segments = 0;
  let points = 0;
  const outCurves: Json[] = curves.map((c) => {
    const counts = curveCounts(c.segments);
    segments += counts.segments;
    points += counts.points;
    const curve: { [key: string]: Json } = {
      Target:
        c.target === 'model' ? 'Model' : c.target === 'parameter' ? 'Parameter' : 'PartOpacity',
      Id: c.target === 'model' ? c.model! : exportIdOf(doc, c.object!),
    };
    if (c.fadeIn !== null) curve.FadeInTime = c.fadeIn;
    if (c.fadeOut !== null) curve.FadeOutTime = c.fadeOut;
    curve.Segments = c.segments;
    return curve;
  });
  const userDataSize = m.events.reduce((s, e) => s + new TextEncoder().encode(e.value).length, 0);
  const meta: { [key: string]: Json } = {
    Duration: m.duration,
    Fps: m.fps,
    Loop: m.loop,
    AreBeziersRestricted: m.restrictedBeziers,
    CurveCount: curves.length,
    TotalSegmentCount: segments,
    TotalPointCount: points,
    UserDataCount: m.events.length,
    TotalUserDataSize: userDataSize,
  };
  if (m.fadeIn !== null) meta.FadeInTime = m.fadeIn;
  if (m.fadeOut !== null) meta.FadeOutTime = m.fadeOut;
  const out: { [key: string]: Json } = { Version: 3, Meta: meta, Curves: outCurves };
  if (m.events.length > 0) out.UserData = m.events.map((e) => ({ Time: e.time, Value: e.value }));
  return out;
}

/**
 * The motion-sync file's text, written by Mochi2D's `writeMotionSync`: each setting with
 * a positional ID (`MotionSync1`, …) and its dictionary name, its driven parameters by export ID
 * (with their name and range), its elements (range 0–1) and their shapes.
 */
export function motionSyncText(doc: DocReader): string {
  const settings = doc
    .project()
    .motionSyncOrder.map((u) => doc.get(u) as MotionSyncSetting)
    .map((s, i) => ({
      id: `MotionSync${i + 1}`,
      name: s.name,
      analysisType: s.analysisType,
      useCase: s.useCase,
      parameters: s.parameters.map((p) => {
        const x = doc.getAs(p.parameter, 'parameter');
        return {
          id: x.exportId,
          name: x.name,
          min: x.min,
          max: x.max,
          damper: p.damper,
          smooth: p.smooth,
        };
      }),
      elements: s.elements.map((e) => ({
        id: e.id,
        name: e.name,
        min: 0,
        max: 1,
        scale: e.scale,
        enabled: e.enabled,
      })),
      shapes: s.shapes.map((r) => [...r]),
      blendRatio: s.blendRatio,
      smoothing: s.smoothing,
      sampleRate: s.sampleRate,
    }));
  return writeMotionSync({ settings }) + '\n';
}

export function physicsFile(doc: DocReader): Json {
  const project = doc.project();
  const settings = project.physicsOrder.map((u) => doc.get(u) as PhysicsSetting);
  const id = (i: number) => `PhysicsSetting${i + 1}`;
  const io = (x: { parameter: Uid; weight: number; type: string; reflect: boolean }) => ({
    Target: 'Parameter',
    Id: exportIdOf(doc, x.parameter),
  });
  const meta: { [key: string]: Json } = {
    PhysicsSettingCount: settings.length,
    TotalInputCount: settings.reduce((s, x) => s + x.inputs.length, 0),
    TotalOutputCount: settings.reduce((s, x) => s + x.outputs.length, 0),
    VertexCount: settings.reduce((s, x) => s + x.particles.length, 0),
  };
  if (project.physicsFps > 0) meta.Fps = project.physicsFps;
  meta.EffectiveForces = { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } };
  meta.PhysicsDictionary = settings.map((s, i) => ({ Id: id(i), Name: s.name }));
  return {
    Version: 3,
    Meta: meta,
    PhysicsSettings: settings.map((s, i) => ({
      Id: id(i),
      Input: s.inputs.map((x) => ({
        Source: io(x),
        Weight: x.weight,
        Type: x.type,
        Reflect: x.reflect,
      })),
      Output: s.outputs.map((x) => ({
        Destination: io(x),
        VertexIndex: x.particle,
        Scale: x.scale,
        Weight: x.weight,
        Type: x.type,
        Reflect: x.reflect,
      })),
      Vertices: s.particles.map((p) => ({
        Position: { X: p.x, Y: p.y },
        Mobility: p.mobility,
        Delay: p.delay,
        Acceleration: p.acceleration,
        Radius: p.radius,
      })),
      Normalization: {
        Position: {
          Minimum: s.normalization.position.min,
          Default: s.normalization.position.default,
          Maximum: s.normalization.position.max,
        },
        Angle: {
          Minimum: s.normalization.angle.min,
          Default: s.normalization.angle.default,
          Maximum: s.normalization.angle.max,
        },
      },
    })),
  };
}

export function poseFile(doc: DocReader): Json {
  const pose = doc.project().pose;
  const out: { [key: string]: Json } = { Type: 'Live2D Pose' };
  if (pose.fadeIn !== null) out.FadeInTime = pose.fadeIn;
  out.Groups = pose.groups.map((g) =>
    g.map((e) => ({ Id: exportIdOf(doc, e.part), Link: e.links.map((l) => exportIdOf(doc, l)) })),
  );
  return out;
}

export function userDataFile(doc: DocReader): Json {
  const entries = doc.project().userData;
  const target = (u: Uid) => {
    const k = doc.get(u)?.kind;
    return k === 'artMesh' ? 'ArtMesh' : k === 'part' ? 'Part' : 'Parameter';
  };
  return {
    Version: 3,
    Meta: {
      UserDataCount: entries.length,
      TotalUserDataSize: entries.reduce((s, e) => s + new TextEncoder().encode(e.value).length, 0),
    },
    UserData: entries.map((e) => ({
      Target: target(e.target),
      Id: exportIdOf(doc, e.target),
      Value: e.value,
    })),
  };
}
