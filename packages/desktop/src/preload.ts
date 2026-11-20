/**
 * The page's only door to the desktop: `window.mochiDesktop`, a narrow API over the
 * main process's handlers. No Node reaches the page; every path is checked in the main process.
 */
import { contextBridge, ipcRenderer } from 'electron';

type Files = [string, Uint8Array][];
const call = (channel: string, args?: Record<string, unknown>) => ipcRenderer.invoke(channel, args);

contextBridge.exposeInMainWorld('mochiDesktop', {
  info: () => call('app:info'),
  openProject: () => call('project:open'),
  openRecent: (dir: string) => call('project:openRecent', { dir }),
  saveProject: (dir: string | null, name: string, files: Files, key: string) =>
    call('project:save', { dir, name, files, key }),
  pickArt: () => call('art:pick'),
  readArt: (path: string) => call('art:read', { path }),
  watchArt: (path: string) => call('art:watch', { path }),
  unwatchArt: () => call('art:unwatch'),
  onArtChanged: (fn: (path: string) => void) => {
    ipcRenderer.on('art:changed', (_e, path: string) => fn(path));
  },
  pickPhysics: () => call('physics:pick'),
  exportToFolder: (files: Files) => call('export:folder', { files }),
  recent: () => call('recent:list'),
  autosave: (key: string, name: string, dir: string | null, files: Files) =>
    call('autosave:save', { key, name, dir, files }),
  recovery: () => call('autosave:recovery'),
  readAutosave: (key: string, time: number) => call('autosave:read', { key, time }),
  clearAutosave: (key: string) => call('autosave:clear', { key }),
  bridge: () => call('bridge:info'),
  setDirty: (dirty: boolean, name: string, key: string) => call('app:dirty', { dirty, name, key }),
  onSaveAndClose: (fn: () => void) => {
    ipcRenderer.on('app:save-and-close', () => fn());
  },
  closeWindow: () => call('app:close'),
});
