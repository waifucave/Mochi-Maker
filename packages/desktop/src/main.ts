/**
 * Mochi Maker's desktop build (M14): the editor in an Electron window.
 *
 * - The page comes from the app's own `mochi://app/` scheme, with a content security policy; it
 *   has no Node, runs sandboxed with context isolation, and reaches the disk only through the
 *   preload's narrow API, whose every path the main process checks (`PathGuard`).
 * - Files: native dialogs to open and save project folders, import art and physics files, and
 *   export to a folder; recent projects; saves straight to disk.
 * - Auto-saved copies of unsaved projects, offered after a crash (`Autosaves`); closing with
 *   unsaved work asks Save, Don't Save or Cancel.
 * - The live link watches the art file on disk.
 * - The bridge runs here, on 127.0.0.1:47831, so agents reach the app as they reach the browser.
 * - The in-window menus stay; macOS gets the minimal application menu it needs.
 */
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  type IpcMainInvokeEvent,
} from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, normalize, relative, sep } from 'node:path';
import { Autosaves } from './autosave.js';
import { APP_ORIGIN, startBridge, type DesktopBridge } from './bridge.js';
import { PathGuard } from './guard.js';
import { isFolder, readFolder, writeFolder, writeProject } from './projectfs.js';
import { Recent } from './recent.js';

const here = import.meta.dirname;
const RENDERER = join(here, 'renderer');

/** The page's content security policy: its own scripts only, and the bridge on loopback. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: ws://127.0.0.1:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

// Where the app keeps its data (auto-saves, recent projects, bridge tokens): MOCHI_DESKTOP_USER_DATA
// moves it, for tests and portable use.
if (process.env.MOCHI_DESKTOP_USER_DATA)
  app.setPath('userData', process.env.MOCHI_DESKTOP_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'mochi', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const guard = new PathGuard();
let autosaves: Autosaves;
let recent: Recent;
let bridge: DesktopBridge | { error: string } = { error: 'The bridge has not started yet.' };
let win: BrowserWindow | null = null;
let watcher: FSWatcher | null = null;
/** What the page last said about unsaved work, for the question on close. */
let unsaved = { dirty: false, name: '', key: '' };
/** Set once the person has answered (or the page saved): the next close goes through. */
let closing = false;

/**
 * Test hook: MOCHI_DESKTOP_PICKS is a JSON list of what the next dialogs return (a path, or null
 * for a cancelled dialog), in order, so an end-to-end test can drive them.
 */
const picks: (string | null)[] | null = process.env.MOCHI_DESKTOP_PICKS
  ? (JSON.parse(process.env.MOCHI_DESKTOP_PICKS) as (string | null)[])
  : null;

async function pick(
  kind: 'folder' | 'file' | 'save',
  options: {
    title: string;
    filters?: { name: string; extensions: string[] }[];
    defaultPath?: string;
  },
): Promise<string | null> {
  if (picks) return picks.length ? (picks.shift() ?? null) : null;
  if (!win) return null;
  if (kind === 'save') {
    const r = await dialog.showSaveDialog(win, {
      title: options.title,
      defaultPath: options.defaultPath,
    });
    return r.canceled || !r.filePath ? null : r.filePath;
  }
  const r = await dialog.showOpenDialog(win, {
    title: options.title,
    filters: options.filters,
    properties: kind === 'folder' ? ['openDirectory', 'createDirectory'] : ['openFile'],
  });
  return r.canceled ? null : (r.filePaths[0] ?? null);
}

/** Closing with unsaved work: Save, Don't Save or Cancel (a test pick: "save", "discard", "cancel"). */
async function askClose(w: BrowserWindow): Promise<'save' | 'discard' | 'cancel'> {
  if (picks) {
    const p = picks.shift();
    return p === 'save' || p === 'discard' ? p : 'cancel';
  }
  const r = await dialog.showMessageBox(w, {
    type: 'question',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Mochi Maker',
    message: `${unsaved.name || 'This project'} has changes that are not saved.`,
    detail: 'Save them before closing? An auto-saved copy is not kept once you close.',
  });
  return (['save', 'discard', 'cancel'] as const)[r.response] ?? 'cancel';
}

const projectName = (dir: string) => basename(dir).replace(/\.mochi$/i, '');

type Files = [string, Uint8Array][];
const filesArg = (v: unknown): Files => {
  if (!Array.isArray(v)) throw new Error('Expected a list of files.');
  return v.map((e) => {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !(e[1] instanceof Uint8Array))
      throw new Error('Expected [path, bytes] pairs.');
    return [e[0], e[1]] as [string, Uint8Array];
  });
};

async function openFolder(dir: string) {
  await guard.allow(dir);
  const files = await readFolder(dir);
  await recent.add(dir);
  return { dir, name: projectName(dir), files };
}

