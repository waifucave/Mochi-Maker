/**
 * The editor's dialogs: Home, Keyboard Shortcuts (5.5), Environment Settings,
 * Workspace Settings (2.1), the automatic mesh dialog (3.3), creating deformers (3.4), creating
 * parameters and editing keys (3.5), and the texture atlas (3.7). Every change they make is a
 * command, or a setting of the editor.
 */
import {
  STANDARD_ID_NOTE,
  STANDARD_PARAMETERS,
  STANDARD_PARAMETER_GROUPS,
  STANDARD_SECTIONS,
  caseOnlyStandard,
  standardParameter,
  standardRange,
  type ArtMesh,
  type Parameter,
  type Rotation,
  type Uid,
  type Warp,
} from '@mochi-maker/core';
import { round, type Editor } from './editor.js';
import { fill, h, type Child } from './dom.js';
import type { Dock } from './dock.js';
import type { Category, Keymap } from './keymap.js';
import { DEFAULT_SETTINGS, store, type Settings, type SettingsStore } from './settings.js';
import type { Tips } from './tips.js';
import { TERM, label } from './panels.js';
import { fileText } from './limits.js';

export interface Dialog {
  el: HTMLElement;
  close(): void;
}

/** A dialog box. Modal ones dim the window; others leave the canvas usable (the automatic mesh). */
export function dialog(
  title: string,
  body: Child[],
  options: { modal?: boolean; testid?: string; onClose?: () => void; wide?: boolean } = {},
): Dialog {
  const modal = options.modal ?? true;
  const box = h(
    'div.dialog',
    { class: options.wide ? 'wide' : '', dataset: { testid: options.testid ?? 'dialog' } },
    h(
      'div.dialog-title',
      h('span', title),
      h('button.float-close', { title: 'Close', on: { click: () => d.close() } }, '×'),
    ),
    h('div.dialog-body', body),
  );
  const el = modal ? h('div.backdrop', box) : box;
  if (!modal) box.classList.add('modeless');
  if (modal)
    el.addEventListener('pointerdown', (e) => {
      if (e.target === el) d.close();
    });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      d.close();
    }
  });
  // A modal dialog answers Escape wherever the focus is (it need not be inside the dialog, for
  // example after a file dialog), before the editor's shortcuts; only the topmost one closes.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !el.isConnected) return;
    const top = [...document.querySelectorAll('body > .backdrop')].at(-1);
    if (top !== el) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    d.close();
  };
  let closed = false;
  const d: Dialog = {
    el,
    close() {
      if (closed) return;
      closed = true;
      if (modal) document.removeEventListener('keydown', onKey, true);
      el.remove();
      options.onClose?.();
    },
  };
  document.body.append(el);
  if (modal) {
    document.addEventListener('keydown', onKey, true);
    // The focus moves into the dialog (callers may then focus a field in it).
    box.tabIndex = -1;
    box.focus({ preventScroll: true });
  }
  return d;
}

/**
 * Asks for a line of text in a dialog (the page's own, since the desktop build's Electron has no
 * `window.prompt`). Resolves to the text, or null when cancelled.
 */
export function askText(title: string, label: string, value = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const input = h('input', {
      type: 'text',
      value,
      dataset: { testid: 'ask-text' },
      on: {
        keydown: (e) => {
          if ((e as KeyboardEvent).key === 'Enter') ok();
        },
      },
    }) as HTMLInputElement;
    const ok = () => {
      answer = input.value;
      d.close();
    };
    const d = dialog(
      title,
      [
        h('label.field', h('span', label), input),
        h(
          'div.buttons',
          h('button.primary', { dataset: { testid: 'ask-ok' }, on: { click: ok } }, 'OK'),
          h('button', { on: { click: () => d.close() } }, 'Cancel'),
        ),
      ],
      { testid: 'ask', onClose: () => resolve(answer) },
    );
    input.focus();
    input.select();
  });
}

const field = (name: string, input: Node, hint?: string) =>
  h('label.field', { title: hint ?? '' }, h('span', name), input);

// ---------------------------------------------------------------- Home

export interface HomeActions {
  newModel(w: number, h: number): void;
  openFolder(): void;
  openZip(): void;
  importArt(file?: File): void;
}

