/**
 * Mochi Maker's editor (roadmap M6): a web app over the command layer. Its frame follows the
 * familiar conventions of model editors, with Mochi Maker's own
 * visual design: a menu bar, a toolbar with the workspace switcher at its left end, the View
 * area in the middle with its tabs and the draw-order strip, and dockable palettes around it,
 * laid out per workspace.
 */
import { zipSync } from 'fflate';
import { LIMITS, type ArtMesh, type Rotation, type Uid, type Warp } from '@mochi-maker/core';
import { readZip } from '@mochi-maker/art';
import { fileBytes, folderBytes } from './limits.js';
import { exportModel, importReportText, MODEL_IMPORT_NOTICE } from '@mochi-maker/export';
import { Editor, type EditLevel } from './editor.js';
import { Viewport, type Tool } from './viewport.js';
import {
  AgentsPalette,
  ArtPalette,
  DeformerPalette,
  DrawOrderPalette,
  HistoryPalette,
  Inspector,
  LogPalette,
  ParameterPalette,
  PartsPalette,
  PreviewPalette,
  ProjectPalette,
  ToolDetails,
  ValidationPalette,
  label,
  popupMenu,
  type MenuItem,
  type PaletteContext,
} from './panels.js';
import { CommandBar } from './commandbar.js';
import { Playback, ScenePalette, TimelinePalette } from './timeline.js';
import { TemplatePalette } from './templates.js';
import { guidePartsOf, saveSnapshotAsGuide } from './guides.js';
import { ObjectClipboard } from './clipboard.js';
import { DesktopFiles, desktopApi, type DesktopApi } from './desktop.js';
import { AgentSurface } from './agent.js';
import { Offscreen } from './offscreen.js';
import { findReplaceDialog } from './findreplace.js';
import {
  applyTemplateDialog,
  exportTemplateDialog,
  lastPreview,
  type TemplatePreview,
} from './modeltemplate.js';
import { exportPsd, type PsdResult } from './psd.js';
import { motionSyncDialog } from './motionsync.js';
import {
  movieDialog,
  renderMovie,
  videoSupport,
  type MovieResult,
  type MovieSettings,
} from './movie.js';
import { BridgeHost } from './host.js';
import { AgentAccess } from './access.js';
import { LiveLink, canLink } from './livelink.js';
import { Dock } from './dock.js';
import { Keymap, type Action } from './keymap.js';
import { SettingsStore, store } from './settings.js';
import { Tips } from './tips.js';
import { ViewTabs } from './tabs.js';
import { DrawOrderSlider } from './drawslider.js';
import { outsideParents } from './checks.js';
import { PhysicsDialog } from './physics.js';
import { ExpressionPalette } from './expressions.js';
import {
  askText,
  atlasDialog,
  autoMeshDialog,
  createDeformerDialog,
  createParameterDialog,
  createParameterGroupDialog,
  dialog,
  homeDialog,
  keysDialog,
  settingsDialog,
  shortcutsDialog,
  workspaceDialog,
  type Dialog,
} from './dialogs.js';
import { fill, h } from './dom.js';
import './style.css';

declare global {
  interface Window {
    mochi: AgentSurface;
    /** The desktop build's preload API (absent in a browser). */
    mochiDesktop?: DesktopApi;
    mochiEditor: {
      editor: Editor;
      viewport: Viewport;
      offscreen: Offscreen;
      host: BridgeHost;
      access: AgentAccess;
      link: LiveLink;
      dock: Dock;
      keymap: Keymap;
      settings: SettingsStore;
      tabs: ViewTabs;
      playback: Playback;
      timeline: TimelinePalette;
      clipboard: ObjectClipboard;
      desktop: DesktopFiles | null;
      psd(): Promise<PsdResult>;
      templatePreview(): TemplatePreview | null;
      movie: {
        render(s: MovieSettings): Promise<MovieResult>;
        support(): Promise<{ webm: string | null; mp4: string | null }>;
      };
      templates: TemplatePalette;
      physics: PhysicsDialog;
      expressions: ExpressionPalette;
      parts: PartsPalette;
      openFiles(files: Record<string, Uint8Array>, name?: string): Promise<void>;
    };
  }
}

const settings = new SettingsStore();
/** Glue and blend-shape authoring, from the settings' Features (off by default in this build). */
const featuresOf = (v: typeof settings.value) => ({
  glue: v.featureGlue,
  blendShapes: v.featureBlendShapes,
});
const editor = new Editor(featuresOf(settings.value));
settings.on('change', (v) => editor.setFeatures(featuresOf(v)));
const app = document.getElementById('app')!;

const status = h('div.status', { dataset: { testid: 'status' } });
const viewArea = h('main.view-area');
const viewBody = h('div.view-body');
const viewport = new Viewport(editor, viewBody);
viewport.settings = settings;
const keymap = new Keymap(settings);
viewport.keymap = keymap;
const tips = new Tips(editor, settings);
const agent = new AgentSurface(editor, viewport);
// Set once the off-screen view exists (below).
const commandBar = new CommandBar(editor, agent);
const offscreen = new Offscreen(editor.assets);
agent.movie = (s) => renderMovie(editor, offscreen, s);
editor.on('project', () => offscreen.reset(editor.assets));
const host = new BridgeHost(editor, agent, viewport, offscreen);
const link = new LiveLink(editor);
/** The desktop build's file handling; null in the browser. */
const desktopApiNow = desktopApi();
const desktop = desktopApiNow ? new DesktopFiles(editor, desktopApiNow, link) : null;
const access = new AgentAccess(editor, host);
const dock = new Dock(viewArea);
const tabs = new ViewTabs(editor, viewport, dock, settings);
const drawStrip = new DrawOrderSlider(editor);
const playback = new Playback(editor);
playback.viewport = viewport;
playback.active = () => dock.activeId === 'animation';
// Leaving or entering the Animation workspace turns physics scrubbing off or on.
dock.on('workspace', () => playback.seek(playback.time));
const physics = new PhysicsDialog(editor, viewport, tips);

// ---------------------------------------------------------------- files

const folderInput = h('input', {
  type: 'file',
  hidden: true,
  webkitdirectory: true,
  multiple: true,
  dataset: { testid: 'open-folder' },
});
const zipInput = h('input', {
  type: 'file',
  hidden: true,
  accept: '.zip',
  dataset: { testid: 'open-zip' },
});
const reimportInput = h('input', {
  type: 'file',
  hidden: true,
  accept: '.psd,.ora,.png',
  dataset: { testid: 'reimport-art' },
});
reimportInput.addEventListener('change', async () => {
  const file = reimportInput.files?.[0];
  if (file) await link.reimportFile(file);
  reimportInput.value = '';
});
const linkChip = h('span.link-chip', { dataset: { testid: 'link-status' } });
link.on('status', (st) => {
  linkChip.hidden = !st.watching;
  linkChip.textContent = st.watching ? `Linked: ${st.file}` : '';
  linkChip.title = st.error ?? 'Re-imports the file when it is saved';
});
linkChip.hidden = true;
const artInput = h('input', {
  type: 'file',
  hidden: true,
  accept: '.psd,.ora,.png',
  dataset: { testid: 'import-art' },
});

let savedRevision = 0;
let home: Dialog | null = null;
const closeHomeOnOpen = () => {
  if (settings.value.homeClosesOnOpen) {
    home?.close();
    home = null;
  }
};
const remember = (name: string) =>
  store.set(
    'mochi-maker.recent',
    [name, ...(store.get<string[]>('mochi-maker.recent') ?? []).filter((n) => n !== name)].slice(
      0,
      10,
    ),
  );
editor.on('project', () => {
  savedRevision = editor.session.revision;
});

async function openFileList(files: File[]): Promise<void> {
  try {
    let map: Map<string, Uint8Array>;
    const one = files.length === 1 ? files[0]! : undefined;
    if (one && one.name.toLowerCase().endsWith('.zip'))
      map = await readZip(one.name, await fileBytes(one), LIMITS.projectArchive);
    else map = await folderBytes(files, LIMITS.projectArchive, 'The project folder');
    await editor.openFiles(map);
    remember(editor.name);
    closeHomeOnOpen();
    editor.emit('message', { level: 'info', text: `Opened ${editor.name}.` });
  } catch (e) {
    editor.report(e);
  }
}
folderInput.addEventListener('change', () => void openFileList([...(folderInput.files ?? [])]));

// ---------------------------------------------------------------- model import

const modelInput = h('input', {
  type: 'file',
  hidden: true,
  webkitdirectory: true,
  multiple: true,
  dataset: { testid: 'import-model' },
});
const NOTICE_SEEN = 'mochi-maker.modelImportNotice';
/** The notice, the first time a model is imported in this editor; then the folder dialog. */
function importModelCommand(): void {
  const pickFolder = () =>
    desktop
      ? void desktop
          .pickModel()
          .then((files) => files && importModelFiles(files, true))
          .catch((e) => editor.report(e))
      : modelInput.click();
  if (store.get<boolean>(NOTICE_SEEN)) return pickFolder();
  const d = dialog(
    'Import Model',
    [
      h('p.notice', { dataset: { testid: 'model-notice' } }, MODEL_IMPORT_NOTICE),
      h(
        'div.buttons',
        h(
          'button.primary',
          {
            dataset: { testid: 'model-notice-ok' },
            on: {
              click: () => {
                store.set(NOTICE_SEEN, true);
                d.close();
                pickFolder();
              },
            },
          },
          'Got it',
        ),
      ),
    ],
    { testid: 'model-notice-dialog' },
  );
}
let importReport: Dialog | null = null;
/** Opens a model folder's files as a new project, and shows the import report. */
async function importModelFiles(
  files: Map<string, Uint8Array>,
  fromDesktop = false,
): Promise<void> {
  try {
    const r = await editor.importModel(files);
    if (fromDesktop) desktop?.imported();
    closeHomeOnOpen();
    editor.emit('message', { level: 'info', text: `Imported ${editor.name}.` });
    // One report at a time: a new import's report replaces the last one if it is still open.
    importReport?.close();
    importReport = dialog(
      'Import Report',
      [
        h(
          'pre.import-report',
          { dataset: { testid: 'import-report' } },
          importReportText(r.report),
        ),
        h(
          'p.dim',
          'The project is a reconstruction of the model and is not saved yet. Keep the original files.',
        ),
      ],
      { testid: 'import-report-dialog', wide: true },
    );
  } catch (e) {
    editor.report(e);
  }
}
modelInput.addEventListener('change', async () => {
  const files = [...(modelInput.files ?? [])];
  modelInput.value = '';
  let map: Map<string, Uint8Array>;
  try {
    map = await folderBytes(files, LIMITS.model, 'The model folder');
  } catch (e) {
    return editor.report(e);
  }
  await importModelFiles(map);
});
zipInput.addEventListener('change', () => void openFileList([...(zipInput.files ?? [])]));

/** Imports an art file into the open model (a new mesh per layer). */
async function importArt(file: File): Promise<void> {
  const path = `import/${file.name}`;
  closeHomeOnOpen();
  try {
    await editor.fs.writeBytes(path, await fileBytes(file));
    await agent.run(`Import ${file.name}`, [{ name: 'art.import', args: { path } }], {
      author: 'person',
    });
  } catch (e) {
    editor.report(e);
  }
}
artInput.addEventListener('change', async () => {
  const file = artInput.files?.[0];
  if (file) await importArt(file);
  artInput.value = '';
});

