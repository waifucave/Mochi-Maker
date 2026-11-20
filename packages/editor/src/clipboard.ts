/**
 * Cut, copy and paste of objects (Ctrl+X, Ctrl+C, Ctrl+V). A copy is a fragment
 * (`fragmentWithAssets`): the selected art meshes and deformers with everything below them, their
 * layers and images. It goes to the system clipboard as JSON text, so it can be pasted into another
 * project in another tab, and is also kept here for when the browser does not let the page read
 * the clipboard. A paste goes into the selected part or deformer (in place, through
 * `clipboard.paste`), and reports what it could not bind.
 */
import { FRAGMENT_FORMAT, type DocObject, type Fragment, type Uid } from '@mochi-maker/core';
import { fragmentWithAssets } from '@mochi-maker/export';
import type { Editor } from './editor.js';

const COPYABLE = new Set(['artMesh', 'warp', 'rotation']);

export class ObjectClipboard {
  /** The last copy made here. */
  fragment: Fragment | null = null;

  constructor(private readonly editor: Editor) {}

  /** The selected objects a copy takes. */
  copyable(): Uid[] {
    const v = this.editor.view;
    return this.editor.selection.uids.filter((u) => COPYABLE.has(v.get(u)?.kind ?? ''));
  }

  async copy(): Promise<Fragment | null> {
    const uids = this.copyable();
    if (uids.length === 0) return null;
    const f = await fragmentWithAssets(this.editor.view, this.editor.assets, uids);
    this.fragment = f;
    try {
      await navigator.clipboard.writeText(JSON.stringify(f));
    } catch {
      // Without clipboard access the copy stays in this tab.
    }
    const n = f.objects.filter((o) => (o as { kind: string }).kind !== 'layer').length;
    this.editor.emit('message', { level: 'info', text: `Copied ${n} object(s).` });
    return f;
  }

  /** Copy, then delete the copied objects: meshes first, then deformers from the innermost. */
  async cut(): Promise<void> {
    const f = await this.copy();
    if (!f) return;
    const objs = f.objects as unknown as DocObject[];
    const v = this.editor.view;
    const order = v.project().deformerOrder;
    const deformers = objs
      .filter((o) => o.kind === 'warp' || o.kind === 'rotation')
      .map((o) => o.uid)
      .sort((a, b) => order.indexOf(b) - order.indexOf(a));
    this.editor.transact(`Cut ${f.roots.length} object(s)`, [
      ...objs
        .filter((o) => o.kind === 'artMesh')
        .map((o) => ({ name: 'mesh.delete', args: { target: o.uid, cascade: true } })),
      ...deformers.map((u) => ({ name: 'deformer.delete', args: { target: u, cascade: true } })),
    ]);
  }

  /** The fragment on the system clipboard, or the last one copied here. */
  private async read(): Promise<Fragment | null> {
    try {
      const text = await navigator.clipboard.readText();
      const f = JSON.parse(text) as Fragment;
      if (f?.format === FRAGMENT_FORMAT) return f;
    } catch {
      // No access, or not a fragment: the copy kept here.
    }
    return this.fragment;
  }

  /**
   * Pastes into the selected part, or into the selected deformer (and its part), or next to the
   * selected mesh (its part and deformer). The copies are selected afterwards.
   */
  async paste(): Promise<void> {
    const f = await this.read();
    if (!f) {
      this.editor.emit('message', {
        level: 'error',
        text: 'Nothing to paste: copy objects first.',
      });
      return;
    }
    const v = this.editor.view;
    const sel = this.editor.selection.uid ? v.get(this.editor.selection.uid) : undefined;
    const into: { part?: Uid | null; deformer?: Uid } = {};
    if (sel?.kind === 'part') into.part = sel.uid;
    else if (sel?.kind === 'warp' || sel?.kind === 'rotation') {
      into.deformer = sel.uid;
      if (sel.part) into.part = sel.part;
    } else if (sel?.kind === 'artMesh') {
      if (sel.part) into.part = sel.part;
      if (sel.deformer) into.deformer = sel.deformer;
    }
    const r = await this.editor.runItems(`Paste ${f.roots.length} object(s)`, [
      { name: 'clipboard.paste', args: { fragment: f, ...into } },
    ]);
    const res = r?.itemResults[0] as
      { roots: Uid[]; unbound: { object: string; what: string; ref: string }[] } | undefined;
    if (!res) return;
    this.editor.selectMany(res.roots);
    if (res.unbound.length)
      this.editor.emit('message', {
        level: 'warning',
        text: `Pasted; not bound here: ${res.unbound
          .slice(0, 6)
          .map((u) => `${u.object}'s ${u.what} ${u.ref}`)
          .join(', ')}${res.unbound.length > 6 ? ` and ${res.unbound.length - 6} more` : ''}.`,
      });
  }
}