export function homeDialog(settings: SettingsStore, actions: HomeActions): Dialog {
  const w = h('input', {
    type: 'number',
    value: '2048',
    min: '64',
    step: '1',
    dataset: { testid: 'home-width' },
  });
  const hh = h('input', { type: 'number', value: '2048', min: '64', step: '1' });
  const recent = store.get<string[]>('mochi-maker.recent') ?? [];
  const drop = h(
    'div.drop-zone',
    {
      on: {
        dragover: (e) => e.preventDefault(),
        drop: (e) => {
          e.preventDefault();
          e.stopPropagation();
          const f = (e as DragEvent).dataTransfer?.files?.[0];
          if (f) {
            d.close();
            actions.importArt(f);
          }
        },
      },
    },
    'Drop a PSD, OpenRaster or PNG here for a new model from it',
  );
  const d = dialog(
    'Home',
    [
      h('div.home-brand', h('span.brand', 'mochi', h('b', 'maker'))),
      h('h3', 'New'),
      h(
        'div.buttons',
        field('Canvas', h('span', w, ' × ', hh)),
        h(
          'button.primary',
          {
            dataset: { testid: 'home-new' },
            on: {
              click: () => {
                d.close();
                actions.newModel(Number(w.value) || 2048, Number(hh.value) || 2048);
              },
            },
          },
          'New model',
        ),
        h(
          'button',
          { on: { click: () => (d.close(), actions.importArt()) } },
          'New model from art…',
        ),
      ),
      drop,
      h('h3', 'Open'),
      h(
        'div.buttons',
        h(
          'button',
          { on: { click: () => (d.close(), actions.openFolder()) } },
          'Open project folder…',
        ),
        h('button', { on: { click: () => (d.close(), actions.openZip()) } }, 'Open .mochi.zip…'),
      ),
      recent.length
        ? h(
            'div.facts',
            'Recently opened: ',
            recent.slice(0, 8).join(', '),
            ' (browsers keep no paths: open them again from their folder).',
          )
        : null,
      h(
        'div.facts',
        'Automatic backups: the browser keeps no copy of an unsaved project; File › Save downloads one.',
      ),
      h(
        'div.buttons',
        h(
          'label.toggle',
          h('input', {
            type: 'checkbox',
            checked: settings.value.homeAtStartup,
            on: {
              change: (e) => settings.set('homeAtStartup', (e.target as HTMLInputElement).checked),
            },
          }),
          'Show Home at startup',
        ),
        h(
          'label.toggle',
          h('input', {
            type: 'checkbox',
            checked: settings.value.homeClosesOnOpen,
            on: {
              change: (e) =>
                settings.set('homeClosesOnOpen', (e.target as HTMLInputElement).checked),
            },
          }),
          'Close Home when a file opens',
        ),
      ),
    ],
    { testid: 'home' },
  );
  return d;
}

// ---------------------------------------------------------------- keyboard shortcuts

