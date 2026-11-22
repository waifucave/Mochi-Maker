# Mochi Maker conformance pack

Written by mochi-maker 0.0.0, with results from Mochi2D 0.24.0; random poses from seed 1.

60 exports (60 of 72 project × version pairs), 1857 static and 36 animation scenarios.

## Layout

```
<project>/v<3|4|5|6>/model/      the exported model folder (.moc3, model3.json, textures, …)
<project>/v<3|4|5|6>/scenarios/  <id>.json: mochi2d-scenario/0 and mochi2d-anim-scenario/0
<project>/v<3|4|5|6>/results/    <id>.result.json: Mochi2D's results for them
<project>/v<3|4|5|6>/renders/    <id>.png and <id>.render.json: Mochi2D's renders of the render.* scenarios
manifest.json                    every entry, its scenarios, the coverage, every file's SHA-256
```

Each scenario's `model` is its settings file relative to this folder: use this folder as the
models root. Scenario IDs are unique across the pack, so results pair by ID.

## Scenarios

- Static (`mochi2d-scenario/0`): `default`; `key.<P>.<i>` each key of each parameter;
  `mid.<P>.<i>` midpoints between neighbouring keys; `low.<P>` and `high.<P>` half a range
  below and above; `cell.<O>.<n>` every cell of an object bound to two or more parameters and
  `centre.<O>.<n>` each cell's centre; `parts.half` all part opacities 0.5; `random.<seed>.<i>`
  every parameter (a quarter range beyond each end) and part opacity at random.
- Animation (`mochi2d-anim-scenario/0`, 30 frames a second, no random numbers; eye blink,
  breath, look and idle off; physics and pose on where the model has them):
  `motion.<group>.<i>` each motion; `expression.<name>` each expression; `physics.wind` wind
  (0.5, 0) and gravity (0.2, −1); `pose.switch` part opacities switching the first pose group.

## Comparing results

1. Reference results can come from any set in the same result formats (`mochi2d-result/0`,
   `mochi2d-anim-result/0`): one `<id>.result.json` per scenario under `*/v*/scenarios/`, with
   this folder as the models root, in one folder, for example `reference/`.
2. Mochi2D's judge (in the Mochi2D repository) pairs them with this pack's results by ID and
   applies the tolerances of §4l:

   ```
   npm run judge -- reference/ <this folder>
   ```

   It reads every `*.result.json` below both folders and exits 0 when every scenario passes.

## Renders

Each export has render scenarios: `render.default`, the default pose, and 3 at random poses, `render.random.<seed>.<i>`, at the same parameter values and part opacities as the static `random.<seed>.<i>`. Each has a `render` block of 512 × 512, the canvas fitted in. `<project>/v<N>/renders/` holds Mochi2D's reference render of each (Mochi2D's `NodeRenderer`: headless Chromium, SwiftShader): `<id>.png` with premultiplied alpha, and `<id>.render.json`. 240 renders in all.

The `.render.json` files have the shape of Mochi2D's render tool (`mochi2d-render/0`): `format`, `scenario`, `producer`, `error`, `png`, `alpha`, `width`, `height`, `renderer`, `pixelsPerUnit`, `center`, `masks` and `notes`. They leave out `stats`, which is informational, and `milliseconds`.

## Exports not made

- golden-3-drawing v3: Version 3 cannot carry this model: mesh_0012 (Tinted) uses multiply or screen colors in 1 of 1 keyform(s) (version 4).
- golden-4-masks-colors v3: Version 3 cannot carry this model: mesh_0020 (Chain) uses multiply or screen colors in 1 of 1 keyform(s) (version 4).
- golden-7-blend-positions v3: Version 3 cannot carry this model: mesh_0007 (Mouth) uses blend shapes on positions: ParamSmile (version 4).
- golden-8-blend-values v3: Version 3 cannot carry this model: mesh_0008 (Face) uses blend shapes on opacity, draw order or colors: ParamBS changes opacity, draw order, multiply color, screen color (version 5).
- golden-8-blend-values v4: Version 4 cannot carry this model: mesh_0008 (Face) uses blend shapes on opacity, draw order or colors: ParamBS changes opacity, draw order, multiply color, screen color (version 5).
- golden-9-draw-order-edges v3: Version 3 cannot carry this model: mesh_0005 (Up) uses blend shapes on opacity, draw order or colors: ParamEdge changes draw order (version 5).
- golden-9-draw-order-edges v4: Version 4 cannot carry this model: mesh_0005 (Up) uses blend shapes on opacity, draw order or colors: ParamEdge changes draw order (version 5).
- golden-10-glue-blend-shapes v3: Version 3 cannot carry this model: glue_0005 (Glue_Up) uses blend shapes on a glue: ParamGlueBS (version 5).
- golden-10-glue-blend-shapes v4: Version 4 cannot carry this model: glue_0005 (Glue_Up) uses blend shapes on a glue: ParamGlueBS (version 5).
- golden-v6-offscreens v3: Version 3 cannot carry this model: part_0011 (Part_Glass) uses offscreen drawing (version 6).
- golden-v6-offscreens v4: Version 4 cannot carry this model: part_0011 (Part_Glass) uses offscreen drawing (version 6).
- golden-v6-offscreens v5: Version 5 cannot carry this model: part_0011 (Part_Glass) uses offscreen drawing (version 6).