/**
 * A dropped art file: into an empty model it is imported; when a model is open, a
 * dialog asks whether to add it, replace the art that is loaded (re-import), or start a new model.
 */
function artDropped(file: File): void {
  if (editor.view.ofKind('artMesh').length === 0) return void importArt(file);
  const d = dialog(
    `Import ${file.name}`,
    [
      h('div.facts', 'A model is open. How should this file be used?'),
      h(
        'div.buttons.column',
        h(
          'button.primary',
          { on: { click: () => (d.close(), void importArt(file)) } },
          'Add new ArtMeshes to the open model',
        ),
        h(
          'button',
          { on: { click: () => (d.close(), void link.reimportFile(file)) } },
          'Replace the art that is loaded (re-import)',
        ),
        h(
          'button',
          {
            on: {
              click: () => {
                d.close();
                editor.newProject();
                void importArt(file);
              },
            },
          },
          'A new model from it',
        ),
      ),
    ],
    { testid: 'import-choice' },
  );
}

async function save(name = editor.name): Promise<void> {
  try {
    const files = await editor.saveFiles();
    const tree: Record<string, Uint8Array> = {};
    for (const [p, b] of files) tree[`${name}.mochi/${p}`] = b;
    download(zipSync(tree, { level: 6 }), `${name}.mochi.zip`, 'application/zip');
    savedRevision = editor.session.revision;
    editor.emit('message', { level: 'info', text: `Saved ${name}.mochi.zip.` });
  } catch (e) {
    editor.report(e);
  }
}

/** The PSD of the pose (Ctrl+P): into a folder on the desktop, a download in a browser. */
async function savePsd(): Promise<void> {
  try {
    editor.emit('message', { level: 'info', text: 'Rendering the PSD of the pose…' });
    const r = await exportPsd(editor, offscreen);
    const name = `${editor.name || 'model'}-pose.psd`;
    const text = `${name}: ${r.width} × ${r.height}, ${r.layers.length} layers`;
    if (desktop) {
      const out = await desktop.api.exportToFolder([[name, r.bytes]]);
      if (out) editor.emit('message', { level: 'info', text: `Exported ${text} to ${out.dir}.` });
      return;
    }
    download(r.bytes, name, 'image/vnd.adobe.photoshop');
    editor.emit('message', { level: 'info', text: `Exported ${text}.` });
  } catch (e) {
    editor.report(e);
  }
}

/** Saves an image sequence or video: a folder on the desktop; a zip or the video in a browser. */
async function saveMovie(r: MovieResult): Promise<void> {
  const files = [...r.files];
  const what =
    r.format === 'png'
      ? `${r.frames} frames`
      : `${r.name} (${r.frames} frames${r.alpha ? ', with alpha' : ''})`;
  if (desktop) {
    const out = await desktop.api.exportToFolder(files);
    if (out) editor.emit('message', { level: 'info', text: `Exported ${what} to ${out.dir}.` });
    return;
  }
  if (r.format === 'png')
    download(
      zipSync(Object.fromEntries(files.map(([p, b]) => [`${r.name}/${p}`, b])), { level: 0 }),
      `${r.name}.zip`,
      'application/zip',
    );
  else download(files[0]![1], r.name, r.format === 'webm' ? 'video/webm' : 'video/mp4');
  editor.emit('message', { level: 'info', text: `Exported ${what}.` });
}

function download(bytes: Uint8Array, name: string, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** File › Export For Runtime: the .moc3 set, or the motion files, as a zip. */
async function exportRuntime(only?: 'motions'): Promise<void> {
  try {
    const r = await exportModel(editor.doc, editor.assets, { features: editor.features });
    const tree: Record<string, Uint8Array> = {};
    for (const [p, b] of r.files) if (!only || p.endsWith('.motion3.json')) tree[p] = b;
    if (Object.keys(tree).length === 0)
      return editor.emit('message', { level: 'error', text: 'There are no motions to export.' });
    const stem = editor.view.project().exportSettings.fileStem;
    download(
      zipSync(tree, { level: 6 }),
      `${stem}${only ? '-motions' : ''}.zip`,
      'application/zip',
    );
    for (const p of r.report.problems)
      editor.emit('message', {
        level: p.severity === 'error' ? 'error' : 'warning',
        text: `Export: ${p.message}`,
      });
    editor.emit('message', {
      level: 'info',
      text: `Exported version ${r.report.mocVersion}: ${Object.keys(tree).length} files.`,
    });
  } catch (e) {
    editor.report(e);
  }
}

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length === 1 && /\.(psd|ora|png)$/i.test(files[0]!.name)) artDropped(files[0]!);
  else if (files.length) void openFileList(files);
});
window.addEventListener('beforeunload', (e) => {
  // Forgetting to save loses the work (physics included): the browser asks first. The desktop
  // build keeps auto-saved copies instead, and a prompt there would only block closing.
  if (!desktop && editor.session.revision !== savedRevision) e.preventDefault();
});

// ---------------------------------------------------------------- selection helpers

const sel = () =>
  editor.selection.uids.map((u) => editor.view.get(u)).filter((o) => o !== undefined);
const deformers = () =>
  sel().filter((o): o is Warp | Rotation => o.kind === 'warp' || o.kind === 'rotation');

/** Objects to lock or hide for "everything else": leaves outside the selection. */
function others(): Uid[] {
  const chosen = new Set(editor.selection.uids);
  const inside = (u: Uid) =>
    [...chosen].some((c) => c === u || viewport.inPart(u, c) || viewport.inDeformer(u, c));
  const v = editor.view;
  return [...v.ofKind('artMesh'), ...v.ofKind(['warp', 'rotation'])]
    .map((o) => o.uid)
    .filter((u) => !inside(u));
}

function deleteSelection(ask: boolean): void {
  const v = editor.view;
  const m = editor.selectedMesh();
  if (editor.meshEdit && m && editor.selection.vertices.length) {
    editor.transact('Delete vertices', [
      { name: 'mesh.deleteVertices', args: { target: m.uid, vertices: editor.selection.vertices } },
    ]);
    return;
  }
  const objs = sel();
  if (objs.length === 0) return;
  if (ask && !confirm(`Delete ${objs.length === 1 ? label(objs[0]) : `${objs.length} objects`}?`))
    return;
  const calls: { name: string; args: unknown }[] = [];
  for (const o of objs)
    if (o.kind === 'artMesh')
      calls.push({ name: 'mesh.delete', args: { target: o.uid, cascade: true } });
  // A deformer's remaining children move to its parent in place (converted), then it goes.
  for (const o of deformers()) calls.push({ name: 'deformer.remove', args: { target: o.uid } });
  for (const o of objs)
    if (o.kind === 'part')
      calls.push({ name: 'part.delete', args: { target: o.uid, cascade: true } });
    else if (o.kind === 'parameter') calls.push({ name: 'param.delete', args: { target: o.uid } });
  void editor
    .runItems(
      objs.length === 1 ? `Delete ${label(objs[0])}` : `Delete ${objs.length} objects`,
      calls,
    )
    .then((r) => {
      if (r && !ask)
        tips.tip(
          'palette-delete',
          'Delete removes the selection at once, without asking. Ctrl+Z brings it back.',
        );
    });
}

/** Ctrl+Delete: a deformer with everything inside it. */
function deleteWithContents(): void {
  const ds = deformers();
  if (ds.length === 0)
    return void editor.emit('message', { level: 'error', text: 'Select a deformer.' });
  const v = editor.view;
  const calls: { name: string; args: unknown }[] = [];
  for (const d of ds) {
    for (const m of v.ofKind('artMesh'))
      if (viewport.inDeformer(m.uid, d.uid))
        calls.push({ name: 'mesh.delete', args: { target: m.uid, cascade: true } });
    const inner = v.project().deformerOrder.filter((u) => {
      let p = (v.get(u) as Warp | Rotation).parent;
      while (p) {
        if (p === d.uid) return true;
        p = (v.get(p) as Warp | Rotation | undefined)?.parent ?? null;
      }
      return false;
    });
    for (const u of inner.reverse())
      calls.push({ name: 'deformer.delete', args: { target: u, cascade: true } });
    calls.push({ name: 'deformer.delete', args: { target: d.uid, cascade: true } });
  }
  void editor.runItems('Delete deformer with contents', calls);
}

/** Adds keys at the ends (and the middle) of a parameter's range to the selected objects. */
function addKeys(param: Uid, count: 2 | 3): void {
  const p = editor.view.getAs(param, 'parameter');
  const want = count === 2 ? [p.min, p.max] : [p.min, (p.min + p.max) / 2, p.max];
  const keys = [...new Set([...p.keys, ...want])].sort((a, b) => a - b);
  const calls: { name: string; args: unknown }[] = [];
  if (keys.length !== p.keys.length)
    calls.push({ name: 'param.setKeys', args: { target: p.uid, keys } });
  for (const o of sel()) {
    if (!('rig' in o)) continue;
    const b = (o.rig as { bindings: { parameter: Uid; keys: number[] }[] }).bindings.find(
      (x) => x.parameter === p.uid,
    );
    if (!b)
      calls.push({ name: 'rig.addBinding', args: { target: o.uid, parameter: p.uid, keys: want } });
    else
      for (const k of want)
        if (!b.keys.includes(k))
          calls.push({ name: 'rig.addKey', args: { target: o.uid, parameter: p.uid, key: k } });
  }
  if (calls.length === 0)
    return void editor.emit('message', { level: 'info', text: 'Those keys are already there.' });
  editor.transact(`Add ${count} keys`, calls);
}

/** Copy and paste of a shape (Ctrl+Shift+C / V): the keyform at the pose. */
let shapeClip: {
  uid: Uid;
  cell: Record<Uid, number>;
  values: Record<string, unknown>;
  kind: string;
  n: number;
} | null = null;
function copyShape(): void {
  const o = editor.selection.uid ? editor.view.get(editor.selection.uid) : undefined;
  if (!o || !('rig' in o)) return;
  const at = editor.cellAtPose(o.uid);
  if (!at.ok) return void editor.emit('message', { level: 'error', text: at.reason });
  const k = structuredClone((o.rig as { keyforms: Record<string, unknown>[] }).keyforms[at.index]!);
  delete k.authored;
  const n = o.kind === 'artMesh' ? o.uv.length : 0;
  shapeClip = { uid: o.uid, cell: at.cell, values: k, kind: o.kind, n };
  editor.emit('message', { level: 'info', text: `Copied the shape of ${label(o)}.` });
}
function pasteShape(): void {
  const o = editor.selection.uid ? editor.view.get(editor.selection.uid) : undefined;
  if (!o || !shapeClip || !('rig' in o)) return;
  const at = editor.cellAtPose(o.uid);
  if (!at.ok) return void editor.emit('message', { level: 'error', text: at.reason });
  if (o.uid === shapeClip.uid)
    return void editor.transact('Paste shape', [
      { name: 'keyform.copy', args: { target: o.uid, from: shapeClip.cell, to: at.cell } },
    ]);
  if (o.kind !== shapeClip.kind || (o.kind === 'artMesh' && o.uv.length !== shapeClip.n))
    return void editor.emit('message', {
      level: 'error',
      text: 'Paste a shape onto the same object, or one of the same kind and size.',
    });
  const values = { ...shapeClip.values } as Record<string, unknown>;
  const pairs = (a: unknown) => {
    const x = a as number[];
    const out: [number, number][] = [];
    for (let i = 0; i < x.length; i += 2) out.push([x[i]!, x[i + 1]!]);
    return out;
  };
  if (values.positions) values.positions = pairs(values.positions);
  if (values.grid) values.grid = pairs(values.grid);
  editor.transact('Paste shape', [
    {
      name: 'keyform.set',
      args: { target: o.uid, ...(o.rig.bindings.length ? { cell: at.cell } : {}), values },
    },
  ]);
}