export function shortcutsDialog(keymap: Keymap): Dialog {
  const start = keymap.snapshot();
  const search = h('input.cmd-search', {
    placeholder: 'Search by command or key (several words narrow it)',
    dataset: { testid: 'shortcut-search' },
  });
  const list = h('div.shortcut-list');
  const file = h('input', { type: 'file', accept: '.json', hidden: true });
  const message = h('div.facts', { dataset: { testid: 'shortcut-message' } });
  let capturing: { id: string; index: number } | null = null;

  const render = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const conflicts = keymap.conflicts();
    const cats = new Map<Category, HTMLElement[]>();
    for (const a of keymap.actions.values()) {
      const keys = keymap.keysOf(a.id);
      const hay =
        `${a.label} ${a.id} ${keys.join(' ')} ${keys.map((k) => keymap.label(k)).join(' ')}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const changed = JSON.stringify(keys) !== JSON.stringify(keymap.defaults(a.id));
      const row = h(
        'div.shortcut-row',
        { dataset: { action: a.id } },
        h(
          'span.name',
          a.label,
          a.context ? h('span.context', ` · in ${a.context}`) : null,
          changed ? h('span.changed', ' (changed)') : null,
        ),
        h(
          'span.keys',
          keys.map((k, i) =>
            h(
              'button.key',
              {
                class: conflicts.has(k) ? 'conflict' : '',
                title: conflicts.has(k)
                  ? `Also bound to: ${conflicts
                      .get(k)!
                      .filter((x) => x !== a.id)
                      .map((x) => keymap.get(x)?.label)
                      .join(', ')}. Click to rebind.`
                  : 'Click, then press the new key',
                on: { click: () => ((capturing = { id: a.id, index: i }), render()) },
              },
              capturing?.id === a.id && capturing.index === i ? 'Press a key…' : keymap.label(k),
              h(
                'span.remove',
                {
                  title: 'Remove this key',
                  on: {
                    click: (e) => {
                      e.stopPropagation();
                      keymap.setKeys(
                        a.id,
                        keys.filter((_, j) => j !== i),
                      );
                      render();
                    },
                  },
                },
                '×',
              ),
            ),
          ),
          h(
            'button.key.add',
            {
              title: 'Add a key',
              dataset: { testid: `add-key-${a.id}` },
              on: { click: () => ((capturing = { id: a.id, index: keys.length }), render()) },
            },
            capturing?.id === a.id && capturing.index === keys.length ? 'Press a key…' : '+',
          ),
        ),
      );
      cats.set(a.category, [...(cats.get(a.category) ?? []), row]);
    }
    fill(
      list,
      [...cats].map(([c, rows]) => h('div.shortcut-cat', h('h3', c), rows)),
    );
    const n = conflicts.size;
    message.textContent = n
      ? `${n} key${n > 1 ? 's are' : ' is'} bound to more than one command (marked). The first that applies runs.`
      : '';
  };
  search.addEventListener('input', render);

  const d = dialog(
    'Keyboard Shortcuts',
    [
      h(
        'div.facts',
        keymap.mac
          ? 'On macOS, Ctrl in a shortcut means ⌘ Command (Environment Settings can make it Control). '
          : '',
        'The number keys above the letters and the keypad numbers are different keys. New default keys of later versions appear by themselves; your changes stay.',
      ),
      search,
      message,
      list,
      h(
        'div.buttons',
        h(
          'button',
          {
            dataset: { testid: 'shortcuts-export' },
            on: {
              click: () => {
                const blob = new Blob([JSON.stringify(keymap.exportFile(), null, 2)], {
                  type: 'application/json',
                });
                const a = h('a', {
                  href: URL.createObjectURL(blob),
                  download: 'mochi-maker-shortcuts.json',
                });
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
              },
            },
          },
          'Export…',
        ),
        h('button', { on: { click: () => file.click() } }, 'Import…'),
        h('button', { on: { click: () => (keymap.restore(start), render()) } }, 'Restore'),
        h(
          'button',
          {
            dataset: { testid: 'shortcuts-reset' },
            on: { click: () => (keymap.resetAll(), render()) },
          },
          'Reset to defaults',
        ),
        file,
      ),
    ],
    { testid: 'shortcuts', wide: true },
  );
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const n = keymap.importFile(JSON.parse(await fileText(f)));
      message.textContent = `Imported the keys of ${n} commands.`;
      render();
    } catch (e) {
      message.textContent = (e as Error).message;
    }
    file.value = '';
  });
  // Capture the next key press for a binding (wherever the focus is while the dialog is open).
  const capture = (e: KeyboardEvent) => {
    if (!capturing) return;
    const key = keymap.eventKey(e);
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    if (key !== 'Escape') {
      const keys = keymap.keysOf(capturing.id).slice();
      keys[capturing.index] = key;
      keymap.setKeys(capturing.id, keys);
    }
    capturing = null;
    render();
  };
  window.addEventListener('keydown', capture, true);
  const close = d.close;
  d.close = () => {
    window.removeEventListener('keydown', capture, true);
    close();
  };
  render();
  search.focus();
  return d;
}

// ---------------------------------------------------------------- environment settings

export function settingsDialog(settings: SettingsStore): Dialog {
  const body = h('div');
  const render = () => {
    const s = settings.value;
    const check = (k: keyof Settings, name: string) =>
      h(
        'label.toggle.block',
        h('input', {
          type: 'checkbox',
          checked: s[k] as boolean,
          dataset: { setting: k },
          on: { change: (e) => settings.set(k, (e.target as HTMLInputElement).checked as never) },
        }),
        name,
      );
    const choice = <K extends keyof Settings>(
      k: K,
      name: string,
      options: Settings[K][],
      hint?: string,
    ) =>
      field(
        name,
        h(
          'select',
          {
            dataset: { setting: k },
            on: {
              change: (e) => {
                const raw = (e.target as HTMLSelectElement).value;
                settings.set(
                  k,
                  (typeof DEFAULT_SETTINGS[k] === 'number' ? Number(raw) : raw) as Settings[K],
                );
              },
            },
          },
          options.map((o) => h('option', { value: String(o), selected: o === s[k] }, String(o))),
        ),
        hint,
      );
    const num = (k: 'cornerReach' | 'rotationStep', name: string) =>
      field(
        name,
        h('input', {
          type: 'number',
          value: String(s[k]),
          dataset: { setting: k },
          on: {
            change: (e) =>
              settings.set(k, Number((e.target as HTMLInputElement).value) || DEFAULT_SETTINGS[k]),
          },
        }),
      );
    fill(
      body,
      h('h3', 'Window'),
      check('autoSwitchWorkspace', 'Selecting a view tab switches to its workspace'),
      check('homeAtStartup', 'Show Home at startup'),
      check('homeClosesOnOpen', 'Close Home when a file opens'),
      choice('displayMenuLabel', 'Display menu label', ['Show', 'Display']),
      choice('exportMenuLabel', 'Export submenu label', [
        'Export For Runtime',
        'Export Embedded File',
      ]),
      h('h3', 'Editing'),
      check('doubleClickMeshEdit', 'Double-click an ArtMesh to edit its mesh'),
      check('ancestorMenu', 'Right-click menus list the parent deformers'),
      check('lockLocksInspector', 'Locking an object also locks its Inspector fields'),
      choice(
        'meshList',
        'Ctrl+right-click lists',
        ['under-pointer', 'all'],
        'Which ArtMeshes the pop-up list shows',
      ),
      num('cornerReach', 'Transform box corner reach (px)'),
      num('rotationStep', 'Shift+drag rotation step (°)'),
      check('tips', 'Show tips at the point of action'),
      h('h3', 'Keys'),
      choice('macCtrl', 'On macOS, Ctrl in shortcuts means', ['command', 'control']),
      h('h3', 'Features'),
      h('div.hint', 'Off by default in this build. Projects that hold them open either way.'),
      check('featureGlue', 'Glue authoring'),
      check('featureBlendShapes', 'Blend-shape authoring'),
      h(
        'div.buttons',
        h('button', { on: { click: () => (settings.reset(), render()) } }, 'Reset all settings'),
      ),
    );
  };
  render();
  return dialog('Environment Settings', [body], { testid: 'settings' });
}

// ---------------------------------------------------------------- workspaces

export function workspaceDialog(dock: Dock): Dialog {
  const body = h('div');
  const render = () => {
    fill(
      body,
      dock.workspaces.map((w) => {
        const name = h('input', { value: w.name, disabled: w.builtIn });
        name.addEventListener('change', () => dock.renameWorkspace(w.id, name.value));
        return h(
          'div.workspace-row',
          { dataset: { workspace: w.id } },
          name,
          h(
            'button',
            { title: 'Up', on: { click: () => (dock.moveWorkspace(w.id, -1), render()) } },
            '↑',
          ),
          h(
            'button',
            { title: 'Down', on: { click: () => (dock.moveWorkspace(w.id, 1), render()) } },
            '↓',
          ),
          (['modeling', 'animation'] as const).map((k) =>
            h(
              'label.toggle',
              { title: `Selecting a ${k} view switches here` },
              h('input', {
                type: 'checkbox',
                checked: w.autoFor.includes(k),
                on: {
                  change: (e) => (
                    dock.setAutoFor(w.id, k, (e.target as HTMLInputElement).checked),
                    render()
                  ),
                },
              }),
              `${k[0]!.toUpperCase()}${k.slice(1)} views`,
            ),
          ),
          w.builtIn
            ? h('span.extra', 'preset')
            : h(
                'button.danger',
                { on: { click: () => (dock.deleteWorkspace(w.id), render()) } },
                'Delete',
              ),
        );
      }),
      h(
        'div.buttons',
        h(
          'button',
          {
            dataset: { testid: 'workspace-add' },
            on: {
              click: () => {
                dock.addWorkspace(`Workspace ${dock.workspaces.length + 1}`);
                render();
              },
            },
          },
          'Add (from the current layout)',
        ),
      ),
    );
  };
  render();
  return dialog('Workspace Settings', [body], { testid: 'workspaces' });
}

// ---------------------------------------------------------------- automatic mesh

/** Mochi Maker's presets for the automatic mesh (our own values). */
export const MESH_PRESETS: Record<
  string,
  { spacing: number; margin: number; tolerance: number; alphaThreshold: number }
> = {
  Standard: { spacing: 24, margin: 3, tolerance: 1.5, alphaThreshold: 8 },
  'Small deformation': { spacing: 40, margin: 3, tolerance: 2, alphaThreshold: 8 },
  'Large deformation': { spacing: 14, margin: 4, tolerance: 1, alphaThreshold: 8 },
};

/**
 * The automatic mesh dialog (Ctrl+Shift+A): it stays open without blocking the canvas, so other
 * meshes can be selected and meshed. Enter in any field applies to the selected ArtMeshes.
 */
export function autoMeshDialog(editor: Editor, tips: Tips): Dialog {
  const userPresets = store.get<typeof MESH_PRESETS>('mochi-maker.meshPresets') ?? {};
  const values = { ...MESH_PRESETS.Standard! };
  const inputs = new Map<keyof typeof values, HTMLInputElement>();
  const status = h('div.facts', { dataset: { testid: 'automesh-status' } });
  const warn = h('div.refusal', { dataset: { testid: 'automesh-warning' } });
  const selected = () =>
    editor.selection.uids
      .map((u) => editor.view.get(u))
      .filter((o): o is ArtMesh => o?.kind === 'artMesh');
  const check = () => {
    const meshes = selected();
    const keyed = meshes.filter((m) => m.rig.bindings.length > 0 || m.rig.keyforms.length > 1);
    warn.textContent = keyed.length
      ? `${keyed.map((m) => m.exportId).join(', ')} already ${keyed.length > 1 ? 'have' : 'has'} keyforms. Re-meshing carries them over, but shapes can change between the old vertices; check them after.`
      : '';
    status.textContent = meshes.length
      ? `Applies to ${meshes.length} ArtMesh(es): ${meshes
          .map((m) => m.exportId)
          .slice(0, 6)
          .join(', ')}${meshes.length > 6 ? '…' : ''}`
      : 'Select ArtMeshes on the canvas or in the Parts palette.';
  };
  const apply = async () => {
    const meshes = selected();
    if (meshes.length === 0) return check();
    const r = await editor.runItems(
      meshes.length > 1 ? `Automatic mesh (${meshes.length})` : 'Automatic mesh',
      meshes.map((m) => ({ name: 'mesh.regenerate', args: { target: m.uid, ...values } })),
    );
    if (r) {
      status.textContent = `Meshed ${meshes.length} ArtMesh(es).`;
      if (meshes.some((m) => m.rig.keyforms.length > 1))
        tips.tip(
          'automesh-keyforms',
          'Automatic meshing ran on ArtMeshes with keyforms: check their shapes, or undo.',
        );
    }
  };
  const row = (k: keyof typeof values, name: string, hint: string, step: number) => {
    const input = h('input', {
      type: 'number',
      step: String(step),
      value: String(values[k]),
      dataset: { testid: `automesh-${k}` },
    });
    input.addEventListener('change', () => (values[k] = Number(input.value)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        values[k] = Number(input.value);
        void apply();
      }
    });
    inputs.set(k, input);
    return field(name, input, hint);
  };
  const presetSel = h(
    'select',
    {
      on: {
        change: (e) => {
          const p = { ...MESH_PRESETS, ...userPresets }[(e.target as HTMLSelectElement).value];
          if (!p) return;
          Object.assign(values, p);
          for (const [k, i] of inputs) i.value = String(values[k]);
        },
      },
    },
    Object.keys({ ...MESH_PRESETS, ...userPresets }).map((n) => h('option', n)),
  );
  const offs = [editor.on('selection', check), editor.on('document', check)];
  const d = dialog(
    'Automatic Mesh',
    [
      field('Preset', presetSel),
      row('spacing', 'Vertex spacing (px)', 'Distance between vertices inside the outline', 1),
      row('margin', 'Margin (px)', 'How far the outline keeps outside the art', 1),
      row('tolerance', 'Outline tolerance (px)', 'How much the outline is simplified', 0.5),
      row(
        'alphaThreshold',
        'Transparency threshold',
        'Pixels at or above this alpha count. Raise it when faint stray pixels make the mesh too large.',
        1,
      ),
      warn,
      status,
      h(
        'div.hint',
        'Press Enter in any field to mesh the selection. The canvas stays usable: select other ArtMeshes and mesh them too.',
      ),
      h(
        'div.buttons',
        h(
          'button.primary',
          { dataset: { testid: 'automesh-apply' }, on: { click: () => void apply() } },
          'Apply',
        ),
        h(
          'button',
          {
            on: {
              click: async () => {
                const name = await askText('Save preset', 'Name of the preset');
                if (!name) return;
                userPresets[name] = { ...values };
                store.set('mochi-maker.meshPresets', userPresets);
                presetSel.append(h('option', name));
              },
            },
          },
          'Save preset…',
        ),
      ),
    ],
    { modal: false, testid: 'automesh', onClose: () => offs.forEach((f) => f()) },
  );
  check();
  inputs.get('spacing')!.focus();
  return d;
}

// ---------------------------------------------------------------- creating deformers

/**
 * Creating a warp or rotation deformer: the part, a name and ID, where it goes in the
 * hierarchy, a warp's grid and how it is sized, and a sequential mode that keeps the dialog open.
 * The selected objects move into it in place.
 */
export function createDeformerDialog(
  editor: Editor,
  kind: 'warp' | 'rotation',
  done: (uid: Uid) => void,
): Dialog {
  const v = editor.view;
  const sel = () =>
    editor.selection.uids
      .map((u) => v.get(u))
      .filter(
        (o): o is ArtMesh | Warp | Rotation =>
          o?.kind === 'artMesh' || o?.kind === 'warp' || o?.kind === 'rotation',
      );
  const first = sel()[0];
  const used = new Set([...v.all()].flatMap((o) => ('exportId' in o ? [o.exportId] : [])));
  const free = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}${n}`;
    return id;
  };
  const stem = first ? first.exportId.replace(/^(ArtMesh|Warp|Rotation)_?/, '') || 'Mesh' : 'New';
  const prefix = kind === 'warp' ? 'Warp' : 'Rotation';
  const id = h('input', { value: free(`${prefix}_${stem}`), dataset: { testid: 'deformer-id' } });
  const name = h('input', { value: '' });
  const part = h(
    'select',
    h('option', { value: '' }, 'none'),
    v
      .ofKind('part')
      .map((p) =>
        h(
          'option',
          { value: p.uid, selected: first && 'part' in first && first.part === p.uid },
          p.exportId,
        ),
      ),
  );
  const place = h(
    'select',
    { dataset: { testid: 'deformer-place' } },
    h('option', { value: 'parent' }, 'Parent of the selection'),
    h('option', { value: 'child' }, 'Child of the selected deformer'),
    h('option', { value: 'under' }, 'Under the deformer:'),
  );
  const under = h(
    'select',
    h('option', { value: '' }, 'none (canvas)'),
    v.project().deformerOrder.map((u) => h('option', { value: u }, label(v.get(u)))),
  );
  const rows = h('input', {
    type: 'number',
    value: '5',
    min: '1',
    max: '64',
    dataset: { testid: 'deformer-rows' },
  });
  const cols = h('input', {
    type: 'number',
    value: '5',
    min: '1',
    max: '64',
    dataset: { testid: 'deformer-cols' },
  });
  const sizing = h(
    'select',
    h('option', { value: 'keyforms' }, 'Fit around every keyform of the contents'),
    h('option', { value: 'pose' }, 'Fit around the selection at this pose'),
  );
  const margin = h('input', { type: 'number', value: '10', min: '0', step: '1' });
  const sequential = h('input', { type: 'checkbox' });
  const msg = h('div.refusal');

  const create = async () => {
    const objs = sel();
    const parents = new Set(objs.map((o) => (o.kind === 'artMesh' ? o.deformer : o.parent)));
    const selDeformer = objs.find((o) => o.kind !== 'artMesh') as Warp | Rotation | undefined;
    let parent: Uid | null;
    let contents: typeof objs;
    if (place.value === 'child') {
      if (!selDeformer) return void (msg.textContent = 'Select a deformer to put the new one in.');
      parent = selDeformer.uid;
      contents = [];
    } else if (place.value === 'under') {
      parent = under.value || null;
      contents = objs;
    } else {
      if (parents.size > 1)
        return void (msg.textContent =
          'The selection lies in different deformers: pick "Under the deformer" or select objects with one parent.');
      parent = parents.size ? [...parents][0]! : null;
      contents = objs;
    }
    // Bounds of the contents in the new deformer's parent space: their keyform values.
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (x: number, y: number) => {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    };
    for (const o of contents) {
      const forms =
        sizing.value === 'pose'
          ? (() => {
              const at = editor.cellAtPose(o.uid);
              return [o.rig.keyforms[at.ok ? at.index : 0]!];
            })()
          : o.rig.keyforms;
      for (const k of forms as unknown as Record<string, unknown>[]) {
        const pts = (k.positions ?? k.grid ?? [k.originX, k.originY]) as number[];
        for (let i = 0; i < pts.length; i += 2) add(pts[i]!, pts[i + 1]!);
      }
    }
    if (!Number.isFinite(x0)) {
      const c = v.project().canvas;
      [x0, y0, x1, y1] = parent
        ? [0.25, 0.25, 0.75, 0.75]
        : [c.width * 0.25, c.height * 0.25, c.width * 0.75, c.height * 0.75];
    }
    const [w, hh] = [Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3)];
    const m = Number(margin.value) / 100;
    const common = {
      exportId: id.value,
      ...(name.value ? { name: name.value } : {}),
      part: part.value || null,
      parent,
    };
    const createCall =
      kind === 'warp'
        ? {
            name: 'deformer.createWarp',
            args: {
              ...common,
              rows: Number(rows.value) || 5,
              cols: Number(cols.value) || 5,
              rect: {
                x: x0 - m * w,
                y: y0 - m * hh,
                width: (1 + 2 * m) * w,
                height: (1 + 2 * m) * hh,
              },
            },
          }
        : {
            name: 'deformer.createRotation',
            args: { ...common, origin: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } },
          };
    const r = await editor.runItems(
      kind === 'warp' ? 'Create warp deformer' : 'Create rotation deformer',
      [
        createCall,
        ...contents.map((o) =>
          o.kind === 'artMesh'
            ? { name: 'mesh.reparent', args: { target: o.uid, deformer: '$0' } }
            : { name: 'deformer.reparent', args: { target: o.uid, parent: '$0' } },
        ),
      ],
    );
    const uid = (r?.results[0] as { uid?: Uid } | undefined)?.uid;
    if (!uid) return;
    used.add(id.value);
    done(uid);
    if (sequential.checked) {
      id.value = free(`${prefix}_${stem}`);
      msg.textContent = `Created ${common.exportId}. Select the next objects and create again.`;
    } else d.close();
  };
  const d = dialog(
    kind === 'warp' ? 'Create Warp Deformer' : 'Create Rotation Deformer',
    [
      field('ID', id),
      field('Name', name),
      field('Part', part),
      field('Place', place),
      field('Deformer', under),
      kind === 'warp'
        ? [
            field('Grid rows', rows, 'Divisions of the deformation grid'),
            field('Grid columns', cols),
            field('Size', sizing),
            field('Margin (%)', margin),
          ]
        : field('Size', sizing),
      h('label.toggle.block', sequential, 'Sequential: keep this dialog open to make several'),
      msg,
      h(
        'div.buttons',
        h(
          'button.primary',
          { dataset: { testid: 'deformer-create' }, on: { click: () => void create() } },
          'Create',
        ),
        h('button', { on: { click: () => d.close() } }, 'Cancel'),
      ),
    ],
    { modal: false, testid: 'create-deformer' },
  );
  return d;
}

