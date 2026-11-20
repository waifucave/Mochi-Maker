/**
 * The draw-order strip along the View area's left edge: 0 at the bottom,
 * 1000 at the top (nearer the viewer). Selecting ArtMeshes or parts shows a marker at their draw
 * order at the pose, shaped by kind: an ArtMesh, a part, or a part that is a draw-order group.
 * Dragging a marker sets the draw order of that keyform; the strip's right-click menu locks it.
 */
import type { Uid } from '@mochi-maker/core';
import type { Editor } from './editor.js';
import { fill, h } from './dom.js';
import { popupMenu } from './panels.js';

export class DrawOrderSlider {
  readonly el = h('div.draw-strip', { dataset: { testid: 'draw-strip' } });
  locked = false;
  private readonly scale = h('div.draw-scale');

  constructor(private readonly editor: Editor) {
    this.el.append(this.scale);
    for (const ev of ['selection', 'pose', 'document', 'project'] as const)
      editor.on(ev, () => this.render());
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      popupMenu(e, [
        {
          label: this.locked ? 'Unlock the draw-order strip' : 'Lock the draw-order strip',
          checked: this.locked,
          run: () => {
            this.locked = !this.locked;
            this.render();
          },
        },
      ]);
    });
    this.render();
  }

  private value(uid: Uid): number | null {
    const o = this.editor.view.get(uid);
    if (o?.kind !== 'artMesh' && o?.kind !== 'part') return null;
    const at = this.editor.cellAtPose(uid);
    const k = o.rig.keyforms[at.ok ? at.index : 0] as { drawOrder?: number } | undefined;
    return k?.drawOrder ?? null;
  }

  render(): void {
    const marks: HTMLElement[] = [];
    for (const uid of this.editor.selection.uids) {
      const o = this.editor.view.get(uid);
      const v = this.value(uid);
      if (!o || v === null) continue;
      const shape =
        o.kind === 'artMesh'
          ? 'mesh'
          : o.kind === 'part' && o.sortingScope === 'own'
            ? 'group'
            : 'part';
      const m = h(
        'div.draw-mark',
        {
          class: `${shape} ${this.locked ? 'locked' : ''}`,
          style: `bottom:${(Math.max(0, Math.min(1000, v)) / 1000) * 100}%`,
          title: `${'exportId' in o ? o.exportId : uid}: draw order ${Math.round(v)}`,
          dataset: { mark: uid },
        },
        h('span.draw-value', String(Math.round(v))),
      );
      m.addEventListener('pointerdown', (e) => this.drag(e, uid, m));
      marks.push(m);
    }
    fill(this.scale, h('span.draw-top', '1000'), marks, h('span.draw-bottom', '0'));
    this.el.classList.toggle('locked', this.locked);
  }

  private drag(e: PointerEvent, uid: Uid, mark: HTMLElement): void {
    if (this.locked || e.button !== 0) return;
    e.preventDefault();
    const r = this.scale.getBoundingClientRect();
    let value = this.value(uid) ?? 0;
    const at = (y: number) =>
      Math.round(Math.max(0, Math.min(1000, ((r.bottom - y) / r.height) * 1000)));
    const move = (m: PointerEvent) => {
      value = at(m.clientY);
      mark.style.bottom = `${value / 10}%`;
      mark.querySelector('.draw-value')!.textContent = String(value);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const cell = this.editor.cellAtPose(uid);
      if (!cell.ok) {
        this.editor.emit('message', { level: 'error', text: cell.reason });
        this.render();
        return;
      }
      if (value === Math.round(this.value(uid) ?? -1)) return this.render();
      this.editor.transact('Draw order', [
        {
          name: 'keyform.set',
          args: { target: uid, cell: cell.cell, values: { drawOrder: value } },
        },
      ]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}
