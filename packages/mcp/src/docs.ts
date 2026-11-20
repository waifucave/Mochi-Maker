/** Documentation resources, `mochi://docs/{topic}` (agent API design 3.2). */
import { describeCommand, errorCodes } from '@mochi-maker/core';

const TOPICS: Record<string, { title: string; text: () => string }> = {
  'getting-started': {
    title: 'Getting started',
    text: () => `# Getting started with Mochi Maker over MCP

1. Open or create a project: mochi_project { action: "open", path } or { action: "new", path, canvas }.
2. Learn the commands: mochi_describe {} lists them; { command: "rig.addBinding" } gives the
   schema, docs, examples and errors; { search: "blend shape" } searches.
3. Read the document: mochi_query { kind: "artMesh", fields: ["uid", "exportId", "name"] }.
4. Change it: mochi_run { label, commands: [{ name, args }] }. A transaction is atomic. Use
   dryRun: true to see the changes and lint results without committing, and expectRevision to fail
   if someone else changed the document meanwhile. Later commands can use earlier results as
   "$n" or "$n.field".
5. Check it: mochi_validate, mochi_evaluate (numbers at a pose, through Mochi2D), mochi_diff.
6. Undo with mochi_undo. Save with mochi_project { action: "save" }. Export with mochi_export.

References in arguments: a UID (mesh_0012), @kind:ExportId (@mesh:ArtMesh_Face) or
@kind~"Display name". Kinds: param, pgroup, part, mesh, warp, rot, deformer, layer, glue, expr,
motion, phys.

Parameters: use the standard IDs and ranges (mochi://standard/parameters) so that apps, motions and
face tracking recognize the model; put ParamEyeLOpen and ParamEyeROpen in the Eye blink group and
ParamMouthOpenY in Lip sync (meta.setStandardGroups). Parameter groups: mochi://standard/parameter-groups.

Look at the model with mochi_render, mochi_sweep and mochi_diff { visual: true }.`,
  },
  spaces: {
    title: 'Coordinate spaces',
    text: () => `# Coordinate spaces

- Without a deformer, positions are canvas pixels, x right and y down.
- Inside a warp, positions are (u, v) in 0–1 over the warp's grid.
- Inside a rotation, positions are canvas pixels relative to the rotation's origin.
- A blend shape's position and grid deltas are offsets in the same space as the target's points.
- mochi_evaluate reports bounds and vertices in canvas pixels, y down, at the given pose.`,
  },
  'blend-shapes': {
    title: 'Blend shapes',
    text: () => `# Blend shapes

A blend shape adds w·s to a target's normal result. s interpolates the blend shape's deltas over a
blend-shape parameter (param.create with type "blendShape"); w is the minimum of its constraint
curves, or 1. The base key's delta is always zero.

1. param.create { exportId: "ParamSmile", min: 0, max: 1, default: 0, keys: [0, 1], type: "blendShape" }
2. blendShape.add { target, parameter }
3. blendShape.set { target, parameter, key: 1, values: { positions: [[dx, dy], ...] } }
4. Optional: blendShape.setConstraints { target, parameter, constraints: [{ parameter, points }] }

Version 4 files carry only position and grid deltas on meshes and warps. Rotations, parts,
opacity, draw order and colors need version 5.`,
  },
  'export-versions': {
    title: 'Export versions',
    text: () => `# Export versions

- Version 5 is the default. Version 4 adds colors and position-only blend shapes over version 3.
- mochi_export { mocVersion: "auto" } picks the lowest version that carries the model, never below
  the project's minimum (project.setExportSettings minimumVersion).
- A version that cannot carry the model is refused; each problem names the object, what needs the
  higher version, and a fix.`,
  },
  errors: {
    title: 'Error codes',
    text: () =>
      `# Error codes

Every error has a stable \`code\`, a \`category\` from the bridge protocol's set
(invalid_arguments, unknown_command, forbidden, no_project, rate_limited, failed), a message that
says what to do, and often \`fixes\`: a command to run first ({ command, args }) or a replacement
value ({ replace: { path, value } }).

${errorCodes()
  .map((e) => `- **${e.code}**: ${e.meaning}`)
  .join('\n')}`,
  },
};

export function docTopics(): { name: string; title: string }[] {
  return Object.entries(TOPICS).map(([name, t]) => ({ name, title: t.title }));
}

export function docText(topic: string): string | undefined {
  if (topic.startsWith('commands/')) {
    try {
      const d = describeCommand(topic.slice('commands/'.length));
      return JSON.stringify(d, null, 2);
    } catch {
      return undefined;
    }
  }
  return TOPICS[topic]?.text();
}
