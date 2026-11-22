/**
 * Model templates in the editor (Modeling › Model Template). «Export Template…» saves the
 * open project as a template (`exportTemplate`): a name, a description, an author, whether physics
 * comes along, and the view as its thumbnail. «Apply Template…» puts one on the selected art meshes
 * (or all of them):
 *
 * - **choosing:** templates loaded from files or a folder, shown as thumbnails, searchable by name,
 *   description and author (they stay loaded for the session);
 * - **layout:** the template's art is drawn over the target's; dragging on the canvas moves it, a
 *   right-drag scales it about where the drag started, and T cycles how see-through it is. «Fit»
 *   goes back to the template fitted onto the targets;
 * - **matching:** automatic (names, then position and shape), redone as the layout moves; every
 *   target has a list to pick its template mesh by hand, or none;
 * - **options:** draw order, re-dividing, masks, culling and blending, and merge or add for
 *   parameters and physics settings that already exist;
 * - **Apply:** one undoable step, `modelTemplate.apply` (which agents run too).
 */
import { DocView, LIMITS, Session, runItems, type Uid } from '@mochi-maker/core';
import { readZip } from '@mochi-maker/art';
import { fileBytes } from './limits.js';
import { MochiView } from 'mochi2d';
import { parseMotion } from 'mochi2d/headless';
import {
  OPERATIONS,
  PreviewBuilder,
  defaultLayout,
  motionFile,
  retargetMotion,
  exportTemplate,
  BUILD_TEXTURES,
  matchTemplate,
  readTemplate,
  templateZip,
  type LoadedTemplate,
  type TemplateApplyResult,
  type TemplateLayout,
  type TemplateOptions,
} from '@mochi-maker/export';
import { dialog, type Dialog } from './dialogs.js';
import { fill, h } from './dom.js';
import type { Editor } from './editor.js';
import { store } from './settings.js';
import type { Viewport } from './viewport.js';

export interface TemplateEntry {
  /** Where it came from (a file name). */
  source: string;
  files: Map<string, Uint8Array>;
  template: LoadedTemplate;
  thumbnail: string | null;
}

/** The templates loaded in this session. */
export const loadedTemplates: TemplateEntry[] = [];

const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Loads a .mochitemplate file's bytes into the session's list (replacing one of the same name). */
export async function addTemplate(source: string, bytes: Uint8Array): Promise<TemplateEntry> {
  const files = await readZip(source, bytes, LIMITS.projectArchive);
  const template = await readTemplate(files);
  const entry: TemplateEntry = {
    source,
    files,
    template,
    thumbnail: template.thumbnail
      ? URL.createObjectURL(new Blob([template.thumbnail as BlobPart], { type: 'image/png' }))
      : null,
  };
  const i = loadedTemplates.findIndex((t) => t.template.meta.name === template.meta.name);
  if (i >= 0) loadedTemplates.splice(i, 1, entry);
  else loadedTemplates.push(entry);
  return entry;
}

/** The view, scaled to at most 256 pixels a side, as a PNG (the template's thumbnail). */
async function thumbnail(viewport: Viewport): Promise<Uint8Array | null> {
  try {
    const shot = await createImageBitmap(await viewport.view.screenshot());
    const k = Math.min(1, 256 / Math.max(shot.width, shot.height));
    const c = new OffscreenCanvas(
      Math.max(1, Math.round(shot.width * k)),
      Math.max(1, Math.round(shot.height * k)),
    );
    c.getContext('2d')!.drawImage(shot, 0, 0, c.width, c.height);
    shot.close();
    return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } catch {
    return null;
  }
}