// ---------------------------------------------------------------- parameters

export function createParameterDialog(editor: Editor, tips: Tips): Dialog {
  const name = h('input', { placeholder: 'Angle X', dataset: { testid: 'param-name' } });
  const id = h('input', { placeholder: 'ParamAngleX', dataset: { testid: 'param-id' } });
  const min = h('input', { type: 'number', value: '-30', dataset: { testid: 'param-min' } });
  const def = h('input', { type: 'number', value: '0', dataset: { testid: 'param-default' } });
  const max = h('input', { type: 'number', value: '30', dataset: { testid: 'param-max' } });
  const loop = h('input', { type: 'checkbox' });
  const blend = h('input', { type: 'checkbox' });
  const warn = h('div.refusal', { dataset: { testid: 'param-warning' } });
  // The standard parameters, in their usual groups.
  const used = new Set(editor.view.ofKind('parameter').map((x) => x.exportId));
  const standard = h(
    'select',
    { dataset: { testid: 'param-standard' } },
    h('option', { value: '' }, 'Custom (type an ID)'),
    STANDARD_SECTIONS.map((sec) =>
      h(
        'optgroup',
        { label: sec },
        STANDARD_PARAMETERS.filter((x) => x.section === sec).map((x) =>
          h(
            'option',
            { value: x.id, disabled: used.has(x.id), title: x.meaning },
            `${x.id} · ${x.name}${x.optional ? ' (optional)' : ''}${used.has(x.id) ? ' · in use' : ''}`,
          ),
        ),
      ),
    ),
  );
  const meaning = h('div.hint', { dataset: { testid: 'param-meaning' } });
  const note = h('div.hint', { dataset: { testid: 'param-standard-note' } });
  const groupCheck = h('input', {
    type: 'checkbox',
    checked: true,
    dataset: { testid: 'param-group-check' },
  });
  const groupLabel = h('span');
  // Shown by style: the class's display would override the hidden attribute.
  const groupRow = h('label.toggle.block', { style: 'display:none' }, groupCheck, groupLabel);
  const GROUP_TEXT = {
    eyeBlink: 'Add to the Eye blink group (apps blink it)',
    lipSync: "Add to the Lip sync group (apps open it with a voice's level)",
  } as const;
  /** The state of the fields against the standard list: notes, warnings, the group offer. */
  /** The standard parameter picked from the list, to notice its ID being changed. */
  let picked: string | null = null;
  const refresh = () => {
    const sp = standardParameter(id.value);
    standard.value = sp && !used.has(sp.id) ? sp.id : '';
    meaning.textContent = sp ? sp.meaning : '';
    // The standard range and the documented variants are quiet; a range outside them,
    // or the ID of a picked standard parameter changed, is a warning.
    const range = sp
      ? standardRange(sp.id, Number(min.value), Number(def.value), Number(max.value))
      : undefined;
    note.className = 'hint';
    note.textContent = '';
    if (sp) {
      note.textContent = STANDARD_ID_NOTE;
      if (range === 'variant')
        note.textContent += ` This range is also a usual one: ${sp.variants}.`;
      if (range === 'other') {
        note.className = 'refusal';
        note.textContent += ` This range is neither the standard ${sp.min} / ${sp.default} / ${sp.max}${sp.variants ? ` nor another usual one (${sp.variants})` : ''}.`;
      }
    } else if (picked && id.value !== picked) {
      note.className = 'refusal';
      note.textContent = `${STANDARD_ID_NOTE} This is no longer the standard ID ${picked}.`;
    }
    const lines: string[] = [];
    if (id.value.includes('@'))
      lines.push('An "@" in a parameter ID can block motion export in other tools.');
    const near = caseOnlyStandard(id.value);
    if (near)
      lines.push(
        `"${id.value}" differs from the standard ID ${near} only by letter case: apps will not recognize it. Use ${near}, or a clearly different ID.`,
      );
    if (used.has(id.value)) lines.push(`This model already has a parameter ${id.value}.`);
    warn.textContent = lines.join(' ');
    groupRow.style.display = sp?.group ? '' : 'none';
    if (sp?.group) groupLabel.textContent = GROUP_TEXT[sp.group];
  };
  standard.addEventListener('change', () => {
    const sp = standardParameter(standard.value);
    picked = sp?.id ?? null;
    if (!sp) return refresh();
    id.value = sp.id;
    name.value = sp.name;
    min.value = String(sp.min);
    def.value = String(sp.default);
    max.value = String(sp.max);
    groupCheck.checked = true;
    refresh();
  });
  for (const el of [id, min, def, max]) el.addEventListener('input', refresh);
  const d = dialog(
    'New Parameter',
    [
      field('Standard', standard),
      meaning,
      field('Name', name),
      field('ID', id),
      field('Minimum', min),
      field('Default', def),
      field('Maximum', max),
      note,
      groupRow,
      h('label.toggle.block', loop, 'Loops (the ends meet, as for a full turn)'),
      // Blend-shape parameters only where blend-shape authoring is on in this build.
      editor.features.blendShapes
        ? h('label.toggle.block', blend, 'Blend Shape (its keys add a shape on top)')
        : null,
      warn,
      h(
        'div.hint',
        'Pick a standard parameter to fill in its ID and range: apps, motions and face tracking find parameters by these IDs.',
      ),
      h(
        'div.buttons',
        h(
          'button.primary',
          {
            dataset: { testid: 'param-create-ok' },
            on: {
              click: () => {
                const [a, b, c] = [Number(min.value), Number(def.value), Number(max.value)];
                if (id.value.includes('@'))
                  tips.warn(
                    'at-in-id',
                    `"${id.value}" contains "@", which can block motion export.`,
                  );
                const near = caseOnlyStandard(id.value);
                if (near)
                  tips.warn(
                    'case-standard-id',
                    `"${id.value}" differs from the standard ID ${near} only by letter case.`,
                  );
                const calls: { name: string; args: unknown }[] = [
                  {
                    name: 'param.create',
                    args: {
                      ...(id.value ? { exportId: id.value } : {}),
                      ...(name.value ? { name: name.value } : {}),
                      min: a,
                      max: c,
                      default: b,
                      keys: [],
                      repeat: loop.checked,
                      type: blend.checked ? 'blendShape' : 'normal',
                    },
                  },
                ];
                // Eye blink and Lip sync membership, for the parameters apps drive that way.
                const sp = standardParameter(id.value);
                if (sp?.group && groupCheck.checked) {
                  const groups = editor.view.project().standardGroups;
                  calls.push({
                    name: 'meta.setStandardGroups',
                    args: { [sp.group]: [...groups[sp.group], `@param:${sp.id}`] },
                  });
                }
                const r = editor.transact('New parameter', calls);
                if (r) d.close();
              },
            },
          },
          'Create',
        ),
      ),
    ],
    { testid: 'new-parameter' },
  );
  standard.focus();
  return d;
}