/** Every IPC handler: the preload's API, one channel each. */
const handlers: Record<string, (e: IpcMainInvokeEvent, a: Record<string, unknown>) => unknown> = {
  'app:info': () => ({
    version: app.getVersion(),
    platform: process.platform,
    autosaveFolder: autosaves.root,
    keep: autosaves.keep,
  }),
  'project:open': async () => {
    const dir = await pick('folder', { title: 'Open Project Folder' });
    if (!dir) return null;
    if (!(await isFolder(dir))) throw new Error(`${dir} is not a folder.`);
    return openFolder(dir);
  },
  'project:openRecent': async (_e, a) => {
    const dir = String(a.dir);
    if (!(await recent.list()).includes(dir)) throw new Error(`${dir} is not a recent project.`);
    return openFolder(dir);
  },
  'project:save': async (_e, a) => {
    let dir = typeof a.dir === 'string' ? await guard.check(a.dir) : null;
    if (!dir) {
      const p = await pick('save', {
        title: 'Save Project Folder',
        defaultPath: `${String(a.name ?? 'model')}.mochi`,
      });
      if (!p) return null;
      dir = p.toLowerCase().endsWith('.mochi') ? p : `${p}.mochi`;
      await guard.allow(dir);
    }
    await writeProject(dir, filesArg(a.files));
    await recent.add(dir);
    if (typeof a.key === 'string') await autosaves.clear(a.key);
    return { dir, name: projectName(dir) };
  },
  'art:pick': async () => {
    const p = await pick('file', {
      title: 'Import Art',
      filters: [{ name: 'Layered art', extensions: ['psd', 'ora', 'png'] }],
    });
    if (!p) return null;
    await guard.allow(p);
    const s = await stat(p);
    return {
      path: p,
      name: basename(p),
      bytes: new Uint8Array(await readFile(p)),
      mtime: s.mtimeMs,
    };
  },
  'art:read': async (_e, a) => {
    const p = await guard.check(a.path);
    const s = await stat(p);
    return { bytes: new Uint8Array(await readFile(p)), mtime: s.mtimeMs, size: s.size };
  },
  'art:watch': async (e, a) => {
    const p = await guard.check(a.path);
    watcher?.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Saves often arrive as several events: one notice, a moment after the last.
    watcher = watch(p, () => {
      clearTimeout(timer);
      timer = setTimeout(() => e.sender.send('art:changed', p), 150);
    });
    return true;
  },
  'art:unwatch': () => {
    watcher?.close();
    watcher = null;
    return true;
  },
  'physics:pick': async () => {
    const p = await pick('file', {
      title: 'Import Physics',
      filters: [{ name: 'Physics', extensions: ['json'] }],
    });
    if (!p) return null;
    await guard.allow(p);
    return { path: p, name: basename(p), text: await readFile(p, 'utf8') };
  },
  'export:folder': async (_e, a) => {
    const dir = await pick('folder', { title: 'Export to Folder' });
    if (!dir) return null;
    await guard.allow(dir);
    await writeFolder(dir, filesArg(a.files));
    return { dir };
  },
  'recent:list': () => recent.list(),
  'autosave:save': async (_e, a) =>
    autosaves.save(
      {
        key: String(a.key),
        name: String(a.name),
        dir: typeof a.dir === 'string' ? a.dir : null,
      },
      filesArg(a.files),
    ),
  'autosave:recovery': async () => (autosaves.crashed ? autosaves.latest() : []),
  'autosave:read': async (_e, a) => {
    const files = await autosaves.read(String(a.key), Number(a.time));
    // A recovered project with a folder may be saved back there.
    const meta = (await autosaves.latest()).find((m) => m.key === a.key);
    if (meta?.dir) await guard.allow(meta.dir);
    return files;
  },
  'autosave:clear': async (_e, a) => autosaves.clear(String(a.key)),
  'bridge:info': () =>
    'server' in bridge
      ? { url: bridge.url, port: bridge.port, pairingCode: bridge.server.pairingCode }
      : { error: bridge.error },
  'app:dirty': (_e, a) => {
    unsaved = { dirty: a.dirty === true, name: String(a.name ?? ''), key: String(a.key ?? '') };
  },
  'app:close': () => {
    closing = true;
    win?.close();
  },
};

/** Closing the window with unsaved work asks first; Save lets the page save, then close. */
function guardClose(w: BrowserWindow): void {
  w.on('close', (e) => {
    if (closing || !unsaved.dirty) return;
    e.preventDefault();
    void askClose(w).then(async (answer) => {
      if (answer === 'save') w.webContents.send('app:save-and-close');
      else if (answer === 'discard') {
        // The person chose to lose the changes: their auto-saved copies go too.
        await autosaves.clear(unsaved.key).catch(() => undefined);
        closing = true;
        w.close();
      }
    });
  });
}

function serveRenderer(): void {
  protocol.handle('mochi', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '') || 'index.html';
    const file = join(RENDERER, rel);
    const r = relative(RENDERER, file);
    if (r.startsWith('..') || r.startsWith(sep)) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Mochi Maker',
    show: process.env.MOCHI_DESKTOP_HIDDEN !== '1',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // The page stays on the app: no navigation away, no new windows.
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void w.loadURL(`${APP_ORIGIN}/index.html`);
  return w;
}

/** macOS needs an application menu (quit, and the edit roles that make copy and paste work). */
function setMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]),
  );
}

app.whenReady().then(async () => {
  const data = app.getPath('userData');
  autosaves = new Autosaves(join(data, 'autosave'));
  await autosaves.begin();
  recent = new Recent(join(data, 'recent.json'));
  if (process.env.MOCHI_DESKTOP_NO_BRIDGE !== '1')
    bridge = await startBridge(join(data, 'bridge-state.json'), {
      port: process.env.MOCHI_DESKTOP_BRIDGE_PORT
        ? Number(process.env.MOCHI_DESKTOP_BRIDGE_PORT)
        : undefined,
    });
  for (const [channel, fn] of Object.entries(handlers))
    ipcMain.handle(channel, async (e, a) => {
      // Only the app's own page may call.
      if (!e.senderFrame?.url.startsWith(`${APP_ORIGIN}/`)) throw new Error('Not the app.');
      return fn(e, (a ?? {}) as Record<string, unknown>);
    });
  serveRenderer();
  setMenu();
  win = createWindow();
  // Only the clipboard: no camera, microphone, notifications or the rest.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, done) =>
    done(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'),
  );
  guardClose(win);
  win.on('closed', () => (win = null));
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  watcher?.close();
  void autosaves?.end();
  if ('server' in bridge) void bridge.server.close();
});
