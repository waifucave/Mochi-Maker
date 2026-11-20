# Getting started, by an agent

The same model as [the guide](README.md), built by an agent through Mochi Maker's MCP server: the
same parameters, deformers, keys, groups and physics, then the export. Every call below runs in
`packages/mcp/test/guide.test.ts`.

## Connect the agent

Start the server for a folder the agent may use (it reads and writes files only there):

```sh
npm ci && npm run build
npx mochi-maker mcp --allow-dir ~/mochi-work
```

Add that command to your MCP client as a stdio server. Paths in the calls are absolute (below,
`/home/you/mochi-work`). To work on the document open in the editor
instead, so that you can watch, pair the editor under **Agent access** and use `mochi-maker mcp
--bridge --token …` ([bridge.md](../bridge.md)). Copy [`mochi.psd`](mochi.psd) into the folder.

## The calls

Each `mochi_run` is one transaction: one step in the history, undone as a whole. Arguments name
objects by export ID (`@mesh:ArtMesh_Face`, `@param:ParamAngleZ`, `@rot:Rotation_Head`).

**1. A project and the art.**

```json
mochi_project    { "action": "new", "path": "/home/you/mochi-work/Mochi.mochi" }
mochi_import_art { "path": "/home/you/mochi-work/mochi.psd" }
mochi_query      { "kind": "artMesh", "fields": ["exportId"] }
```

The import makes `ArtMesh_Hair_back`, `ArtMesh_Body`, `ArtMesh_Face`, `ArtMesh_Eye_R`,
`ArtMesh_Eye_L`, `ArtMesh_Mouth` and `ArtMesh_Hair_front`, each with an automatic mesh.

**2. Parameters and the standard groups,** in one `mochi_run`:

```json
{ "label": "Parameters", "commands": [
  { "name": "param.create", "args": { "exportId": "ParamAngleZ", "min": -30, "max": 30, "default": 0 } },
  { "name": "param.create", "args": { "exportId": "ParamEyeLOpen", "min": 0, "max": 1, "default": 1 } },
  { "name": "param.create", "args": { "exportId": "ParamEyeROpen", "min": 0, "max": 1, "default": 1 } },
  { "name": "param.create", "args": { "exportId": "ParamMouthOpenY", "min": 0, "max": 1, "default": 0 } },
  { "name": "param.create", "args": { "exportId": "ParamHairFront", "min": -1, "max": 1, "default": 0 } },
  { "name": "meta.setStandardGroups", "args": {
      "eyeBlink": ["@param:ParamEyeLOpen", "@param:ParamEyeROpen"],
      "lipSync": ["@param:ParamMouthOpenY"] } }
] }
```

**3. The head and the hair,** in one `mochi_run`. These commands:

- create a rotation deformer at the neck;
- move the head's six meshes into it, in place (`mesh.reparent`);
- key it at −30, 0 and 30 on ParamAngleZ, with ±10°;
- add a rotation for the front hair inside it, with ±8° on ParamHairFront.

The hair's origin is in pixels around the head's origin, because it sits inside a rotation.

