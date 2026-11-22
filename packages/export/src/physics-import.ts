/**
 * Physics files in: `physics.import` reads a `.physics3.json` written anywhere with
 * Mochi2D's `parsePhysics`, and turns its settings into the document's, as one transaction of
 * ordinary commands (`physics.addSetting`, `physics.updateSetting`, `physics.setFps`).
 *
 * - Inputs and outputs are matched to the document's parameters by export ID. One whose ID is not
 *   in the document is left out and reported.
 * - A setting is known by its name in the file's `PhysicsDictionary` (its `Id` when the dictionary
 *   has none): the setting IDs of a physics file are only positions (`PhysicsSetting1`, …), so the
 *   name is what stays the same between files. A setting whose name the document has replaces it,
 *   in its place; the others are added after the document's, in the file's order.
 * - The file's `Fps` becomes the physics rate (0 when the file has none).
 *
 * Our own exports keep their own writer (`physicsFile`): importing an exported file into a copy
 * without physics and exporting again gives the file back byte for byte (`physicsimport.test.ts`).
 */
import { Type } from '@sinclair/typebox';
import { defineOperation, LIMITS, MochiError, readCapped } from '@mochi-maker/core';
import { parsePhysics } from 'mochi2d/headless';

const Unmatched = Type.Object({
  setting: Type.String(),
  kind: Type.Union([Type.Literal('input'), Type.Literal('output')]),
  parameter: Type.String({ description: 'the export ID the file names' }),
});

export const physicsImport = defineOperation({
  name: 'physics.import',
  summary: 'Import a .physics3.json: add its settings, or replace those of the same name.',
  doc: `Reads the file (\`path\`, or its text as \`text\`) with Mochi2D's parser. Inputs and outputs
are matched to parameters by export ID; any the document lacks are left out and reported in
\`unmatched\`. Settings are known by their dictionary name: one the document has is replaced in
place, the others are added in the file's order. The file's Fps sets the physics rate. One
transaction; with dryRun, only the report.`,
  args: Type.Object({
    path: Type.Optional(Type.String({ description: 'a .physics3.json file' })),
    text: Type.Optional(Type.String({ description: 'the file’s text, instead of a path' })),
  }),
  result: Type.Object({
    added: Type.Array(Type.String()),
    replaced: Type.Array(Type.String()),
    unmatched: Type.Array(Unmatched),
    fps: Type.Number(),
  }),
  errors: ['E_ASSET_FORMAT', 'E_FORBIDDEN', 'E_SCHEMA'],
  examples: [
    {
      description: 'Physics made in another tool',
      args: { path: 'physics/hair.physics3.json' },
    },
  ],
  async run(ctx, tx, a) {
    let text = a.text;
    if (text === undefined) {
      if (!a.path)
        throw new MochiError('E_SCHEMA', 'Give the file as `path` or its text as `text`.', {
          path: 'args',
        });
      if (!ctx.fs)
        throw new MochiError(
          'E_ASSET_FORMAT',
          'Importing files needs file access, which this session does not have.',
        );
      text = new TextDecoder().decode(await readCapped(ctx.fs, a.path, LIMITS.projectFileBytes));
    }
    let file;
    try {
      file = parsePhysics(text, a.path ?? 'physics3.json');
    } catch (e) {
      throw new MochiError('E_ASSET_FORMAT', `Not a physics file: ${(e as Error).message}`, {
        path: a.path ? 'args.path' : 'args.text',
      });
    }
    const v = tx.draft;
    const ids = new Set(v.ofKind('parameter').map((p) => p.exportId));
    const names = new Map(file.names.map((n) => [n.id, n.name]));
    const existing = new Map(
      v
        .project()
        .physicsOrder.map((u) => v.getAs(u, 'physicsSetting'))
        .map((s) => [s.name, s.uid] as const),
    );
    const out = {
      added: [] as string[],
      replaced: [] as string[],
      unmatched: [] as { setting: string; kind: 'input' | 'output'; parameter: string }[],
      fps: file.fps,
    };
    for (const s of file.settings) {
      const name = names.get(s.id) ?? s.id;
      const keep = (kind: 'input' | 'output', id: string) => {
        if (ids.has(id)) return true;
        out.unmatched.push({ setting: name, kind, parameter: id });
        return false;
      };
      const fields = {
        name,
        inputs: s.inputs
          .filter((x) => keep('input', x.source))
          .map((x) => ({
            parameter: `@param:${x.source}`,
            weight: x.weight,
            type: x.type,
            reflect: x.reflect,
          })),
        outputs: s.outputs
          .filter((x) => keep('output', x.destination))
          .map((x) => ({
            parameter: `@param:${x.destination}`,
            weight: x.weight,
            type: x.type,
            reflect: x.reflect,
            particle: x.vertexIndex,
            scale: x.scale,
          })),
        particles: s.particles.map((p) => ({ ...p })),
        normalization: {
          position: {
            min: s.position.minimum,
            default: s.position.default,
            max: s.position.maximum,
          },
          angle: { min: s.angle.minimum, default: s.angle.default, max: s.angle.maximum },
        },
      };
      const uid = existing.get(name);
      if (uid) {
        tx.run('physics.updateSetting', { target: uid, ...fields });
        out.replaced.push(name);
      } else {
        tx.run('physics.addSetting', fields);
        out.added.push(name);
      }
    }
    if (v.project().physicsFps !== file.fps) tx.run('physics.setFps', { fps: file.fps });
    return { result: out };
  },
});