/** «Export Template…»: the open project as a template file. */
export function exportTemplateDialog(
  editor: Editor,
  viewport: Viewport,
  save: (name: string, bytes: Uint8Array) => Promise<void>,
): Dialog {
  const field = (label: string, input: HTMLElement) => h('label.field', h('span', label), input);
  const name = h('input', {
    type: 'text',
    value: editor.name,
    dataset: { testid: 'tpl-name' },
  }) as HTMLInputElement;
  const description = h('textarea', {
    rows: 3,
    dataset: { testid: 'tpl-description' },
  }) as HTMLTextAreaElement;
  const author = h('input', {
    type: 'text',
    value: store.get<string>('mochi-maker.templateAuthor') ?? '',
    dataset: { testid: 'tpl-author' },
  }) as HTMLInputElement;
  const physics = h('input', {
    type: 'checkbox',
    checked: true,
    dataset: { testid: 'tpl-physics' },
  }) as HTMLInputElement;
  const v = editor.view;
  const facts = h(
    'div.facts',
    `${v.ofKind('artMesh').length} art meshes, ${v.ofKind(['warp', 'rotation']).length} deformers, ${v.ofKind('parameter').length} parameters, ${v.ofKind('physicsSetting').length} physics settings. The view becomes the thumbnail.`,
  );
  const d = dialog(
    'Export Template',
    [
      field('Name', name),
      field('Description', description),
      field('Author', author),
      h('label.toggle', physics, ' Include the physics settings'),
      facts,
      h(
        'div.buttons',
        h(
          'button.primary',
          {
            dataset: { testid: 'tpl-export' },
            on: {
              click: async () => {
                store.set('mochi-maker.templateAuthor', author.value);
                const files = await exportTemplate(editor.doc, editor.assets, {
                  name: name.value || editor.name,
                  description: description.value,
                  author: author.value,
                  physics: physics.checked,
                  thumbnail: await thumbnail(viewport),
                });
                await save(name.value || editor.name, templateZip(files));
                d.close();
              },
            },
          },
          'Export',
        ),
        h('button', { on: { click: () => d.close() } }, 'Cancel'),
      ),
    ],
    { testid: 'template-export' },
  );
  name.focus();
  return d;
}

/** Decodes the template's layer images, for drawing its art over the target. */
async function guideImages(t: LoadedTemplate) {
  const v = new DocView(t.doc);
  const out: { image: ImageBitmap; x: number; y: number; width: number; height: number }[] = [];
  for (const l of v.ofKind('layer')) {
    if (!l.visible || !(await t.assets.has(l.asset))) continue;
    const bytes = await t.assets.get(l.asset);
    const image = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
    out.push({ image, x: l.x, y: l.y, width: l.width, height: l.height });
  }
  return out;
}