/** New Parameter Group: a folder of the Parameter palette, standard IDs offered. */
export function createParameterGroupDialog(editor: Editor): Dialog {
  const used = new Set(editor.view.ofKind('parameterGroup').map((x) => x.exportId));
  const name = h('input', { placeholder: 'Face', dataset: { testid: 'group-name' } });
  const id = h('input', { placeholder: 'ParamGroupFace', dataset: { testid: 'group-id' } });
  const warn = h('div.refusal', { dataset: { testid: 'group-warning' } });
  const standard = h(
    'select',
    { dataset: { testid: 'group-standard' } },
    h('option', { value: '' }, 'Custom (type an ID)'),
    STANDARD_PARAMETER_GROUPS.map((g) =>
      h(
        'option',
        { value: g.id, disabled: used.has(g.id) },
        `${g.id} · ${g.name}${used.has(g.id) ? ' · in use' : ''}`,
      ),
    ),
  );
  const refresh = () => {
    const near = caseOnlyStandard(id.value);
    warn.textContent = near
      ? `"${id.value}" differs from the standard ID ${near} only by letter case.`
      : used.has(id.value)
        ? `This model already has a group ${id.value}.`
        : '';
  };
  standard.addEventListener('change', () => {
    const g = STANDARD_PARAMETER_GROUPS.find((x) => x.id === standard.value);
    if (!g) return;
    id.value = g.id;
    name.value = g.name;
    refresh();
  });
  id.addEventListener('input', refresh);
  const d = dialog(
    'New Parameter Group',
    [
      field('Standard', standard),
      field('Name', name),
      field('ID', id),
      warn,
      h(
        'div.buttons',
        h(
          'button.primary',
          {
            dataset: { testid: 'group-create-ok' },
            on: {
              click: () => {
                const r = editor.transact('New parameter group', [
                  {
                    name: 'paramGroup.create',
                    args: {
                      ...(id.value ? { exportId: id.value } : {}),
                      ...(name.value ? { name: name.value } : {}),
                    },
                  },
                ]);
                if (r) d.close();
              },
            },
          },
          'Create',
        ),
      ),
    ],
    { testid: 'new-parameter-group' },
  );
  standard.focus();
  return d;
}