```json
{ "name": "deformer.createRotation", "args": { "exportId": "Rotation_Head", "origin": { "x": 300, "y": 450 } } },
{ "name": "mesh.reparent", "args": { "target": "@mesh:ArtMesh_Face", "deformer": "@rot:Rotation_Head" } },
… the same for Eye_R, Eye_L, Mouth, Hair_front and Hair_back …
{ "name": "rig.addBinding", "args": { "target": "@rot:Rotation_Head", "parameter": "@param:ParamAngleZ", "keys": [-30, 0, 30] } },
{ "name": "keyform.set", "args": { "target": "@rot:Rotation_Head", "cell": { "@param:ParamAngleZ": -30 }, "values": { "angle": -10 } } },
{ "name": "keyform.set", "args": { "target": "@rot:Rotation_Head", "cell": { "@param:ParamAngleZ": 30 }, "values": { "angle": 10 } } },
{ "name": "deformer.createRotation", "args": { "exportId": "Rotation_HairFront", "parent": "@rot:Rotation_Head", "origin": { "x": 0, "y": -300 } } },
{ "name": "mesh.reparent", "args": { "target": "@mesh:ArtMesh_Hair_front", "deformer": "@rot:Rotation_HairFront" } },
{ "name": "rig.addBinding", "args": { "target": "@rot:Rotation_HairFront", "parameter": "@param:ParamHairFront", "keys": [-1, 0, 1] } },
{ "name": "keyform.set", "args": { "target": "@rot:Rotation_HairFront", "cell": { "@param:ParamHairFront": -1 }, "values": { "angle": -8 } } },
{ "name": "keyform.set", "args": { "target": "@rot:Rotation_HairFront", "cell": { "@param:ParamHairFront": 1 }, "values": { "angle": 8 } } }
```

**4. The eyes and the mouth.**

1. Read a mesh's points with `mochi_query { "ref": "@mesh:ArtMesh_Eye_L" }`. They are the
   `positions` of `rig.keyforms[0]`, `[x, y]` with y downward.
2. Pick the vertices above the middle.
3. In one `mochi_run`, bind the eye and lower those points when shut:

```json
{ "name": "rig.addBinding", "args": { "target": "@mesh:ArtMesh_Eye_L", "parameter": "@param:ParamEyeLOpen", "keys": [0, 1] } },
{ "name": "mesh.moveVertices", "args": { "target": "@mesh:ArtMesh_Eye_L", "cell": { "@param:ParamEyeLOpen": 0 },
  "vertices": [ …the upper ones… ], "offset": [0, 27] } }
```

Do the same for `ArtMesh_Eye_R` with ParamEyeROpen. For the mouth, use the lower vertices, the
cell `{ "@param:ParamMouthOpenY": 1 }`, and a downward offset. The `rig_blink` prompt lists these
steps for any eye.

**5. Physics,** in one `mochi_run`: the head's tilt swings the hair.

```json
{ "name": "physics.addSetting", "args": {
  "name": "Hair",
  "inputs": [{ "parameter": "@param:ParamAngleZ", "weight": 100, "type": "Angle" }],
  "outputs": [{ "parameter": "@param:ParamHairFront", "weight": 100, "type": "Angle", "particle": 1, "scale": 1 }],
  "particles": [
    { "x": 0, "y": 0, "mobility": 1, "delay": 1, "acceleration": 1, "radius": 0 },
    { "x": 0, "y": 10, "mobility": 0.95, "delay": 0.9, "acceleration": 1.5, "radius": 10 }
  ],
  "normalization": { "position": { "min": -10, "default": 0, "max": 10 }, "angle": { "min": -10, "default": 0, "max": 10 } }
} }
```

**6. Check, look, save, export.**

```json
mochi_validate { "targetVersion": "auto" }
mochi_evaluate { "parameters": { "ParamEyeLOpen": 0 }, "ids": ["ArtMesh_Eye_L"] }
mochi_render   { "parameters": { "ParamAngleZ": 30, "ParamMouthOpenY": 1 } }
mochi_project  { "action": "save" }
mochi_export   { "out": "/home/you/mochi-work/export" }
```

- `mochi_validate` reports the export check, with fixes.
- `mochi_evaluate` gives the eye's bounds: flat when shut.
- `mochi_render` shows a pose as an image.

The export folder loads in Mochi2D. The test opens it with `ModelRuntime`, tilts the head and
checks that the hair swings.

## Where to go next

- `mochi_describe { "command": "…" }`: any command's arguments, errors and examples.
- The resources `mochi://docs/getting-started` and `mochi://docs/spaces`: how positions work inside
  deformers.
- [agent-api.md](../agent-api.md): every tool, resource and prompt.