/** «Apply Template…» (see the module comment). */
export function applyTemplateDialog(editor: Editor, viewport: Viewport): Dialog {
  const body = h('div.template-apply');
  let alpha = 0.5;
  const cleanup = () => {
    closePreview();
    viewport.templateGuide?.images.forEach((i) => i.image.close());
    viewport.templateGuide = null;
    viewport.layoutEdit = null;
    window.removeEventListener('keydown', onKey, true);
    viewport.drawOverlay();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!viewport.templateGuide || e.key.toLowerCase() !== 't' || e.ctrlKey || e.metaKey) return;
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    alpha = alpha <= 0.25 ? 0.85 : alpha <= 0.5 ? 0.25 : 0.5;
    viewport.templateGuide.alpha = alpha;
    viewport.drawOverlay();
  };
  const d = dialog('Apply Template', [body], {
    testid: 'template-apply',
    modal: false,
    wide: true,
    onClose: cleanup,
  });

  // ---------------------------------------------------------------- choosing
  const choose = () => {
    cleanup();
    const search = h('input', {
      type: 'search',
      placeholder: 'Search by name, description or author',
      dataset: { testid: 'tpl-search' },
    }) as HTMLInputElement;
    const grid = h('div.template-grid', { dataset: { testid: 'tpl-grid' } });
    const files = h('input', {
      type: 'file',
      multiple: true,
      accept: '.mochitemplate,application/zip',
      dataset: { testid: 'tpl-files' },
    }) as HTMLInputElement;
    const folder = h('input', {
      type: 'file',
      dataset: { testid: 'tpl-folder' },
    }) as HTMLInputElement;
    folder.setAttribute('webkitdirectory', '');
    const load = async (list: FileList | null) => {
      for (const f of [...(list ?? [])].filter((x) => x.name.endsWith('.mochitemplate')))
        try {
          await addTemplate(f.name, await fileBytes(f));
        } catch (e) {
          editor.report(e);
        }
      render();
    };
    files.addEventListener('change', () => void load(files.files));
    folder.addEventListener('change', () => void load(folder.files));
    const render = () => {
      const q = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = loadedTemplates.filter((t) => {
        const m = t.template.meta;
        const hay = `${m.name} ${m.description} ${m.author}`.toLowerCase();
        return q.every((w) => hay.includes(w));
      });
      fill(
        grid,
        shown.length
          ? shown.map((t) =>
              h(
                'button.template-card',
                {
                  dataset: { template: t.template.meta.name },
                  title: t.template.meta.description,
                  on: { click: () => void layout(t) },
                },
                t.thumbnail ? h('img', { src: t.thumbnail, alt: '' }) : h('div.noimg', '—'),
                h('b', t.template.meta.name),
                h('span', t.template.meta.author || 'unknown author'),
                h(
                  'span.dim',
                  `${t.template.meta.counts.meshes} meshes · ${t.template.meta.counts.deformers} deformers`,
                ),
              ),
            )
          : h(
              'div.empty',
              loadedTemplates.length
                ? 'No template matches.'
                : 'Load templates from files or a folder.',
            ),
      );
    };
    search.addEventListener('input', render);
    fill(
      body,
      h(
        'div.buttons',
        h('label.button', 'Template files…', files),
        h('label.button', 'A folder of templates…', folder),
      ),
      search,
      grid,
    );
    render();
  };

  // ---------------------------------------------------------------- layout, matching, options
  const layout = async (t: TemplateEntry) => {
    const T = new DocView(t.template.doc);
    const D = () => editor.view;
    const sel = editor.selection.uids.filter((u) => D().get(u)?.kind === 'artMesh');
    const targets: Uid[] = sel.length
      ? sel
      : D()
          .ofKind('artMesh')
          .map((m) => m.uid);
    let lay: TemplateLayout = defaultLayout(T, D(), targets);
    const hand = new Map<Uid, Uid | null>();
    viewport.templateGuide = { images: await guideImages(t.template), layout: lay, alpha };
    window.addEventListener('keydown', onKey, true);
    let drag: { button: number; start: [number, number]; lay0: TemplateLayout } | null = null;
    viewport.layoutEdit = (e) => {
      if (e.kind === 'down') drag = { button: e.button, start: e.at, lay0: { ...lay } };
      else if (drag) {
        const [dx, dy] = [e.at[0] - drag.start[0], e.at[1] - drag.start[1]];
        if (drag.button === 2) {
          const f = Math.exp(dx / 200);
          const [ax, ay] = drag.start;
          lay = {
            scale: drag.lay0.scale * f,
            x: ax - (ax - drag.lay0.x) * f,
            y: ay - (ay - drag.lay0.y) * f,
          };
        } else lay = { ...drag.lay0, x: drag.lay0.x + dx, y: drag.lay0.y + dy };
        viewport.templateGuide!.layout = lay;
        viewport.drawOverlay();
        if (e.kind === 'up') {
          drag = null;
          renderPairs();
        }
      }
    };
    viewport.drawOverlay();
    const pairsEl = h('div.rows.template-pairs', { dataset: { testid: 'tpl-pairs' } });
    const layoutFacts = h('div.facts', { dataset: { testid: 'tpl-layout' } });
    const tMeshes = T.ofKind('artMesh');
    const renderPairs = () => {
      layoutFacts.textContent = `Scale ${lay.scale.toFixed(3)}, offset (${lay.x.toFixed(1)}, ${lay.y.toFixed(1)}) px. Drag on the canvas to move, right-drag to scale; T: see-through.`;
      const fixed = [...hand].map(([target, template]) => ({ target, template }));
      const m = matchTemplate(T, D(), targets, lay, fixed);
      const byTarget = new Map(m.pairs.map((p) => [p.target, p]));
      fill(
        pairsEl,
        targets.map((u) => {
          const p = byTarget.get(u);
          const select = h(
            'select',
            {
              dataset: { target: D().getAs(u, 'artMesh').exportId },
              on: {
                change: (ev) => {
                  const v = (ev.target as HTMLSelectElement).value;
                  hand.set(u, v || null);
                  renderPairs();
                },
              },
            },
            h('option', { value: '', selected: !p }, '— none —'),
            tMeshes.map((x) =>
              h('option', { value: x.uid, selected: p?.template === x.uid }, x.exportId),
            ),
          );
          return h(
            'div.row',
            h('span.name', D().getAs(u, 'artMesh').exportId),
            select,
            h(
              'span.extra',
              p ? (p.by === 'shape' ? `shape ${p.cost.toFixed(2)}` : p.by) : 'unmatched',
            ),
          );
        }),
      );
    };
    const opt = (testid: string, label: string, choices: [string, string][]) => {
      const s = h(
        'select',
        { dataset: { testid } },
        choices.map(([v, t]) => h('option', { value: v }, t)),
      ) as HTMLSelectElement;
      return { el: h('label.field', h('span', label), s), get: () => s.value };
    };
    const drawOrder = opt('tpl-draworder', 'Draw order', [
      ['template', "The template's"],
      ['keep', 'Keep the art’s'],
    ]);
    const params = opt('tpl-params', 'Parameter IDs that exist', [
      ['merge', 'Merge (use the existing parameter)'],
      ['add', 'Add new ones'],
    ]);
    const physics = opt('tpl-physics-mode', 'Physics groups that exist', [
      ['merge', 'Merge (replace by name)'],
      ['add', 'Add new ones'],
      ['none', 'Bring no physics'],
    ]);
    const check = (testid: string, label: string, on: boolean) => {
      const c = h('input', {
        type: 'checkbox',
        checked: on,
        dataset: { testid },
      }) as HTMLInputElement;
      return { el: h('label.toggle', c, ` ${label}`), get: () => c.checked };
    };
    const redivide = check('tpl-redivide', 'Re-divide the meshes like the template’s', false);
    const mcb = check('tpl-mcb', 'Masks, culling and blending from the template', true);
    const parts = check('tpl-parts', 'The template’s parts (the targets move into them)', true);
    const status = h('div.facts', { dataset: { testid: 'tpl-status' } });
    const args = () => {
      const fixed = [...hand].map(([target, template]) => ({
        target,
        template: template ? T.getAs(template, 'artMesh').exportId : null,
      }));
      const options: TemplateOptions = {
        drawOrder: drawOrder.get() as 'template' | 'keep',
        redivide: redivide.get(),
        masksCullingBlend: mcb.get(),
        parts: parts.get(),
        parameters: params.get() as 'merge' | 'add',
        physics: physics.get() as 'merge' | 'add' | 'none',
      };
      return {
        files: Object.fromEntries([...t.files].map(([p, b]) => [p, b64(b)])),
        targets,
        layout: lay,
        pairs: fixed,
        options,
      };
    };
    // ---------------------------------------------------------------- the preview
    const previewBox = h('div.template-preview', { dataset: { testid: 'tpl-preview' } });
    const motionSel = h(
      'select',
      { dataset: { testid: 'tpl-motion' } },
      T.ofKind('motion').map((m) => h('option', { value: m.uid }, m.name)),
    ) as HTMLSelectElement;
    const preview = async () => {
      closePreview();
      status.textContent = 'Building the preview…';
      try {
        lastPreview = await buildPreview(editor, t, args(), previewBox);
        const n = T.ofKind('motion').length;
        status.textContent = n
          ? `Preview: the template (left) and the result (right). Play a motion on both.`
          : 'Preview: the template has no motions to play.';
      } catch (e) {
        status.textContent = (e as Error).message;
      }
    };
    const play = () => {
      if (!lastPreview || !motionSel.value) return;
      const r = lastPreview.play(motionSel.value as Uid);
      status.textContent = `Playing «${T.getAs(motionSel.value as Uid, 'motion').name}» on both: ${r.kept} curve(s) retargeted by parameter ID${r.dropped.length ? `; not in the result: ${r.dropped.join(', ')}` : ''}.`;
    };
    const apply = async () => {
      closePreview();
      const r = await editor.runItems(`Apply template ${t.template.meta.name}`, [
        { name: 'modelTemplate.apply', args: args() },
      ]);
      const res = r?.itemResults[0] as TemplateApplyResult | undefined;
      if (!res) {
        status.textContent = 'Not applied: see the status line.';
        return;
      }
      editor.emit('message', {
        level: res.notes.length ? 'warning' : 'info',
        text: `Applied ${res.template}: ${res.pairs.length} mesh(es), ${res.deformers.length} deformer(s), ${res.parameters.added.length} parameter(s) added and ${res.parameters.merged.length} merged.${res.notes.length ? ` ${res.notes.join(' ')}` : ''}`,
      });
      d.close();
    };
    fill(
      body,
      h('h3', t.template.meta.name),
      h('div.facts', t.template.meta.description || ''),
      layoutFacts,
      h(
        'div.buttons',
        h(
          'button',
          {
            dataset: { testid: 'tpl-fit' },
            on: {
              click: () => {
                lay = defaultLayout(T, D(), targets);
                viewport.templateGuide!.layout = lay;
                viewport.drawOverlay();
                renderPairs();
              },
            },
          },
          'Fit',
        ),
      ),
      h('h3', `Matching (${targets.length} target meshes)`),
      pairsEl,
      h('h3', 'Options'),
      drawOrder.el,
      redivide.el,
      mcb.el,
      h('h3', 'Advanced'),
      params.el,
      physics.el,
      parts.el,
      h('h3', 'Preview'),
      h(
        'div.buttons',
        h(
          'button',
          { dataset: { testid: 'tpl-preview-build' }, on: { click: () => void preview() } },
          'Preview',
        ),
        motionSel,
        h('button', { dataset: { testid: 'tpl-play' }, on: { click: play } }, 'Play on both'),
      ),
      previewBox,
      status,
      h(
        'div.buttons',
        h(
          'button.primary',
          { dataset: { testid: 'tpl-apply' }, on: { click: () => void apply() } },
          'Apply',
        ),
        h('button', { on: { click: () => choose() } }, 'Back'),
        h('button', { on: { click: () => d.close() } }, 'Close'),
      ),
    );
    renderPairs();
  };

  choose();
  return d;
}