/** Key editing (double-click a parameter's name): type exact key values, or click on a scale. */
export function keysDialog(editor: Editor, uid: Uid): Dialog {
  const p = editor.view.getAs(uid, 'parameter') as Parameter;
  const keys = h('input', {
    value: p.keys.map((k) => round(k, 4)).join(', '),
    dataset: { testid: 'keys-input' },
  });
  const scale = h('div.key-scale', { title: 'Click to add a key here' });
  const render = () => {
    const ks = parse();
    fill(
      scale,
      ks.map((k) =>
        h('span.key-mark', { style: `left:${(100 * (k - p.min)) / (p.max - p.min || 1)}%` }, '◆'),
      ),
    );
  };
  const parse = () =>
    keys.value
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x));
  scale.addEventListener('click', (e) => {
    const r = scale.getBoundingClientRect();
    const at = p.min + ((e.clientX - r.left) / r.width) * (p.max - p.min);
    // Clicks snap to a tenth of the range, so keys land on tidy values.
    const tenth = (p.max - p.min) / 10 || 1;
    const k = Math.round(at / tenth) * tenth;
    keys.value = [...new Set([...parse(), Number(k.toFixed(6))])].sort((a, b) => a - b).join(', ');
    render();
  });
  keys.addEventListener('input', render);
  const d = dialog(
    `Keys of ${p.name || p.exportId}`,
    [
      field('Keys', keys, 'Values separated by commas'),
      h('div.key-scale-wrap', h('span', round(p.min)), scale, h('span', round(p.max))),
      h(
        'div.buttons',
        h(
          'button.primary',
          {
            dataset: { testid: 'keys-ok' },
            on: {
              click: () => {
                const r = editor.transact('Parameter keys', [
                  {
                    name: 'param.setKeys',
                    args: { target: p.uid, keys: [...new Set(parse())].sort((a, b) => a - b) },
                  },
                ]);
                if (r) d.close();
              },
            },
          },
          'OK',
        ),
        h('button', { on: { click: () => d.close() } }, 'Cancel'),
      ),
    ],
    { testid: 'keys' },
  );
  render();
  return d;
}

// ---------------------------------------------------------------- texture atlas

export function atlasDialog(editor: Editor): Dialog {
  const s = editor.view.project().exportSettings;
  const size = h(
    'select',
    { dataset: { testid: 'atlas-size' } },
    [1024, 2048, 4096, 8192].map((n) =>
      h('option', { value: String(n), selected: n === s.atlasSize }, `${n} × ${n}`),
    ),
  );
  const layers = editor.view.ofKind('layer').length;
  const meshes = editor.view.ofKind('artMesh').length;
  const d = dialog(
    'Texture Atlas',
    [
      h(
        'div.facts',
        `Mochi Maker packs the atlas for you on every export: ${meshes} ArtMesh(es) over ${layers} layer(s). `,
        'Pages are square, the safe choice for every app. Press T on the canvas to see them.',
      ),
      field('Page size', size),
      h(
        'div.buttons',
        h(
          'button.primary',
          {
            on: {
              click: () => {
                const r = editor.transact('Atlas size', [
                  { name: 'project.setExportSettings', args: { atlasSize: Number(size.value) } },
                ]);
                if (r) d.close();
              },
            },
          },
          'OK',
        ),
      ),
    ],
    { testid: 'atlas' },
  );
  return d;
}

export { TERM };
