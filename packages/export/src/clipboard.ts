/**
 * The clipboard operations: `clipboard.copy` makes a fragment of art meshes and
 * deformers with their layers' images, so it can travel to another project; `clipboard.paste`
 * puts one in, adding the images it needs, then (with `deformer`) moves the pasted objects into
 * that deformer in place, as `mesh.reparent` and `deformer.reparent` do.
 */
import { Type } from '@sinclair/typebox';
import {
  FRAGMENT_FORMAT,
  MochiError,
  RefOf,
  copyFragment,
  defineOperation,
  type AssetStore,
  type DocReader,
  type Fragment,
  type Uid,
} from '@mochi-maker/core';
import { deformerReparent, meshReparent } from './reparent.js';

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A fragment of these objects with their layers' images (what clipboard.copy returns). */
export async function fragmentWithAssets(
  v: DocReader,
  assets: AssetStore,
  uids: readonly Uid[],
): Promise<Fragment> {
  const f = copyFragment(v, uids);
  const out: Record<string, string> = {};
  for (const o of f.objects) {
    const l = o as { kind: string; asset?: string };
    if (l.kind === 'layer' && l.asset && !out[l.asset])
      out[l.asset] = b64(await assets.get(l.asset));
  }
  return { ...f, assets: out };
}

export const clipboardCopy = defineOperation({
  name: 'clipboard.copy',
  summary: 'Copy art meshes and deformers, with everything below them, as a fragment.',
  doc: `The fragment holds the objects (a deformer's child deformers and the meshes in them come
along), their layers and the layers' images (base64), and what they refer to outside: parameters
by export ID, parts, deformers and masks. Paste it with clipboard.paste, here or in another project.
Changes nothing.`,
  scope: 'read',
  undoable: false,
  args: Type.Object({
    targets: Type.Array(RefOf(['artMesh', 'warp', 'rotation']), { minItems: 1 }),
  }),
  result: Type.Object({ fragment: Type.Unknown(), objects: Type.Integer() }),
  errors: ['E_NOT_FOUND', 'E_WRONG_KIND'],
  examples: [{ description: 'Copy the face warp', args: { targets: ['@warp:Warp_Face'] } }],
  async run(ctx, tx, a) {
    const v = tx.draft;
    const uids = a.targets.map(
      (r, i) => v.getAs(r, ['artMesh', 'warp', 'rotation'], `args.targets[${i}]`).uid,
    );
    const fragment = await fragmentWithAssets(v, ctx.assets, uids);
    return { result: { fragment, objects: fragment.objects.length } };
  },
});

export const clipboardPaste = defineOperation({
  name: 'clipboard.paste',
  summary: 'Paste a fragment: into a part, and optionally into a deformer, in place.',
  doc: `Adds the fragment's images to the project's assets, then runs objects.paste (new UIDs and
export IDs, parameters bound by export ID, the rest reported in \`unbound\`). With \`deformer\`, each
pasted object at the top is then moved into it with mesh.reparent or deformer.reparent, so it stays
where it was on the canvas. One transaction.`,
  args: Type.Object({
    fragment: Type.Unknown(),
    part: Type.Optional(Type.Union([RefOf(['part']), Type.Null()])),
    deformer: Type.Optional(RefOf(['warp', 'rotation'])),
  }),
  result: Type.Object({
    roots: Type.Array(Type.String()),
    created: Type.Integer(),
    unbound: Type.Array(
      Type.Object({ object: Type.String(), what: Type.String(), ref: Type.String() }),
    ),
  }),
  errors: ['E_SCHEMA', 'E_RANGE'],
  examples: [],
  async run(ctx, tx, a) {
    const f = a.fragment as Fragment;
    if (f?.format !== FRAGMENT_FORMAT)
      throw new MochiError('E_SCHEMA', 'This is not a Mochi Maker fragment.', {
        path: 'args.fragment',
      });
    for (const [hash, data] of Object.entries(f.assets ?? {})) {
      const got = await ctx.assets.put(unb64(data));
      if (got !== hash)
        throw new MochiError(
          'E_SCHEMA',
          `An image in the fragment does not match its hash ${hash}.`,
          {
            path: 'args.fragment.assets',
          },
        );
    }
    const { assets: _assets, ...fragment } = f;
    const r = tx.run('objects.paste', {
      fragment,
      ...(a.part !== undefined ? { part: a.part } : {}),
    }) as {
      roots: string[];
      created: number;
      unbound: { object: string; what: string; ref: string }[];
    };
    if (a.deformer) {
      const into = tx.draft.getAs(a.deformer, ['warp', 'rotation']).uid;
      for (const u of r.roots) {
        const o = tx.draft.get(u)!;
        if (o.kind === 'artMesh') await meshReparent.run(ctx, tx, { target: u, deformer: into });
        else await deformerReparent.run(ctx, tx, { target: u, parent: into });
      }
    }
    return { result: r };
  },
});