/** Lock Default Forms: edits at the default form of a keyed object are refused. */
editor.guard = (calls) => {
  for (const c of calls) {
    const a = c.args as {
      target?: string;
      cell?: Record<string, number>;
      to?: Record<string, number>;
      all?: boolean;
    };
    if (
      !['keyform.set', 'mesh.moveVertices', 'keyform.copy'].includes(c.name) ||
      !a?.target ||
      a.all
    )
      continue;
    const o = editor.view.get(a.target);
    if (!o || !('rig' in o)) continue;
    const bindings = (o.rig as { bindings: { parameter: Uid }[] }).bindings;
    if (bindings.length === 0) continue;
    const cell = (c.name === 'keyform.copy' ? a.to : a.cell) ?? {};
    const atDefault = bindings.every((b) => {
      const p = editor.view.getAs(b.parameter, 'parameter');
      return Math.abs((cell[b.parameter] ?? NaN) - p.default) < 1e-6;
    });
    if (!atDefault) continue;
    if (editor.lockDefault)
      return `Lock Default Forms is on: the default form of ${label(o)} stays as it is. Move a parameter to another key, or turn the lock off (${keymap.shortcut('model.lockDefault')}).`;
    tips.tip(
      'default-form',
      `You changed the default form of ${label(o)} (its shape at the default values). Lock Default Forms (${keymap.shortcut('model.lockDefault')}) protects it while you shape other keys.`,
    );
  }
  return null;
};

// ---------------------------------------------------------------- palettes

let partsPalette: PartsPalette;
const ctx: PaletteContext = {
  editor,
  viewport,
  keymap,
  settings,
  tips,
  dialogs: {
    keys: (p) => keysDialog(editor, p),
    createParameter: () => createParameterDialog(editor, tips),
    createParameterGroup: () => createParameterGroupDialog(editor),
    createDeformer: (kind) => createDeformerDialog(editor, kind, (u) => editor.select(u)),
    autoMesh: () => autoMeshDialog(editor, tips),
  },
  deleteSelection,
  addKeys,
};
partsPalette = new PartsPalette(ctx);
const expressionPalette = new ExpressionPalette(editor, viewport);
const toolDetails = new ToolDetails(ctx, (t) => setTool(t));
const timelineActive = () => dock.activeId === 'animation' && playback.motion !== null;
const timelineKeys = () => timelineActive() && timeline.selected.length > 0;
const timeline: TimelinePalette = new TimelinePalette(
  editor,
  playback,
  keymap,
  () => dock.activeId === 'animation',
);
viewport.recorder = timeline;
const templatePalette = new TemplatePalette(editor, playback, timeline);
const palettes: [string, string, { el: HTMLElement }][] = [
  ['parts', 'Parts', partsPalette],
  ['deformer', 'Deformer', new DeformerPalette(ctx)],
  ['parameter', 'Parameter', new ParameterPalette(ctx)],
  ['expression', 'Expression', expressionPalette],
  ['inspector', 'Inspector', new Inspector(ctx)],
  ['toolDetails', 'Tool Details', toolDetails],
  ['project', 'Project', new ProjectPalette(editor)],
  ['log', 'Log', new LogPalette(editor)],
  ['timeline', 'Timeline', timeline],
  ['scene', 'Scene', new ScenePalette(editor, playback)],
  ['template', 'Template', templatePalette],
  ['history', 'History', new HistoryPalette(editor)],
  ['validation', 'Validation', new ValidationPalette(editor, agent)],
  ['agents', 'Agents', new AgentsPalette(agent, host)],
  ['art', 'Art', new ArtPalette(editor, link, () => dock.show('art'))],
  ['preview', 'Preview', new PreviewPalette(viewport)],
  ['drawOrder', 'Draw Order', new DrawOrderPalette(editor, viewport)],
];
for (const [id, title, p] of palettes) dock.register({ id, title, el: p.el });

// ---------------------------------------------------------------- tools and modes

const guideParts = () => guidePartsOf(editor);
const objectClipboard = new ObjectClipboard(editor);
const saveGuideImage = () => saveSnapshotAsGuide(editor, viewport);

/** The desktop build's recent projects: folders on disk, opened with a click. */
async function recentDialog(): Promise<void> {
  if (!desktop) return;
  const list = await desktop.api.recent();
  const d = dialog(
    'Open Recent',
    [
      list.length
        ? h(
            'div.rows',
            list.map((dir) =>
              h(
                'button.row',
                {
                  dataset: { testid: 'recent-project' },
                  on: {
                    click: () => {
                      d.close();
                      void desktop.openRecent(dir).catch((e) => editor.report(e));
                    },
                  },
                },
                dir,
              ),
            ),
          )
        : h('div.empty', 'No recent projects yet.'),
    ],
    { testid: 'recent' },
  );
}

const toolButtons = new Map<string, HTMLButtonElement>();
function setTool(name: Tool): void {
  viewport.tool = name;
  for (const [n, b] of toolButtons) b.classList.toggle('on', n === name);
  viewport.overlay.style.cursor = name === 'arrow' ? 'default' : 'crosshair';
  toolDetails.render();
  renderToolbar();
}
function setLevel(l: EditLevel): void {
  editor.setLevel(l);
  if (l !== 2)
    tips.tip(
      'level-2',
      'While learning, stay at edit level 2: level 3 for broad moves, level 1 for detail.',
    );
}
function toggleMeshEdit(): void {
  if (editor.meshEdit) {
    editor.confirmMeshEdit();
    setTool('arrow');
  } else if (editor.enterMeshEdit()) setTool('arrow');
}

// ---------------------------------------------------------------- actions (rebindable)

const is = {
  meshEdit: () => editor.meshEdit !== null,
  mesh: () => editor.selectedMesh() !== undefined,
  vertices: () => editor.selectedMesh() !== undefined && editor.selection.vertices.length > 0,
  any: () => editor.selection.uids.length > 0,
  animation: () =>
    dock.activeId === 'animation' || tabs.current.kind === 'animation' || playback.motion !== null,
};
const nudge = (dx: number, dy: number) => () => {
  const mesh = editor.selectedMesh();
  if (mesh && editor.selection.vertices.length)
    viewport.nudge(mesh, editor.selection.vertices, [dx, dy]);
};
const toggleHidden = () => {
  const uids = editor.selection.uids;
  editor.setHidden(uids, !uids.every((u) => editor.hidden.has(u)));
};
const toggleLocked = () => {
  const uids = editor.selection.uids;
  editor.setLocked(uids, !uids.every((u) => editor.locked.has(u)));
};
const childrenOf = (u: Uid): Uid[] => {
  const v = editor.view;
  return [
    ...v.ofKind(['warp', 'rotation']).filter((c) => c.parent === u),
    ...v.ofKind('artMesh').filter((m) => m.deformer === u),
  ].map((o) => o.uid);
};