## Coverage of the writer's paths

| Path | Exports |
|---|---|
| moc: parts | golden-1-keyforms v3, golden-1-keyforms v4, golden-1-keyforms v5, golden-1-keyforms v6, golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-6-metadata v3, golden-6-metadata v4, golden-6-metadata v5, golden-6-metadata v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-11-animation v3, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6, golden-12-motions v3, golden-12-motions v4, golden-12-motions v5, golden-12-motions v6, golden-14-reimport v3, golden-14-reimport v4, golden-14-reimport v5, golden-14-reimport v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-v6-offscreens v6 |
| moc: part tree (nested parts) | golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6 |
| moc: art meshes | golden-1-keyforms v3, golden-1-keyforms v4, golden-1-keyforms v5, golden-1-keyforms v6, golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-5-glue v3, golden-5-glue v4, golden-5-glue v5, golden-5-glue v6, golden-6-metadata v3, golden-6-metadata v4, golden-6-metadata v5, golden-6-metadata v6, golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6, golden-11-animation v3, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6, golden-12-motions v3, golden-12-motions v4, golden-12-motions v5, golden-12-motions v6, golden-13-sound v3, golden-13-sound v4, golden-13-sound v5, golden-13-sound v6, golden-14-reimport v3, golden-14-reimport v4, golden-14-reimport v5, golden-14-reimport v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-17-motion-sync v3, golden-17-motion-sync v4, golden-17-motion-sync v5, golden-17-motion-sync v6, golden-v6-offscreens v6 |
| moc: masks | golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-v6-offscreens v6 |
| moc: additive blending | golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-v6-offscreens v6 |
| moc: multiplicative blending | golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6 |
| moc: single-sided meshes | golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6 |
| moc: inverted masks | golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6 |
| moc: warp deformers | golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6 |
| moc: rotation deformers | golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6 |
| moc: nested deformers | golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6 |
| moc: rotation mirror flags | golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6 |
| moc: glues | golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-5-glue v3, golden-5-glue v4, golden-5-glue v5, golden-5-glue v6, golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6 |
| moc: keyform bindings | golden-1-keyforms v3, golden-1-keyforms v4, golden-1-keyforms v5, golden-1-keyforms v6, golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-5-glue v3, golden-5-glue v4, golden-5-glue v5, golden-5-glue v6, golden-6-metadata v3, golden-6-metadata v4, golden-6-metadata v5, golden-6-metadata v6, golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-13-sound v3, golden-13-sound v4, golden-13-sound v5, golden-13-sound v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-17-motion-sync v3, golden-17-motion-sync v4, golden-17-motion-sync v5, golden-17-motion-sync v6, golden-v6-offscreens v6 |
| moc: objects bound to two or more parameters | golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-17-motion-sync v3, golden-17-motion-sync v4, golden-17-motion-sync v5, golden-17-motion-sync v6 |
| moc: repeating parameters | golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6 |
| moc: nested draw-order groups | golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-v6-offscreens v6 |
| moc v4: multiply and screen colors | golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-v6-offscreens v6 |
| moc v4: parameter key lists | golden-1-keyforms v4, golden-1-keyforms v5, golden-1-keyforms v6, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-5-glue v4, golden-5-glue v5, golden-5-glue v6, golden-6-metadata v4, golden-6-metadata v5, golden-6-metadata v6, golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6, golden-12-motions v4, golden-12-motions v5, golden-12-motions v6, golden-13-sound v4, golden-13-sound v5, golden-13-sound v6, golden-14-reimport v4, golden-14-reimport v5, golden-14-reimport v6, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-17-motion-sync v4, golden-17-motion-sync v5, golden-17-motion-sync v6, golden-v6-offscreens v6 |
| moc v4: blend-shape parameters | golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6, golden-v6-offscreens v6 |
| moc v4: art mesh blend shapes | golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6 |
| moc v4: warp blend shapes | golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6 |
| moc v4: blend-shape constraints | golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6 |
| moc v5: keyform color indices | golden-1-keyforms v5, golden-1-keyforms v6, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-5-glue v5, golden-5-glue v6, golden-6-metadata v5, golden-6-metadata v6, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6, golden-11-animation v5, golden-11-animation v6, golden-12-motions v5, golden-12-motions v6, golden-13-sound v5, golden-13-sound v6, golden-14-reimport v5, golden-14-reimport v6, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-17-motion-sync v5, golden-17-motion-sync v6, golden-v6-offscreens v6 |
| moc v5: part blend shapes | golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-v6-offscreens v6 |
| moc v5: rotation blend shapes | golden-8-blend-values v5, golden-8-blend-values v6 |
| moc v5: glue blend shapes | golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6 |
| moc v6: offscreens | golden-v6-offscreens v6 |
| moc v6: offscreen masks | golden-v6-offscreens v6 |
| moc v6: offscreen blend shapes | golden-v6-offscreens v6 |
| moc v6: art-mesh blend modes | golden-v6-offscreens v6 |
| moc v6: offscreen blend modes | golden-v6-offscreens v6 |
| file: model settings | golden-1-keyforms v3, golden-1-keyforms v4, golden-1-keyforms v5, golden-1-keyforms v6, golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-5-glue v3, golden-5-glue v4, golden-5-glue v5, golden-5-glue v6, golden-6-metadata v3, golden-6-metadata v4, golden-6-metadata v5, golden-6-metadata v6, golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6, golden-11-animation v3, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6, golden-12-motions v3, golden-12-motions v4, golden-12-motions v5, golden-12-motions v6, golden-13-sound v3, golden-13-sound v4, golden-13-sound v5, golden-13-sound v6, golden-14-reimport v3, golden-14-reimport v4, golden-14-reimport v5, golden-14-reimport v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-17-motion-sync v3, golden-17-motion-sync v4, golden-17-motion-sync v5, golden-17-motion-sync v6, golden-v6-offscreens v6 |
| file: display info | golden-1-keyforms v3, golden-1-keyforms v4, golden-1-keyforms v5, golden-1-keyforms v6, golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-5-glue v3, golden-5-glue v4, golden-5-glue v5, golden-5-glue v6, golden-6-metadata v3, golden-6-metadata v4, golden-6-metadata v5, golden-6-metadata v6, golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6, golden-11-animation v3, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6, golden-12-motions v3, golden-12-motions v4, golden-12-motions v5, golden-12-motions v6, golden-13-sound v3, golden-13-sound v4, golden-13-sound v5, golden-13-sound v6, golden-14-reimport v3, golden-14-reimport v4, golden-14-reimport v5, golden-14-reimport v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-17-motion-sync v3, golden-17-motion-sync v4, golden-17-motion-sync v5, golden-17-motion-sync v6, golden-v6-offscreens v6 |
| file: textures | golden-1-keyforms v3, golden-1-keyforms v4, golden-1-keyforms v5, golden-1-keyforms v6, golden-2-deformers v3, golden-2-deformers v4, golden-2-deformers v5, golden-2-deformers v6, golden-3-drawing v4, golden-3-drawing v5, golden-3-drawing v6, golden-4-masks-colors v4, golden-4-masks-colors v5, golden-4-masks-colors v6, golden-5-glue v3, golden-5-glue v4, golden-5-glue v5, golden-5-glue v6, golden-6-metadata v3, golden-6-metadata v4, golden-6-metadata v5, golden-6-metadata v6, golden-7-blend-positions v4, golden-7-blend-positions v5, golden-7-blend-positions v6, golden-8-blend-values v5, golden-8-blend-values v6, golden-9-draw-order-edges v5, golden-9-draw-order-edges v6, golden-10-glue-blend-shapes v5, golden-10-glue-blend-shapes v6, golden-11-animation v3, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6, golden-12-motions v3, golden-12-motions v4, golden-12-motions v5, golden-12-motions v6, golden-13-sound v3, golden-13-sound v4, golden-13-sound v5, golden-13-sound v6, golden-14-reimport v3, golden-14-reimport v4, golden-14-reimport v5, golden-14-reimport v6, golden-15-nested-deformers v3, golden-15-nested-deformers v4, golden-15-nested-deformers v5, golden-15-nested-deformers v6, golden-16-writer-edges v3, golden-16-writer-edges v4, golden-16-writer-edges v5, golden-16-writer-edges v6, golden-17-motion-sync v3, golden-17-motion-sync v4, golden-17-motion-sync v5, golden-17-motion-sync v6, golden-v6-offscreens v6 |
| file: user data | golden-6-metadata v3, golden-6-metadata v4, golden-6-metadata v5, golden-6-metadata v6 |
| file: physics | golden-11-animation v3, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6 |
| file: motion sync | golden-17-motion-sync v3, golden-17-motion-sync v4, golden-17-motion-sync v5, golden-17-motion-sync v6 |
| file: pose | golden-11-animation v3, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6, golden-12-motions v3, golden-12-motions v4, golden-12-motions v5, golden-12-motions v6 |
| file: expressions | golden-11-animation v3, golden-11-animation v4, golden-11-animation v5, golden-11-animation v6 |
| file: motions | golden-12-motions v3, golden-12-motions v4, golden-12-motions v5, golden-12-motions v6, golden-13-sound v3, golden-13-sound v4, golden-13-sound v5, golden-13-sound v6 |
| file: sounds | golden-13-sound v3, golden-13-sound v4, golden-13-sound v5, golden-13-sound v6 |
