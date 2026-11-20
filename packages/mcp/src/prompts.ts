/** MCP prompts: tested workflows as step lists over the tools (agent API design 3.3). */
export interface PromptDef {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  text: (args: Record<string, string>) => string;
}

export const PROMPTS: PromptDef[] = [
  {
    name: 'rig_blink',
    description:
      'Rig an eye to close with an eye-open parameter, and register it for eye blinking.',
    arguments: [
      { name: 'eye', description: 'The eye mesh, e.g. @mesh:ArtMesh_EyeL', required: true },
      {
        name: 'parameter',
        description: 'Parameter export ID (default ParamEyeLOpen)',
        required: false,
      },
    ],
    text: (a) => {
      const p = a.parameter || 'ParamEyeLOpen';
      return `Rig ${a.eye} to blink with ${p}. Use the tools step by step:
1. mochi_query { kind: "parameter", where: { exportId: "${p}" } }. If it is missing, create it in
   step 3 with param.create { exportId: "${p}", min: 0, max: 1, default: 1, keys: [0, 1] }.
2. mochi_query the eye mesh with fields ["uid", "uv", "rig"] to see its vertices.
3. mochi_run one transaction: rig.addBinding { target: "${a.eye}", parameter: "@param:${p}", keys: [0, 1] },
   then mesh.moveVertices with cell { "@param:${p}": 0 } to bring the upper lid down onto the lower
   one (offsets in the mesh's own space; see mochi://docs/spaces).
4. meta.setStandardGroups { eyeBlink: ["@param:${p}"] } so apps blink it.
5. mochi_evaluate at { "${p}": 0 } and { "${p}": 1 }: the eye's bounds should be flat at 0.
6. mochi_validate, then mochi_project { action: "save" }.`;
    },
  },
  {
    name: 'head_angle_x',
    description: 'Set up a head-turn parameter with a warp over the face.',
    arguments: [
      { name: 'part', description: 'The head part, e.g. @part:PartHead', required: true },
    ],
    text: (a) => `Set up ParamAngleX (−30…30) for ${a.part}:
1. mochi_query { kind: "artMesh", where: { part: "${a.part}" } } to list the face meshes and their
   bounds (mochi_evaluate gives bounds in canvas pixels).
2. mochi_run: param.create { exportId: "ParamAngleX", min: -30, max: 30, default: 0, keys: [-30, 0, 30] };
   deformer.createWarp over the face's bounds (rect in canvas pixels, rows and cols 3–5, part
   "${a.part}"); mesh.reparent for each face mesh into the warp (it converts the positions, so the meshes stay
   in place).
3. rig.addBinding { target: the warp, parameter: "@param:ParamAngleX" }, then keyform.set the grid at
   −30 and 30: shift the far side's columns less than the near side's to suggest the turn.
4. mochi_evaluate at −30, 0 and 30 and compare bounds; mochi_diff to review the change.
5. mochi_validate, then save.`,
  },
  {
    name: 'review_rig',
    description: 'Review the rig for problems and suggest fixes.',
    arguments: [],
    text: () => `Review the open project's rig:
1. mochi_validate { targetVersion: "auto" }: list every error and warning with its fixes.
2. mochi_query { kind: "parameter", fields: ["exportId", "min", "max", "default", "keys"] }: look
   for parameters without keys at their default, and unused parameters.
3. mochi_evaluate at the default pose and at each parameter's ends: look for drawables that vanish
   (visible false) or jump (bounds change a lot).
4. Report findings grouped by object, each with the command that would fix it. Change nothing
   without asking.`,
  },
  {
    name: 'make_motion',
    description: 'Author a motion: curves for parameters, part opacities and the model opacity.',
    arguments: [
      { name: 'name', description: 'Motion name (also its file name)', required: true },
      {
        name: 'group',
        description: 'Motion group, e.g. Idle or TapBody (default Idle)',
        required: false,
      },
    ],
    text: (a) => `Author the motion "${a.name}" in group ${a.group || 'Idle'}:
1. mochi_run: motion.create { name: "${a.name}", group: "${a.group || 'Idle'}", duration, fps: 30, fadeIn, fadeOut }.
2. For each parameter to animate, motion.setCurve { target: '@motion~"${a.name}"', curve: { target:
   "parameter", object: "@param:…", segments } }. Segments start with the first point (t, v), then
   codes: 0 linear (t, v), 1 Bézier (t1, v1, t2, v2, t, v), 2 stepped (t, v), 3 inverse stepped
   (t, v). Times are seconds from the motion's start.
3. To switch a pose, use part-opacity curves (target "partOpacity", object "@part:…"): the pose
   shows the first entry of each group whose value is above 0.001.
4. Optional: a model curve { target: "model", model: "Opacity" }, per-curve fadeIn/fadeOut, and
   motion.setEvents for timed events.
5. mochi_validate, then mochi_export and check the files; the motion order (motion.reorder) decides
   group indexes and idle playback.`,
  },
  {
    name: 'export_model',
    description: 'Export the model for apps, choosing the file version.',
    arguments: [
      {
        name: 'out',
        description: 'Output folder or .zip, inside an allowed directory',
        required: true,
      },
    ],
    text: (a) => `Export the model to ${a.out}:
1. mochi_validate { targetVersion: "auto" } and fix any errors.
2. mochi_export { out: "${a.out}", mocVersion: "auto" }. If the person needs an older version,
   pass it; a refusal lists what needs a higher version, with fixes (mochi://docs/export-versions).
3. Report the version, its reason, the files and any warnings from the export report.`,
  },
];