const actions: Action[] = [
  // Drawing a deform path: Enter finishes it, Esc cancels it.
  {
    id: 'path.finish',
    context: 'Deform path',
    category: 'Tools',
    label: 'Deform Path › Finish',
    keys: ['Enter'],
    run: () => viewport.finishPath(),
    enabled: () => viewport.drawingPath !== null,
  },
  {
    id: 'path.cancel',
    context: 'Deform path',
    category: 'Tools',
    label: 'Deform Path › Cancel',
    keys: ['Escape'],
    run: () => viewport.cancelPath(),
    enabled: () => viewport.drawingPath !== null,
  },
  // The brush: B + drag (tool.brush), C + drag and V + drag set its size, angle and
  // hardness while a brush tool is active. Before the Timeline's C, which wins otherwise.
  {
    id: 'brush.angle',
    category: 'Tools',
    label: 'Brush › Angle (hold and drag)',
    keys: ['C'],
    hold: true,
    run: () => {},
    enabled: () => viewport.brushTool,
  },
  {
    id: 'brush.hardness',
    category: 'Tools',
    label: 'Brush › Hardness (hold and drag)',
    keys: ['V'],
    hold: true,
    run: () => {},
    enabled: () => viewport.brushTool,
  },
  // The Timeline's keys first: they win while the Animation workspace shows a motion.
  {
    id: 'anim.switchMode',
    context: 'Timeline',
    category: 'Menus',
    label: 'Animation › Switch Edit Mode',
    keys: ['C'],
    run: () => timeline.switchMode(),
    enabled: () => timelineActive(),
    checked: () => timeline.mode === 'graph',
  },
  {
    id: 'anim.deleteKeys',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Delete Keys',
    keys: ['Delete', 'Backspace'],
    run: () => timeline.deleteSelected(),
    enabled: () => timelineKeys(),
  },
  {
    id: 'anim.copyKeys',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Copy Keys',
    keys: ['Ctrl+C'],
    run: () => timeline.copySelected(),
    enabled: () => timelineKeys(),
  },
  {
    id: 'anim.cutKeys',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Cut Keys',
    keys: ['Ctrl+X'],
    run: () => timeline.cutSelected(),
    enabled: () => timelineKeys(),
  },
  {
    id: 'anim.pasteKeys',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Paste Keys',
    keys: ['Ctrl+V'],
    run: () => timeline.paste(),
    enabled: () => timelineActive() && timeline.clip.length > 0,
  },
  {
    id: 'anim.keyUp',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Raise Key Values',
    keys: ['ArrowUp'],
    run: () => timeline.nudgeValue(1),
    enabled: () => timelineKeys(),
  },
  {
    id: 'anim.keyDown',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Lower Key Values',
    keys: ['ArrowDown'],
    run: () => timeline.nudgeValue(-1),
    enabled: () => timelineKeys(),
  },
  {
    id: 'anim.keyEarlier',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Move Keys a Frame Earlier',
    keys: ['ArrowLeft'],
    run: () => timeline.moveSelected(-playback.frame, 0),
    enabled: () => timelineKeys() && timeline.mode === 'graph',
  },
  {
    id: 'anim.keyLater',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Move Keys a Frame Later',
    keys: ['ArrowRight'],
    run: () => timeline.moveSelected(playback.frame, 0),
    enabled: () => timelineKeys() && timeline.mode === 'graph',
  },
  // The work area and markers. Ctrl+K goes to the next marker in the Timeline; the
  // command bar keeps it elsewhere.
  {
    id: 'anim.prevMarker',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Previous Marker',
    keys: ['Ctrl+J'],
    run: () => playback.jumpMarker(-1),
    enabled: () => timelineActive(),
  },
  {
    id: 'anim.nextMarker',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Next Marker',
    keys: ['Ctrl+K'],
    run: () => playback.jumpMarker(1),
    enabled: () => timelineActive(),
  },
  {
    id: 'anim.workAreaStart',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Set Work Area Start',
    keys: ['Shift+Home'],
    run: () => timeline.setWorkAreaStart(),
    enabled: () => timelineActive(),
  },
  {
    id: 'anim.workAreaEnd',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Set Work Area End',
    keys: ['Shift+End'],
    run: () => timeline.setWorkAreaEnd(),
    enabled: () => timelineActive(),
  },
  {
    id: 'anim.fitWorkArea',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Fit Work Area in View',
    keys: ['Shift+F'],
    run: () => timeline.fitWorkArea(),
    enabled: () => timelineActive(),
  },
  {
    id: 'anim.clearWorkArea',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Clear Work Area',
    run: () => timeline.clearWorkArea(),
    enabled: () => timelineActive() && !!playback.current?.workArea,
  },
  {
    id: 'anim.addMarker',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Add Marker at the Playhead…',
    run: () => void timeline.addMarker(),
    enabled: () => timelineActive(),
  },
  // Mesh editing first: its keys win while it is active.
  {
    id: 'mesh.confirm',
    context: 'Mesh Edit mode',
    category: 'Menus',
    label: 'Mesh Edit › Confirm',
    run: toggleMeshEdit,
    enabled: is.meshEdit,
  },
  {
    id: 'mesh.cancel',
    context: 'Mesh Edit mode',
    category: 'Menus',
    label: 'Mesh Edit › Cancel',
    keys: ['Escape'],
    run: () => (editor.cancelMeshEdit(), setTool('arrow')),
    enabled: is.meshEdit,
  },
  {
    id: 'mesh.connect',
    context: 'Mesh Edit mode',
    category: 'Menus',
    label: 'Mesh Edit › Connect Vertices',
    keys: ['Ctrl+R'],
    enabled: is.meshEdit,
    run: () => {
      const m = editor.selectedMesh();
      if (m)
        editor.transact('Retriangulate', [{ name: 'mesh.retriangulate', args: { target: m.uid } }]);
    },
  },
  {
    id: 'mesh.flipEdge',
    context: 'Mesh Edit mode',
    category: 'Menus',
    label: 'Mesh Edit › Flip Edge',
    enabled: () => is.meshEdit() && editor.selection.vertices.length === 2,
    run: () => {
      const m = editor.selectedMesh()!;
      editor.transact('Flip edge', [
        { name: 'mesh.flipEdge', args: { target: m.uid, edge: editor.selection.vertices } },
      ]);
    },
  },
  {
    id: 'tool.add',
    context: 'Mesh Edit mode',
    category: 'Tools',
    label: 'Add Vertices (mesh editing)',
    enabled: is.meshEdit,
    run: () => setTool('add'),
  },
  // File
  {
    id: 'file.new',
    category: 'Menus',
    label: 'File › New Model',
    keys: ['Ctrl+N'],
    run: () => openHome(),
  },
  {
    id: 'file.newAnimation',
    category: 'Menus',
    label: 'File › New Animation View',
    keys: ['Ctrl+Shift+N'],
    run: () => tabs.add('animation'),
  },
  {
    id: 'file.open',
    category: 'Menus',
    label: desktop ? 'File › Open Project…' : 'File › Open .mochi.zip…',
    keys: ['Ctrl+O'],
    run: () => (desktop ? void desktop.open().catch((e) => editor.report(e)) : zipInput.click()),
  },
  {
    id: 'file.openFolder',
    category: 'Menus',
    label: 'File › Open Project Folder…',
    run: () => (desktop ? void desktop.open().catch((e) => editor.report(e)) : folderInput.click()),
  },
  {
    id: 'file.importModel',
    category: 'Menus',
    label: 'File › Import Model…',
    run: () => importModelCommand(),
  },
  {
    id: 'file.recent',
    category: 'Menus',
    label: 'File › Open Recent (Home)',
    keys: ['Ctrl+Shift+O'],
    run: () => (desktop ? void recentDialog() : openHome()),
  },
  {
    id: 'file.importArt',
    category: 'Menus',
    label: 'File › Import Art…',
    run: () =>
      desktop ? void desktop.importArt().catch((e) => editor.report(e)) : artInput.click(),
  },
  {
    id: 'file.importPhysics',
    category: 'Menus',
    label: 'File › Import Physics…',
    enabled: () => !!desktop,
    run: () => void desktop?.importPhysics().catch((e) => editor.report(e)),
  },
  {
    id: 'file.reimport',
    category: 'Menus',
    label: 'File › Re-import Art…',
    run: () => reimportInput.click(),
  },
  {
    id: 'file.linkArt',
    category: 'Menus',
    label: 'File › Link Art…',
    enabled: () => !!desktop || canLink(),
    run: () =>
      desktop
        ? void desktop.importArt().catch((e) => editor.report(e))
        : void link
            .pick()
            .catch((e: unknown) => (e as Error).name !== 'AbortError' && editor.report(e)),
  },
  {
    id: 'file.save',
    category: 'Menus',
    label: 'File › Save',
    keys: ['Ctrl+S'],
    run: () => (desktop ? void desktop.save().catch((e) => editor.report(e)) : void save()),
  },
  {
    id: 'file.saveAs',
    category: 'Menus',
    label: 'File › Save As…',
    keys: ['Ctrl+Shift+S'],
    run: () => {
      if (desktop) return void desktop.save(true).catch((e) => editor.report(e));
      void askText('Save As', 'Name', editor.name).then((n) => {
        if (!n) return;
        editor.name = n;
        void save(n);
        editor.emit('project', undefined);
      });
    },
  },
  {
    id: 'file.exportMoc',
    category: 'Menus',
    label: 'File › Export as MOC3 File',
    keys: ['Ctrl+Alt+S'],
    run: () =>
      desktop ? void desktop.exportToFolder().catch((e) => editor.report(e)) : void exportRuntime(),
  },
  {
    id: 'file.exportMotion',
    category: 'Menus',
    label: 'File › Export Motion Files',
    keys: ['Ctrl+Alt+Shift+S'],
    run: () =>
      desktop
        ? void desktop.exportToFolder('motions').catch((e) => editor.report(e))
        : void exportRuntime('motions'),
  },
  {
    id: 'file.exportImages',
    category: 'Menus',
    label: 'File › Export › Image Sequence…',
    keys: ['Ctrl+I'],
    run: () => void movieDialog(editor, offscreen, 'images', playback.motion, saveMovie),
    enabled: () => editor.view.ofKind('motion').length > 0,
  },
  {
    id: 'file.exportPsd',
    category: 'Menus',
    label: 'File › Export › PSD of the Pose (beta)',
    keys: ['Ctrl+P'],
    run: () => void savePsd(),
    enabled: () => editor.view.ofKind('artMesh').length > 0,
  },
  {
    id: 'file.exportVideo',
    category: 'Menus',
    label: 'File › Export › Video…',
    keys: ['Ctrl+Shift+M'],
    run: () => void movieDialog(editor, offscreen, 'video', playback.motion, saveMovie),
    enabled: () => editor.view.ofKind('motion').length > 0,
  },
  {
    id: 'file.shortcuts',
    category: 'Menus',
    label: 'File › Keyboard Shortcuts…',
    keys: ['Ctrl+Alt+Shift+K'],
    run: () => shortcutsDialog(keymap),
  },
  {
    id: 'file.settings',
    category: 'Menus',
    label: 'File › Environment Settings…',
    run: () => settingsDialog(settings),
  },
  // Edit
  {
    id: 'edit.undo',
    category: 'Menus',
    label: 'Edit › Undo',
    keys: ['Ctrl+Z'],
    run: () => editor.undo(),
    enabled: () => editor.session.canUndo,
  },
  {
    id: 'edit.redo',
    category: 'Menus',
    label: 'Edit › Redo',
    keys: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    run: () => editor.redo(),
    enabled: () => editor.session.canRedo,
  },
  {
    id: 'edit.cut',
    category: 'Menus',
    label: 'Edit › Cut',
    keys: ['Ctrl+X'],
    run: () => void objectClipboard.cut(),
    enabled: () => objectClipboard.copyable().length > 0 && !editor.meshEdit,
  },
  {
    id: 'edit.copy',
    category: 'Menus',
    label: 'Edit › Copy',
    keys: ['Ctrl+C'],
    run: () => void objectClipboard.copy(),
    enabled: () => objectClipboard.copyable().length > 0 && !editor.meshEdit,
  },
  {
    id: 'edit.paste',
    category: 'Menus',
    label: 'Edit › Paste',
    keys: ['Ctrl+V'],
    run: () => void objectClipboard.paste(),
    enabled: () => !editor.meshEdit,
  },
  {
    id: 'edit.delete',
    category: 'Menus',
    label: 'Edit › Delete',
    keys: ['Delete', 'Backspace'],
    run: () => deleteSelection(false),
    enabled: () => is.any() || is.vertices(),
  },
  {
    id: 'edit.selectAll',
    category: 'Menus',
    label: 'Edit › Select All',
    keys: ['Ctrl+A'],
    run: () => {
      const m = editor.selectedMesh();
      if (editor.meshEdit && m)
        return editor.select(
          m.uid,
          Array.from({ length: m.uv.length / 2 }, (_, i) => i),
        );
      // Locked and hidden objects are left out.
      editor.selectMany(
        editor.view
          .ofKind('artMesh')
          .map((x) => x.uid)
          .filter((u) => !editor.isLocked(u) && !editor.isHidden(u)),
      );
    },
  },
  {
    id: 'edit.deselect',
    category: 'Menus',
    label: 'Edit › Deselect',
    keys: ['Escape'],
    run: () => editor.select(null),
  },
  {
    id: 'edit.find',
    category: 'Menus',
    label: 'Edit › Find and Replace…',
    keys: ['Ctrl+F'],
    run: () => void findReplaceDialog(editor),
  },
  {
    id: 'edit.findParts',
    category: 'Menus',
    label: 'Edit › Filter the Parts Palette',
    run: () => (dock.show('parts'), partsPalette.focusFilter()),
  },
  {
    id: 'edit.commandBar',
    category: 'Menus',
    label: 'Edit › Run a Command…',
    keys: ['Ctrl+K'],
    inInputs: true,
    run: () => commandBar.open(),
  },
  {
    id: 'edit.copyShape',
    category: 'Menus',
    label: 'Edit › Copy Shape',
    keys: ['Ctrl+Shift+C'],
    run: copyShape,
    enabled: is.any,
  },
  {
    id: 'edit.pasteShape',
    category: 'Menus',
    label: 'Edit › Paste Shape',
    keys: ['Ctrl+Shift+V'],
    run: pasteShape,
    enabled: () => shapeClip !== null,
  },
  // Show
  // The snapshot and guide images.
  {
    id: 'view.snapshot',
    category: 'View area',
    label: 'Take Snapshot',
    keys: ['Ctrl+5'],
    run: () => void viewport.takeSnapshot(),
  },
  {
    id: 'view.snapshotShow',
    category: 'View area',
    label: 'Show Snapshot',
    keys: ['5'],
    run: () => viewport.setSnapshotShown(!viewport.snapshotShown),
    enabled: () => viewport.snapshot !== null,
    checked: () => viewport.snapshot !== null && viewport.snapshotShown,
  },
  {
    id: 'view.snapshotGuide',
    category: 'View area',
    label: 'Save Snapshot as Guide Image',
    keys: ['Ctrl+Shift+5'],
    run: () => void saveGuideImage(),
    enabled: () => viewport.snapshot !== null,
  },
  {
    id: 'view.guides',
    category: 'View area',
    label: 'Show Guide Images',
    keys: ['Ctrl+Alt+Shift+3'],
    run: () => {
      const guides = guideParts();
      editor.setHidden(
        guides,
        guides.some((u) => !editor.hidden.has(u)),
      );
    },
    enabled: () => guideParts().length > 0,
    checked: () => guideParts().some((u) => !editor.hidden.has(u)),
  },
  {
    id: 'file.exportGuides',
    category: 'Menus',
    label: 'File › Export › Include Guide Images',
    run: () =>
      void editor.transact('Export guide images', [
        {
          name: 'project.setExportSettings',
          args: { includeGuideImages: !editor.view.project().exportSettings.includeGuideImages },
        },
      ]),
    checked: () => editor.view.project().exportSettings.includeGuideImages,
  },
  {
    id: 'view.fit',
    category: 'View area',
    label: 'Fit the Whole Canvas',
    keys: ['Ctrl+0'],
    run: () => {
      viewport.view.resetView();
      viewport.drawOverlay();
    },
  },
  {
    id: 'view.focus',
    category: 'View area',
    label: 'Center on the Selection',
    keys: ['F'],
    run: () => viewport.frameSelection(),
  },
  {
    id: 'view.rotate',
    category: 'View area',
    label: 'Flip Left and Right (tap); rotate the canvas (hold and drag)',
    keys: ['R'],
    hold: true,
    run: () => viewport.setFlipped(!viewport.flipped),
    checked: () => viewport.flipped,
  },
  {
    id: 'view.pan',
    category: 'View area',
    label: 'Pan (hold and drag)',
    keys: ['Space'],
    hold: true,
    run: () => {},
  },
  {
    id: 'view.zoom',
    category: 'View area',
    label: 'Zoom (hold and drag)',
    keys: ['Ctrl+Space'],
    hold: true,
    run: () => {},
  },
  {
    id: 'view.solo',
    category: 'View area',
    label: 'Show the Selection Solo',
    keys: ['S'],
    run: () => editor.setSolo(editor.solo ? null : editor.selection.uids),
    checked: () => editor.solo !== null,
  },
  {
    id: 'view.atlas',
    category: 'View area',
    label: 'Source Image / Texture Atlas',
    keys: ['T'],
    run: () => viewport.setAtlasView(!viewport.atlasView),
    checked: () => viewport.atlasView,
  },
  {
    id: 'view.wireframes',
    category: 'View area',
    label: 'Every ArtMesh’s Wireframe',
    run: () => {
      viewport.showAllMeshes = !viewport.showAllMeshes;
      viewport.drawOverlay();
    },
    checked: () => viewport.showAllMeshes,
  },
  {
    id: 'view.lockDrawables',
    category: 'View area',
    label: 'Lock Drawable Objects on the Canvas',
    keys: ['Shift+A'],
    run: () => editor.setCanvasLock('drawables', !editor.canvasLock.drawables),
    checked: () => editor.canvasLock.drawables,
  },
  {
    id: 'view.lockDeformers',
    category: 'View area',
    label: 'Lock Deformers on the Canvas',
    keys: ['Shift+D'],
    run: () => editor.setCanvasLock('deformers', !editor.canvasLock.deformers),
    checked: () => editor.canvasLock.deformers,
  },
  {
    id: 'view.hideBox',
    category: 'View area',
    label: 'Hide the Transform Box',
    run: () => {
      viewport.hideBox = !viewport.hideBox;
      viewport.drawOverlay();
    },
    checked: () => viewport.hideBox,
  },
  {
    id: 'view.nudgeLeft',
    category: 'View area',
    label: 'Nudge Left',
    keys: ['ArrowLeft'],
    run: nudge(-1, 0),
    enabled: is.vertices,
  },
  {
    id: 'view.nudgeRight',
    category: 'View area',
    label: 'Nudge Right',
    keys: ['ArrowRight'],
    run: nudge(1, 0),
    enabled: is.vertices,
  },
  {
    id: 'view.nudgeUp',
    category: 'View area',
    label: 'Nudge Up',
    keys: ['ArrowUp'],
    run: nudge(0, -1),
    enabled: is.vertices,
  },
  {
    id: 'view.nudgeDown',
    category: 'View area',
    label: 'Nudge Down',
    keys: ['ArrowDown'],
    run: nudge(0, 1),
    enabled: is.vertices,
  },
  {
    id: 'view.nudgeLeft10',
    category: 'View area',
    label: 'Nudge Left 10 px',
    keys: ['Shift+ArrowLeft'],
    run: nudge(-10, 0),
    enabled: is.vertices,
  },
  {
    id: 'view.nudgeRight10',
    category: 'View area',
    label: 'Nudge Right 10 px',
    keys: ['Shift+ArrowRight'],
    run: nudge(10, 0),
    enabled: is.vertices,
  },
  {
    id: 'view.nudgeUp10',
    category: 'View area',
    label: 'Nudge Up 10 px',
    keys: ['Shift+ArrowUp'],
    run: nudge(0, -10),
    enabled: is.vertices,
  },
  {
    id: 'view.nudgeDown10',
    category: 'View area',
    label: 'Nudge Down 10 px',
    keys: ['Shift+ArrowDown'],
    run: nudge(0, 10),
    enabled: is.vertices,
  },
  // Modeling
  {
    id: 'mesh.toggle',
    category: 'Menus',
    label: 'Modeling › Edit Mesh',
    keys: ['Ctrl+E'],
    run: toggleMeshEdit,
    checked: is.meshEdit,
  },
  {
    id: 'model.autoMesh',
    category: 'Menus',
    label: 'Modeling › Automatic Mesh…',
    keys: ['Ctrl+Shift+A'],
    run: () => autoMeshDialog(editor, tips),
  },
  {
    id: 'model.motionSync',
    category: 'Menus',
    label: 'Modeling › Motion Sync…',
    run: () => void motionSyncDialog(editor, viewport),
  },
  {
    id: 'model.exportTemplate',
    category: 'Menus',
    label: 'Modeling › Model Template › Export Template…',
    run: () =>
      void exportTemplateDialog(editor, viewport, async (name, bytes) => {
        const file = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.mochitemplate`;
        if (desktop) {
          const out = await desktop.api.exportToFolder([[file, bytes]]);
          if (out)
            editor.emit('message', { level: 'info', text: `Exported ${file} to ${out.dir}.` });
          return;
        }
        download(bytes, file, 'application/zip');
        editor.emit('message', { level: 'info', text: `Exported ${file}.` });
      }),
    enabled: () => editor.view.ofKind('artMesh').length > 0,
  },
  {
    id: 'model.applyTemplate',
    category: 'Menus',
    label: 'Modeling › Model Template › Apply Template…',
    run: () => void applyTemplateDialog(editor, viewport),
    enabled: () => editor.view.ofKind('artMesh').length > 0,
  },
  {
    id: 'model.createWarp',
    category: 'Menus',
    label: 'Modeling › Create Warp Deformer…',
    run: () => createDeformerDialog(editor, 'warp', (u) => editor.select(u)),
  },
  {
    id: 'model.createRotation',
    category: 'Menus',
    label: 'Modeling › Create Rotation Deformer…',
    run: () => createDeformerDialog(editor, 'rotation', (u) => editor.select(u)),
  },
  {
    id: 'model.physics',
    category: 'Menus',
    label: 'Modeling › Physics…',
    run: () => physics.open(),
  },
  {
    id: 'model.atlas',
    category: 'Menus',
    label: 'Modeling › Texture Atlas…',
    keys: ['Ctrl+T'],
    run: () => atlasDialog(editor),
  },
  {
    id: 'model.resetParams',
    category: 'Menus',
    label: 'Modeling › Reset Parameters',
    keys: ['Ctrl+1'],
    run: () => editor.resetPose(),
  },
  {
    id: 'model.lockDefault',
    category: 'Menus',
    label: 'Modeling › Lock Default Forms',
    keys: ['Ctrl+Shift+1'],
    run: () => editor.setLockDefault(!editor.lockDefault),
    checked: () => editor.lockDefault,
  },
  {
    id: 'model.lock',
    category: 'Menus',
    label: 'Modeling › Lock or Unlock the Selection',
    keys: ['Ctrl+2'],
    run: toggleLocked,
    enabled: is.any,
  },
  {
    id: 'model.lockOthers',
    category: 'Menus',
    label: 'Modeling › Lock Everything Else',
    keys: ['Ctrl+Shift+2'],
    run: () => editor.setLocked(others(), true),
    enabled: is.any,
  },
  {
    id: 'model.unlockAll',
    category: 'Menus',
    label: 'Modeling › Unlock Everything',
    keys: ['Ctrl+Alt+2'],
    run: () => editor.setLocked([...editor.locked], false),
  },
  {
    id: 'model.hide',
    category: 'Menus',
    label: 'Modeling › Show or Hide the Selection',
    keys: ['Ctrl+3'],
    run: toggleHidden,
    enabled: is.any,
  },
  {
    id: 'model.hideOthers',
    category: 'Menus',
    label: 'Modeling › Hide Everything Else',
    keys: ['Ctrl+Shift+3'],
    run: () => editor.setHidden(others(), true),
    enabled: is.any,
  },
  {
    id: 'model.showAll',
    category: 'Menus',
    label: 'Modeling › Show Everything',
    keys: ['Ctrl+Alt+3'],
    run: () => {
      editor.setSolo(null);
      editor.setHidden([...editor.hidden], false);
    },
  },
  {
    id: 'model.fourCorners',
    category: 'Menus',
    label: 'Modeling › Generate Four-Corner Forms',
    keys: ['Ctrl+4'],
    run: () => {
      const v = editor.view;
      const targets = editor.selection.uids.filter((u) => {
        const o = v.get(u);
        return !!o && 'rig' in o;
      });
      const r = editor.transact('Four-corner forms', [
        { name: 'keyform.fillCorners', args: { targets } },
      ]);
      const res = r?.results[0] as
        { objects: number; cells: number; skipped: string[] } | undefined;
      if (res)
        editor.emit('message', {
          level: res.objects ? 'info' : 'warning',
          text: res.objects
            ? `Four-corner forms: ${res.cells} cell(s) of ${res.objects} object(s)${res.skipped.length ? `; ${res.skipped.length} skipped (not bound to exactly two parameters)` : ''}.`
            : 'Nothing to fill: the selected objects are not bound to exactly two parameters.',
        });
    },
    enabled: () =>
      editor.selection.uids.some((u) => {
        const o = editor.view.get(u);
        return !!o && 'rig' in o;
      }),
  },
  {
    id: 'model.selectParent',
    category: 'Menus',
    label: 'Modeling › Select the Parent Deformer',
    keys: ['Ctrl+D'],
    enabled: is.any,
    run: () => {
      const o = editor.selection.uid ? editor.view.get(editor.selection.uid) : undefined;
      const p =
        o?.kind === 'artMesh'
          ? o.deformer
          : o?.kind === 'warp' || o?.kind === 'rotation'
            ? o.parent
            : null;
      if (p) editor.select(p);
      else editor.emit('message', { level: 'info', text: 'It has no parent deformer.' });
    },
  },
  {
    id: 'model.selectChildren',
    category: 'Menus',
    label: 'Modeling › Select the Children',
    keys: ['Ctrl+Alt+D'],
    enabled: () => deformers().length > 0,
    run: () => editor.selectMany(deformers().flatMap((d) => childrenOf(d.uid))),
  },
  {
    id: 'model.highlightChildren',
    category: 'Menus',
    label: 'Modeling › Highlight the Children',
    keys: ['Ctrl+Shift+D'],
    run: () => {
      viewport.highlight = viewport.highlight.length
        ? []
        : deformers().flatMap((d) => childrenOf(d.uid));
      viewport.drawOverlay();
    },
    checked: () => viewport.highlight.length > 0,
  },
  {
    id: 'model.deleteWithContents',
    category: 'Menus',
    label: 'Modeling › Delete Deformer with Contents',
    keys: ['Ctrl+Delete'],
    run: deleteWithContents,
    enabled: () => deformers().length > 0,
  },
  {
    id: 'model.checkParents',
    category: 'Menus',
    label: 'Modeling › Check Children Outside Parent Warps',
    run: () => {
      const out = outsideParents(editor.view);
      if (out.length === 0)
        editor.emit('message', { level: 'info', text: 'Every child lies inside its parent warp.' });
      for (const x of out)
        tips.warn(
          'outside-parent',
          `${x.childId} sticks out of its parent warp ${x.parentId} (${x.points} point(s)): a parent must not be smaller than its child.`,
        );
      viewport.highlight = out.map((x) => x.child);
      viewport.drawOverlay();
    },
  },
  {
    id: 'level.1',
    category: 'Tools',
    label: 'Level Edit 1',
    keys: ['1'],
    run: () => setLevel(1),
    checked: () => editor.level === 1,
  },
  {
    id: 'level.2',
    category: 'Tools',
    label: 'Level Edit 2',
    keys: ['2'],
    run: () => setLevel(2),
    checked: () => editor.level === 2,
  },
  {
    id: 'level.3',
    category: 'Tools',
    label: 'Level Edit 3',
    keys: ['3'],
    run: () => setLevel(3),
    checked: () => editor.level === 3,
  },
  {
    id: 'tool.arrow',
    category: 'Tools',
    label: 'Arrow Tool',
    keys: ['A'],
    run: () => setTool('arrow'),
    checked: () => viewport.tool === 'arrow',
  },
  {
    id: 'tool.lasso',
    category: 'Tools',
    label: 'Lasso',
    keys: ['L'],
    run: () => setTool('lasso'),
    checked: () => viewport.tool === 'lasso',
  },
  {
    id: 'tool.brush',
    category: 'Tools',
    label: 'Brush Selection (tap); brush size (hold and drag)',
    keys: ['B'],
    hold: true,
    run: () => setTool('brush'),
    checked: () => viewport.tool === 'brush',
  },
  {
    id: 'tool.deformBrush',
    category: 'Tools',
    label: 'Deform Brush',
    run: () => setTool('deform'),
    checked: () => viewport.tool === 'deform',
  },
  {
    id: 'tool.addBrush',
    category: 'Tools',
    label: 'Add-Points Brush (mesh editing)',
    run: () => setTool('addBrush'),
    enabled: () => editor.meshEdit !== null,
    checked: () => viewport.tool === 'addBrush',
  },
  {
    id: 'tool.stroke',
    category: 'Tools',
    label: 'Stroke Meshing (beta)',
    run: () => setTool('stroke'),
    checked: () => viewport.tool === 'stroke',
  },
  {
    id: 'mesh.confirmStrokes',
    category: 'Menus',
    label: 'Modeling › Mesh from Strokes (beta)',
    keys: ['Shift+E'],
    run: () => {
      viewport.confirmStrokes();
      toolDetails.render();
    },
    enabled: () => viewport.strokes.length > 0,
  },
  {
    id: 'mesh.subdivide',
    category: 'Menus',
    label: 'Modeling › Split Every Triangle into Four',
    run: () => {
      const m = editor.selectedMesh();
      if (m)
        editor.transact('Split triangles into four', [
          { name: 'mesh.subdivide', args: { target: m.uid } },
        ]);
    },
    enabled: () => !!editor.selectedMesh(),
  },
  {
    id: 'mesh.resetImported',
    category: 'Menus',
    label: 'Modeling › Reset to the Imported Mesh',
    run: () => {
      const m = editor.selectedMesh();
      if (m)
        void editor.runItems('Reset to the imported mesh', [
          { name: 'mesh.regenerate', args: { target: m.uid } },
        ]);
    },
    enabled: () => !!editor.selectedMesh()?.layer,
  },
  {
    id: 'mesh.mirror',
    category: 'Menus',
    label: 'Mesh Edit › Mirrored Editing',
    run: () => {
      viewport.mirrorEdit = !viewport.mirrorEdit;
      viewport.drawOverlay();
      toolDetails.render();
    },
    checked: () => viewport.mirrorEdit,
  },
  {
    id: 'anim.markersToEvents',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Markers to Events',
    run: () =>
      playback.motion &&
      void editor.transact('Markers to events', [
        { name: 'motion.markersToEvents', args: { target: playback.motion } },
      ]),
    enabled: () => (playback.current?.markers.length ?? 0) > 0,
  },
  {
    id: 'tool.path',
    category: 'Tools',
    label: 'Deform Path',
    keys: ['P'],
    run: () => setTool('path'),
    checked: () => viewport.tool === 'path',
  },
  {
    id: 'tool.rotation',
    category: 'Tools',
    label: 'Rotation Deformer by Dragging',
    run: () => setTool('rotation'),
    checked: () => viewport.tool === 'rotation',
  },
  // Animation
  {
    id: 'anim.play',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Play or Stop',
    keys: ['Enter'],
    run: () => playback.toggle(),
    enabled: () => playback.motion !== null,
  },
  {
    id: 'anim.prevFrame',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Previous Frame',
    keys: ['PageUp'],
    run: () => playback.step(-1),
    enabled: () => playback.motion !== null,
  },
  {
    id: 'anim.nextFrame',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Next Frame',
    keys: ['PageDown'],
    run: () => playback.step(1),
    enabled: () => playback.motion !== null,
  },
  {
    id: 'anim.start',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Start',
    keys: ['Home'],
    run: () => playback.seek(0),
    enabled: () => playback.motion !== null,
  },
  {
    id: 'anim.end',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › End',
    keys: ['End'],
    run: () => playback.seek(Infinity),
    enabled: () => playback.motion !== null,
  },
  {
    id: 'anim.prevKey',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Previous Keyframe',
    keys: ['J'],
    run: () => playback.jump(-1),
    enabled: () => playback.motion !== null,
  },
  {
    id: 'anim.nextKey',
    context: 'Timeline',
    category: 'Palettes',
    label: 'Timeline › Next Keyframe',
    keys: ['K'],
    run: () => playback.jump(1),
    enabled: () => playback.motion !== null,
  },
  // Window
  ...palettes.map(([id, title]): Action => ({
    id: `window.palette.${id}`,
    category: 'Palettes',
    label: `Window › ${title}`,
    run: () => dock.toggle(id),
    checked: () => dock.isShown(id),
  })),
  {
    id: 'window.hideAll',
    category: 'Menus',
    label: 'Window › Hide All Palettes',
    run: () => dock.setHideAll(true),
    enabled: () => !dock.layout.hideAll,
  },
  {
    id: 'window.showAll',
    category: 'Menus',
    label: 'Window › Show the Palettes Again',
    run: () => dock.setHideAll(false),
    enabled: () => dock.layout.hideAll,
  },
  {
    id: 'window.resetLayout',
    category: 'Menus',
    label: 'Window › Reset Current Layout',
    run: () => dock.resetLayout(),
  },
  {
    id: 'window.saveInitial',
    category: 'Menus',
    label: 'Window › Save Layout as This Workspace’s Initial Layout',
    enabled: () => !dock.workspace.builtIn,
    run: () =>
      dock.saveAsInitial() &&
      editor.emit('message', {
        level: 'info',
        text: `Saved the initial layout of ${dock.workspace.name}.`,
      }),
  },
  {
    id: 'window.workspaces',
    category: 'Menus',
    label: 'Window › Workspace Settings…',
    run: () => workspaceDialog(dock),
  },
  {
    id: 'window.newModelingView',
    category: 'Menus',
    label: 'Window › New Modeling View',
    run: () => tabs.add('modeling'),
  },
  {
    id: 'window.duplicateTab',
    category: 'Menus',
    label: 'Window › Duplicate Tab',
    run: () => tabs.duplicate(),
  },
  {
    id: 'window.closeTab',
    category: 'Menus',
    label: 'Window › Close Tab',
    keys: ['Ctrl+W'],
    run: () => tabs.close(),
  },
  {
    id: 'window.prevTab',
    category: 'Menus',
    label: 'Window › Previous Tab',
    keys: ['Ctrl+PageUp'],
    run: () => tabs.step(-1),
  },
  {
    id: 'window.nextTab',
    category: 'Menus',
    label: 'Window › Next Tab',
    keys: ['Ctrl+PageDown'],
    run: () => tabs.step(1),
  },
  {
    id: 'window.sameView',
    category: 'Menus',
    label: 'Window › Same Display Position in Every View',
    run: () => tabs.sameDisplayPosition(),
  },
  // Help
  { id: 'help.home', category: 'Menus', label: 'Help › Home', run: () => openHome() },
  { id: 'help.agents', category: 'Menus', label: 'Help › Agent Access…', run: () => access.open() },
];
keymap.register(actions);

// ---------------------------------------------------------------- menu bar

type MenuEntry = string | null | { label: string; items: () => (MenuItem | null)[] };
const menuItem = (id: string): MenuItem | null => {
  const a = keymap.get(id);
  if (!a) return null;
  return {
    label: a.label.replace(/^[^›]*› /, ''),
    key: keymap.shortcut(id),
    checked: a.checked?.() ?? false,
    disabled: !(a.enabled?.() ?? true),
    testid: `menu-${id}`,
    run: () => keymap.run(id),
  };
};
const MENUS: { id: string; title: () => string; items: () => MenuEntry[]; when?: () => boolean }[] =
  [
    {
      id: 'file',
      title: () => 'File',
      items: () => [
        'file.new',
        'file.newAnimation',
        null,
        'file.open',
        'file.openFolder',
        'file.recent',
        'file.importModel',
        null,
        'file.importArt',
        'file.importPhysics',
        'file.reimport',
        'file.linkArt',
        null,
        'file.save',
        'file.saveAs',
        null,
        {
          label: settings.value.exportMenuLabel,
          items: () => [
            menuItem('file.exportMoc'),
            menuItem('file.exportMotion'),
            null,
            menuItem('file.exportImages'),
            menuItem('file.exportVideo'),
            menuItem('file.exportPsd'),
            null,
            menuItem('file.exportGuides'),
          ],
        },
        null,
        'file.shortcuts',
        'file.settings',
      ],
    },
    {
      id: 'edit',
      title: () => 'Edit',
      items: () => [
        'edit.undo',
        'edit.redo',
        null,
        'edit.cut',
        'edit.copy',
        'edit.paste',
        'edit.delete',
        'edit.selectAll',
        'edit.deselect',
        'edit.find',
        'edit.findParts',
        null,
        'edit.copyShape',
        'edit.pasteShape',
        null,
        'edit.commandBar',
      ],
    },
    {
      id: 'show',
      title: () => settings.value.displayMenuLabel,
      items: () => [
        'view.fit',
        'view.focus',
        'view.rotate',
        'view.solo',
        'view.atlas',
        null,
        'view.wireframes',
        'view.hideBox',
        null,
        'view.snapshot',
        'view.snapshotShow',
        'view.snapshotGuide',
        'view.guides',
        null,
        'view.lockDrawables',
        'view.lockDeformers',
      ],
    },
    {
      id: 'modeling',
      title: () => 'Modeling',
      items: () => [
        'mesh.toggle',
        'model.autoMesh',
        null,
        'model.exportTemplate',
        'model.applyTemplate',
        null,
        'model.createWarp',
        'model.createRotation',
        'tool.rotation',
        'tool.path',
        null,
        'model.fourCorners',
        null,
        'model.selectParent',
        'model.selectChildren',
        'model.highlightChildren',
        'model.checkParents',
        null,
        'model.physics',
        'model.motionSync',
        null,
        'model.resetParams',
        'model.lockDefault',
        null,
        'model.lock',
        'model.lockOthers',
        'model.unlockAll',
        'model.hide',
        'model.hideOthers',
        'model.showAll',
        null,
        'model.atlas',
        'model.deleteWithContents',
        null,
        'level.1',
        'level.2',
        'level.3',
      ],
    },
    {
      id: 'meshEdit',
      title: () => 'Mesh Edit mode',
      when: is.meshEdit,
      items: () => [
        'mesh.confirm',
        'mesh.cancel',
        null,
        'tool.add',
        'tool.addBrush',
        'tool.lasso',
        'tool.brush',
        'mesh.mirror',
        'mesh.subdivide',
        'mesh.resetImported',
        'mesh.connect',
        'mesh.flipEdge',
        'edit.delete',
        null,
        'model.autoMesh',
      ],
    },
    {
      id: 'animation',
      title: () => 'Animation',
      items: () => [
        'anim.play',
        'anim.prevFrame',
        'anim.nextFrame',
        'anim.start',
        'anim.end',
        'anim.prevKey',
        'anim.nextKey',
        null,
        'anim.switchMode',
        null,
        'file.newAnimation',
      ],
    },
    {
      id: 'window',
      title: () => 'Window',
      items: () => [
        ...palettes.map(([id]) => `window.palette.${id}`),
        null,
        'window.hideAll',
        'window.showAll',
        null,
        {
          label: 'Workspace',
          items: () => [
            ...dock.workspaces.map((w) => ({
              label: w.name,
              checked: w.id === dock.activeId,
              testid: `workspace-${w.id}`,
              run: () => dock.switchTo(w.id),
            })),
            null,
            menuItem('window.workspaces'),
            menuItem('window.saveInitial'),
          ],
        },
        'window.resetLayout',
        null,
        'window.newModelingView',
        'file.newAnimation',
        'window.duplicateTab',
        'window.closeTab',
        'window.prevTab',
        'window.nextTab',
        'window.sameView',
      ],
    },
    {
      id: 'help',
      title: () => 'Help',
      items: () => ['help.home', 'file.shortcuts', 'help.agents'],
    },
  ];

const menubar = h('nav.menubar', { dataset: { testid: 'menubar' } });
const projectName = h('span.project', { dataset: { testid: 'project-name' } });
let openMenu: string | null = null;
function renderMenus(): void {
  fill(
    menubar,
    h('span.brand', 'mochi', h('b', 'maker')),
    MENUS.filter((m) => m.when?.() ?? true).map((m) =>
      h(
        'button.menu-title',
        {
          class: openMenu === m.id ? 'on' : '',
          dataset: { menu: m.id },
          on: {
            pointerdown: (e) => {
              e.stopPropagation();
              if (openMenu === m.id) closeMenus();
              else showMenu(m.id, e.currentTarget as HTMLElement);
            },
            pointerenter: (e) =>
              openMenu && openMenu !== m.id && showMenu(m.id, e.currentTarget as HTMLElement),
          },
        },
        m.title(),
      ),
    ),
    h('span.spacer'),
    projectName,
    linkChip,
  );
}
function closeMenus(): void {
  openMenu = null;
  document.querySelector('.ctx-menu')?.remove();
  renderMenus();
}
function showMenu(id: string, anchor: HTMLElement): void {
  const m = MENUS.find((x) => x.id === id)!;
  openMenu = id;
  renderMenus();
  // The menu bar was drawn again: measure the title as it is now.
  const r = (menubar.querySelector(`[data-menu="${id}"]`) ?? anchor).getBoundingClientRect();
  const items = m.items().map((e): MenuItem | null =>
    e === null
      ? null
      : typeof e === 'string'
        ? menuItem(e)
        : {
            label: `${e.label} ▸`,
            run: () =>
              setTimeout(() =>
                popupMenu(
                  new MouseEvent('click', { clientX: r.left + 230, clientY: r.bottom + 40 }),
                  e.items(),
                ).classList.add('submenu'),
              ),
          },
  );
  const menu = popupMenu(new MouseEvent('click', { clientX: r.left, clientY: r.bottom }), items);
  menu.classList.add('menu-drop');
  menu.dataset.testid = `menu-${id}`;
  new MutationObserver(() => {
    if (!menu.isConnected && openMenu === id) {
      openMenu = null;
      renderMenus();
    }
  }).observe(document.body, { childList: true });
}

// ---------------------------------------------------------------- toolbar

const toolbar = h('div.toolbar', { dataset: { testid: 'toolbar' } });
const agentDot = h('span.agent-dot', { dataset: { testid: 'agent-indicator' } });
const undoButton = h(
  'button.tb',
  { title: 'Undo', dataset: { testid: 'undo' }, on: { click: () => editor.undo() } },
  '↶',
);
const redoButton = h(
  'button.tb',
  { title: 'Redo', dataset: { testid: 'redo' }, on: { click: () => editor.redo() } },
  '↷',
);
const tbButton = (id: string, text: string, testid?: string) => {
  const a = keymap.get(id)!;
  const key = keymap.shortcut(id);
  const b = h(
    'button.tb',
    {
      class: a.checked?.() ? 'on' : '',
      disabled: !(a.enabled?.() ?? true),
      title: `${a.label.replace(/^[^›]*› /, '')}${key ? ` (${key})` : ''}`,
      dataset: { testid: testid ?? `tb-${id}` },
      on: { click: () => keymap.run(id) },
    },
    text,
  );
  return b;
};
function renderToolbar(): void {
  toolButtons.clear();
  const version = editor.view.project().exportSettings.mocVersion;
  const ws = dock.workspace;
  const modeling = ws.id !== 'animation';
  const tool = (t: Tool, id: string, text: string) => {
    const b = tbButton(id, text, `tool-${t}`);
    toolButtons.set(t, b);
    return b;
  };
  fill(
    toolbar,
    h(
      'select.workspace-switch',
      {
        title: 'Workspace',
        dataset: { testid: 'workspace-switcher' },
        on: { change: (e) => dock.switchTo((e.target as HTMLSelectElement).value) },
      },
      dock.workspaces.map((w) =>
        h('option', { value: w.id, selected: w.id === dock.activeId }, w.name),
      ),
    ),
    h(
      'select.target-version',
      {
        title: 'Target version of the exported model (.moc3)',
        dataset: { testid: 'target-version' },
        on: {
          change: (e) => {
            const v = (e.target as HTMLSelectElement).value;
            editor.transact('Target version', [
              {
                name: 'project.setExportSettings',
                args: { mocVersion: v === 'auto' ? 'auto' : Number(v) },
              },
            ]);
          },
        },
      },
      (['auto', 6, 5, 4, 3] as const).map((v) =>
        h(
          'option',
          { value: String(v), selected: v === version },
          v === 'auto' ? 'Version: auto' : `moc3 v${v}`,
        ),
      ),
    ),
    h(
      'span.tb-group',
      tbButton('level.1', '1', 'level-1'),
      tbButton('level.2', '2', 'level-2'),
      tbButton('level.3', '3', 'level-3'),
    ),
    modeling
      ? h(
          'span.tb-group',
          tbButton('model.atlas', '▦ Atlas'),
          tbButton('mesh.toggle', '◇ Edit Mesh', 'mesh-edit'),
          tbButton('model.autoMesh', '◈ Auto Mesh'),
          tbButton('model.createWarp', '▤ Warp'),
          tbButton('model.createRotation', '↻ Rotation'),
          tool('rotation', 'tool.rotation', '↻⇢'),
        )
      : h('span.tb-group', tbButton('anim.play', playback.playing ? '■ Stop' : '▶ Play')),
    h(
      'span.tb-group',
      tool('arrow', 'tool.arrow', '➤ Arrow'),
      modeling ? tool('lasso', 'tool.lasso', '◌ Lasso') : null,
      modeling ? tool('brush', 'tool.brush', '◍ Brush') : null,
      modeling ? tool('deform', 'tool.deformBrush', '✋ Deform') : null,
      modeling ? tool('stroke', 'tool.stroke', '✎ Strokes') : null,
      tool('path', 'tool.path', '〰 Path'),
    ),
    h('span.tb-group', undoButton, redoButton),
    h('span.spacer'),
    h(
      'button.cmd-open',
      { dataset: { testid: 'command-open' }, on: { click: () => commandBar.open() } },
      'Run a command…',
      h('kbd', keymap.shortcut('edit.commandBar')),
    ),
    h(
      'button.access-open',
      { dataset: { testid: 'access-open' }, on: { click: () => access.open() } },
      agentDot,
    ),
    h(
      'button.tb.home',
      { title: 'Home', dataset: { testid: 'home-button' }, on: { click: () => openHome() } },
      '⌂',
    ),
  );
  undoButton.disabled = !editor.session.canUndo;
  redoButton.disabled = !editor.session.canRedo;
}

// ---------------------------------------------------------------- the window

const regionSplitters = (['left', 'right', 'bottom'] as const).map(
  (r) => [r, dock.regionSplitter(r)] as const,
);
const layout = h('div.layout', menubar, toolbar, dock.left, viewArea, dock.right, dock.bottom);
dock.onResize = () => {
  const [l, r, b] = [dock.regionSize('left'), dock.regionSize('right'), dock.regionSize('bottom')];
  layout.style.gridTemplateColumns = `${l}px minmax(0, 1fr) ${r}px`;
  layout.style.gridTemplateRows = `30px 40px minmax(0, 1fr) ${b}px`;
  for (const [name, s] of regionSplitters) {
    const host = dock[name];
    if (!host.contains(s)) host.append(s);
    s.hidden = dock.regionSize(name) === 0;
  }
  requestAnimationFrame(() => viewport.drawOverlay());
};
viewBody.append(status, access.band);

/**
 * View controls (their placement is UNKNOWN item 3: the View area's lower right here):
 * the magnification (type it, or step), full scale (the art's own size), fit, and flip.
 */
const zoomInput = h('input.zoom', {
  type: 'number',
  min: '2',
  max: '3200',
  step: '1',
  title: 'Magnification (%): canvas pixels at 100 % are screen pixels',
  dataset: { testid: 'zoom' },
});
const scaleNow = () => {
  const t = viewport.view.viewTransform;
  return t.pixelsPerUnit / editor.view.project().canvas.pixelsPerUnit;
};
const setScale = (scale: number) => {
  const t = viewport.view.viewTransform;
  const fitted = t.pixelsPerUnit / t.zoom;
  const ppu = editor.view.project().canvas.pixelsPerUnit;
  const s = Math.min(32, Math.max(0.02, scale));
  viewport.view.setView({ zoom: Math.min(64, Math.max(0.05, (s * ppu) / fitted)) });
  viewport.drawOverlay();
  syncZoom();
};
const syncZoom = () => {
  if (document.activeElement !== zoomInput && viewport.view.model)
    zoomInput.value = String(Math.round(scaleNow() * 100));
};
zoomInput.addEventListener('change', () => setScale(Number(zoomInput.value) / 100));
viewport.view.on('frame', syncZoom);
viewBody.append(
  h(
    'div.view-controls',
    { dataset: { testid: 'view-controls' } },
    h('button', { title: 'Zoom out', on: { click: () => setScale(scaleNow() / 1.25) } }, '−'),
    zoomInput,
    h('span', '%'),
    h('button', { title: 'Zoom in', on: { click: () => setScale(scaleNow() * 1.25) } }, '+'),
    h(
      'button',
      {
        title: 'Full scale: the art at its own size',
        dataset: { testid: 'full-scale' },
        on: { click: () => setScale(1) },
      },
      '1:1',
    ),
    h(
      'button',
      {
        title: `Fit (${keymap.shortcut('view.fit')})`,
        on: { click: () => keymap.run('view.fit') },
      },
      'Fit',
    ),
    h(
      'button',
      {
        title: `Flip left and right (${keymap.shortcut('view.rotate')})`,
        on: { click: () => keymap.run('view.rotate') },
      },
      '⇋',
    ),
  ),
);
viewArea.append(tabs.el, h('div.view-row', drawStrip.el, viewBody));
app.append(
  layout,
  dock.floatLayer,
  commandBar.el,
  access.el,
  folderInput,
  zipInput,
  modelInput,
  artInput,
  reimportInput,
);
dock.render();
dock.on('layout', () => renderToolbar());
dock.on('workspace', () => renderToolbar());

// ---------------------------------------------------------------- canvas context menu

viewport.onContextMenu = (e, uid, ctrl) => {
  const v = editor.view;
  if (ctrl && (uid || settings.value.meshList === 'all')) {
    // Ctrl+right-click: a list of ArtMeshes to pick from (by default, those under the pointer).
    const [x, y] = viewport.unflip(e.clientX, e.clientY);
    const list =
      settings.value.meshList === 'all'
        ? v.ofKind('artMesh').map((m) => m.uid)
        : viewport.meshesAt(x, y);
    popupMenu(
      e,
      list.slice(0, 40).map((u) => ({
        label: label(v.get(u)),
        checked: editor.isSelected(u),
        run: () => editor.select(u),
      })),
    ).dataset.testid = 'mesh-list';
    return;
  }
  const items: (MenuItem | null)[] = [];
  const o = uid ? v.get(uid) : undefined;
  if (o && settings.value.ancestorMenu) {
    // The chain of parent deformers, for picking an ancestor.
    let p = o.kind === 'artMesh' ? o.deformer : null;
    while (p) {
      const d = v.get(p) as Warp | Rotation | undefined;
      if (!d) break;
      const target = d.uid;
      items.push({
        label: `Select ${d.exportId}`,
        testid: `ancestor-${d.exportId}`,
        run: () => editor.select(target),
      });
      p = d.parent;
    }
    if (items.length) items.push(null);
  }
  if (o) {
    items.push({ label: `Select ${label(o)}`, run: () => editor.select(o.uid) });
    items.push({
      label: 'Edit Mesh',
      key: keymap.shortcut('mesh.toggle'),
      run: () => (editor.select(o.uid), toggleMeshEdit()),
    });
    items.push({
      label: editor.isHidden(o.uid) ? 'Show' : 'Hide',
      run: () => editor.setHidden([o.uid], !editor.hidden.has(o.uid)),
    });
    items.push({
      label: editor.isLocked(o.uid) ? 'Unlock' : 'Lock',
      run: () => editor.setLocked([o.uid], !editor.locked.has(o.uid)),
    });
    items.push(null);
  }
  items.push(menuItem('view.focus'), menuItem('view.fit'), menuItem('view.rotate'));
  popupMenu(e, items);
};
viewport.onContentsMoved = () =>
  tips.tip(
    'ctrl-deformer',
    `The deformer's contents moved with it. Hold ${keymap.label('Ctrl')} while dragging to move only the deformer and leave its contents in place.`,
  );
viewport.onDeformerEdited = () => {};

// After a person's change to deformers, children that stick out of a parent warp are reported.
editor.on('document', (e) => {
  if (e.author !== 'person' || e.label.startsWith('Undo ') || e.label.startsWith('Redo ')) return;
  const changed = new Set(
    e.changes
      .filter((c) => c.kind === 'warp' || c.kind === 'rotation' || c.kind === 'artMesh')
      .map((c) => c.uid),
  );
  if (changed.size === 0) return;
  for (const x of outsideParents(editor.view, changed).slice(0, 3))
    tips.warn(
      'outside-parent',
      `${x.childId} sticks out of its parent warp ${x.parentId} (${x.points} point(s)): a warp bends only what lies inside it, so a parent must not be smaller than its child.`,
    );
});

// ---------------------------------------------------------------- status and indicators

let statusTimer: ReturnType<typeof setTimeout> | undefined;
editor.on('message', (m) => {
  // Tips go to Tool Details and the Log; the status line over the canvas keeps the rest.
  if (m.code?.startsWith('tip:')) return;
  status.textContent = m.text;
  status.className = `status ${m.level}`;
  status.dataset.code = m.code ?? '';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(
    () => (status.className = 'status fade'),
    m.level === 'error' ? 9000 : m.level === 'warning' ? 7000 : 4000,
  );
});
const refreshTop = () => {
  projectName.textContent = editor.name;
  document.title = `${editor.name} · Mochi Maker`;
  tabs.render();
  renderToolbar();
};
editor.on('project', refreshTop);
editor.on('document', refreshTop);
editor.on('mode', () => {
  renderMenus();
  renderToolbar();
  viewArea.classList.toggle('mesh-editing', editor.meshEdit !== null);
});
editor.on('selection', () => renderToolbar());
editor.on('viewState', () => renderToolbar());
keymap.on('change', () => renderToolbar());
settings.on('change', () => renderMenus());
playback.listeners.add(() => renderToolbar());
renderMenus();
refreshTop();
setInterval(() => {
  const last = agent.calls[agent.calls.length - 1];
  const active =
    host.current ?? (last && Date.now() - last.time < 5000 ? { client: last.author } : null);
  const connected = host.clients.length;
  agentDot.className = `agent-dot ${active ? 'active' : connected ? 'connected' : ''}`;
  agentDot.textContent = active
    ? `${active.client} working`
    : connected
      ? `${connected} agent${connected > 1 ? 's' : ''} connected`
      : host.state === 'connected'
        ? 'Agent access on'
        : 'Agent access';
}, 500);

// A confirm button on the canvas while editing a mesh.
const meshBar = h(
  'div.mesh-bar',
  { dataset: { testid: 'mesh-bar' } },
  h('span', 'Mesh Edit mode'),
  h(
    'button.primary',
    { dataset: { testid: 'mesh-bar-confirm' }, on: { click: () => keymap.run('mesh.confirm') } },
    'Confirm',
  ),
  h('button', { title: 'Cancel (Esc)', on: { click: () => keymap.run('mesh.cancel') } }, '×'),
);
viewBody.append(meshBar);

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  // Esc closes an open menu first.
  const menu = document.querySelector('.ctx-menu');
  if (menu && e.key === 'Escape') {
    menu.remove();
    if (openMenu) closeMenus();
    e.preventDefault();
    return;
  }
  // Dialogs and the command bar handle their own keys.
  const t = e.target as HTMLElement;
  if (t.closest('.dialog, .commandbar:not([hidden])') && !(e.ctrlKey || e.metaKey)) return;
  if (!commandBar.el.hidden && keymap.eventKey(e) !== keymap.keysOf('edit.commandBar')[0]) return;
  keymap.keydown(e);
});
window.addEventListener('keyup', (e) => keymap.keyup(e));
window.addEventListener('blur', () => keymap.releaseAll());

// ---------------------------------------------------------------- Home

function openHome(): void {
  home?.close();
  home = homeDialog(settings, {
    newModel: (w, hh) => {
      editor.newProject({ width: w, height: hh });
      editor.emit('message', { level: 'info', text: `A new model, ${w} × ${hh}.` });
    },
    openFolder: () => folderInput.click(),
    openZip: () => zipInput.click(),
    importArt: (f) => (f ? artDropped(f) : artInput.click()),
  });
}
if (settings.value.homeAtStartup && !new URLSearchParams(location.search).has('nohome')) openHome();

// ---------------------------------------------------------------- agents

window.mochi = agent;
window.mochiEditor = {
  editor,
  viewport,
  offscreen,
  host,
  access,
  link,
  dock,
  keymap,
  settings,
  tabs,
  playback,
  clipboard: objectClipboard,
  desktop,
  psd: () => exportPsd(editor, offscreen),
  templatePreview: () => lastPreview,
  movie: {
    render: (s: MovieSettings) => renderMovie(editor, offscreen, s),
    support: () => videoSupport(),
  },
  timeline,
  templates: templatePalette,
  physics,
  expressions: expressionPalette,
  parts: partsPalette,
  async openFiles(files, name) {
    await editor.openFiles(new Map(Object.entries(files)), name);
    closeHomeOnOpen();
    await viewport.idle();
  },
};
setTool('arrow');
viewport.request(editor.doc, false);
// The desktop build: auto-saved copies, the recovery offer after a crash, and the bridge.
if (desktop) {
  desktop.startAutosave();
  void desktop.offerRecovery();
  void desktop.connectBridge(host);
}

export type { ArtMesh };