// ---------------------------------------------------------------- the preview

export interface TemplatePreview {
  left: MochiView;
  right: MochiView;
  result: TemplateApplyResult;
  /** Plays a template motion on both, retargeted by parameter ID on the right. */
  play(motion: Uid): { kept: number; dropped: string[] };
  dispose(): void;
}

/** The last preview built (for tests and agents); null once closed. */
export let lastPreview: TemplatePreview | null = null;

function closePreview(): void {
  lastPreview?.dispose();
  lastPreview = null;
}

/**
 * The template (left) and the target as applying would leave it (right), side by side: the apply
 * runs on a copy of the document, so nothing changes until «Apply». Physics and the pose run;
 * the other effects are off, so the two move only by the motion.
 */
async function buildPreview(
  editor: Editor,
  t: TemplateEntry,
  args: Record<string, unknown>,
  box: HTMLElement,
): Promise<TemplatePreview> {
  const scratch = Session.open(editor.doc, { features: editor.features });
  const r = await runItems(
    { session: scratch, assets: editor.assets },
    'Preview',
    [{ name: 'modelTemplate.apply', args }],
    { operations: OPERATIONS },
  );
  const result = r.itemResults[0] as TemplateApplyResult;
  const view = async (doc: typeof scratch.doc, assets: typeof editor.assets, label: string) => {
    const canvas = h('canvas') as HTMLCanvasElement;
    const cell = h(
      'div.preview-cell',
      { dataset: { testid: `tpl-view-${label}` } },
      canvas,
      h('span', label),
    );
    box.append(cell);
    const v = new MochiView(canvas, { look: 'off', maxPixelRatio: 1 });
    const b = await new PreviewBuilder(assets).build(doc);
    // A template from others: built here, so its textures are what an export may hold; its
    // motion sounds play only as WAV (Mochi2D's default for models one did not make).
    const model = await v.load(
      { files: b.files },
      { settings: b.settings, textures: BUILD_TEXTURES },
    );
    for (const e of ['eyeBlink', 'breath', 'look', 'idle', 'lipSync', 'expressions'] as const)
      if (model.effectAvailable(e)) model.setEffect(e, false);
    return v;
  };
  fill(box);
  const left = await view(t.template.doc, t.template.assets, 'template');
  const right = await view(scratch.doc, editor.assets, 'result');
  const T = new DocView(t.template.doc);
  return {
    left,
    right,
    result,
    play(uid) {
      const json = motionFile(T, T.getAs(uid, 'motion')) as unknown as Parameters<
        typeof retargetMotion
      >[0];
      const re = retargetMotion(json, result.parameterIds);
      for (const [v, m] of [
        [left, json],
        [right, re.motion],
      ] as const) {
        const model = v.model;
        if (!model) continue;
        model.stopMotions();
        model.runtime.playMotion(parseMotion(JSON.stringify(m), 'template motion'), {
          priority: 3,
          loop: true,
          sound: false,
        });
      }
      return { kept: re.kept, dropped: re.dropped };
    },
    dispose() {
      left.dispose();
      right.dispose();
      fill(box);
    },
  };
}
