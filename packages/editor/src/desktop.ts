/**
 * The editor in the desktop build (M14). When the page runs in Mochi Maker's Electron
 * window, the preload gives it `window.mochiDesktop`, and this module takes over the File menu's
 * work: native dialogs, project folders saved straight to disk, recent projects, export to a
 * folder, art and physics imports, auto-saved copies with recovery after a crash, the live link
 * on a file watcher, and the bridge in the main process. The browser build never loads any of it.
 */
import { exportModel } from '@mochi-maker/export';
import { h } from './dom.js';
import { dialog } from './dialogs.js';
import type { Editor } from './editor.js';
import type { BridgeHost } from './host.js';
import type { LiveLink } from './livelink.js';

type Files = [string, Uint8Array][];

/** The preload's API (packages/desktop/src/preload.ts). */
export interface DesktopApi {
  info(): Promise<{ version: string; platform: string; autosaveFolder: string; keep: number }>;
  openProject(): Promise<{ dir: string; name: string; files: Files } | null>;
  openRecent(dir: string): Promise<{ dir: string; name: string; files: Files }>;
  saveProject(
    dir: string | null,
    name: string,
    files: Files,
    key: string,
  ): Promise<{ dir: string; name: string } | null>;
  pickArt(): Promise<{ path: string; name: string; bytes: Uint8Array; mtime: number } | null>;
  readArt(path: string): Promise<{ bytes: Uint8Array; mtime: number; size: number }>;
  watchArt(path: string): Promise<boolean>;
  unwatchArt(): Promise<boolean>;
  onArtChanged(fn: (path: string) => void): void;
  pickPhysics(): Promise<{ path: string; name: string; text: string } | null>;
  exportToFolder(files: Files): Promise<{ dir: string } | null>;
  recent(): Promise<string[]>;
  autosave(key: string, name: string, dir: string | null, files: Files): Promise<unknown>;
  recovery(): Promise<{ key: string; name: string; dir: string | null; time: number }[]>;
  readAutosave(key: string, time: number): Promise<Files>;
  clearAutosave(key: string): Promise<void>;
  bridge(): Promise<{ url: string; port: number; pairingCode: string } | { error: string }>;
  /** Tells the main process whether closing the window would lose work. */
  setDirty(dirty: boolean, name: string, key: string): Promise<void>;
  /** The person chose Save when closing: save, then close. */
  onSaveAndClose(fn: () => void): void;
  closeWindow(): Promise<void>;
}

export const desktopApi = (): DesktopApi | null =>
  (window as unknown as { mochiDesktop?: DesktopApi }).mochiDesktop ?? null;

/** How often unsaved work is copied. */
export const AUTOSAVE_MS = 60_000;

export class DesktopFiles {
  /** The open project's folder on disk (null: never saved). */
  dir: string | null = null;
  /** The auto-save key of the open project (new for each project opened or made). */
  key = DesktopFiles.newKey();
  /** The revision last saved to disk. */
  saved = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reported = '';

  constructor(
    private readonly editor: Editor,
    readonly api: DesktopApi,
    private readonly link: LiveLink,
  ) {
    editor.on('project', () => {
      this.saved = editor.session.revision;
      this.report();
    });
    editor.on('document', () => this.report());
    api.onArtChanged(() => void link.check());
    // Closing with unsaved work: the main process asks Save, Don't Save or Cancel; on Save the
    // window closes once the save is done (and stays open if it was cancelled or failed).
    api.onSaveAndClose(() => {
      void this.save()
        .then((ok) => (ok ? this.api.closeWindow() : undefined))
        .catch((e) => this.editor.report(e));
    });
  }

  /** Keeps the main process told whether there is unsaved work (for the question on close). */
  report(): void {
    const state = JSON.stringify([this.dirty, this.editor.name, this.key]);
    if (state === this.reported) return;
    this.reported = state;
    void this.api.setDirty(this.dirty, this.editor.name, this.key);
  }

  static newKey(): string {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  get dirty(): boolean {
    return this.editor.session.revision !== this.saved;
  }

  private async load(r: { dir: string | null; name: string; files: Files }): Promise<void> {
    await this.editor.openFiles(new Map(r.files), r.name);
    this.dir = r.dir;
    this.key = DesktopFiles.newKey();
    this.saved = this.editor.session.revision;
    this.report();
    this.editor.emit('message', { level: 'info', text: `Opened ${r.dir ?? r.name}.` });
  }

  async open(): Promise<void> {
    const r = await this.api.openProject();
    if (r) await this.load(r);
  }

  async openRecent(dir: string): Promise<void> {
    await this.load(await this.api.openRecent(dir));
  }

  /** Saves to the project's folder (asking for one the first time, or with `as`). */
  async save(as = false): Promise<boolean> {
    const files = [...(await this.editor.saveFiles())];
    const r = await this.api.saveProject(as ? null : this.dir, this.editor.name, files, this.key);
    if (!r) return false;
    this.dir = r.dir;
    if (this.editor.name !== r.name) {
      this.editor.name = r.name;
      this.editor.emit('project', undefined);
    }
    this.saved = this.editor.session.revision;
    this.report();
    this.editor.emit('message', { level: 'info', text: `Saved ${r.dir}.` });
    return true;
  }

  /** Imports art from a file chosen in a dialog, and links it (the file watcher re-imports). */
  async importArt(): Promise<void> {
    const r = await this.api.pickArt();
    if (!r) return;
    await this.linkFile(r.path, r.name);
  }

  /** The live link on a real file: read through the main process, re-read when it changes. */
  async linkFile(path: string, name: string): Promise<void> {
    const api = this.api;
    await this.link.link({
      name,
      async getFile() {
        const f = await api.readArt(path);
        return new File([f.bytes as BlobPart], name, { lastModified: Math.round(f.mtime) });
      },
      watch: () => {
        void api.watchArt(path);
        return () => void api.unwatchArt();
      },
    });
  }

  async importPhysics(): Promise<void> {
    const r = await this.api.pickPhysics();
    if (!r) return;
    const res = await this.editor.runItems(`Import ${r.name}`, [
      { name: 'physics.import', args: { text: r.text } },
    ]);
    const out = res?.itemResults[0] as
      | { added: string[]; replaced: string[]; unmatched: { setting: string; parameter: string }[] }
      | undefined;
    if (out)
      this.editor.emit('message', {
        level: out.unmatched.length ? 'warning' : 'info',
        text: `${r.name}: ${out.added.length} physics group(s) added, ${out.replaced.length} replaced${
          out.unmatched.length
            ? `; no parameter for ${out.unmatched.map((u) => `${u.setting}'s ${u.parameter}`).join(', ')}`
            : ''
        }.`,
      });
  }

  /** Exports the .moc3 set (or the motions) into a folder chosen in a dialog. */
  async exportToFolder(only?: 'motions'): Promise<void> {
    const r = await exportModel(this.editor.doc, this.editor.assets, {
      features: this.editor.features,
    });
    const files = [...r.files].filter(([p]) => !only || p.endsWith('.motion3.json'));
    const out = await this.api.exportToFolder(files);
    if (out)
      this.editor.emit('message', {
        level: 'info',
        text: `Exported version ${r.report.mocVersion} to ${out.dir}: ${files.length} files.`,
      });
  }

  /** Copies unsaved work every minute. */
  startAutosave(ms = AUTOSAVE_MS): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.autosaveNow(), ms);
  }

  async autosaveNow(): Promise<boolean> {
    if (!this.dirty) return false;
    const files = [...(await this.editor.saveFiles())];
    await this.api.autosave(this.key, this.editor.name, this.dir, files);
    return true;
  }

  /** After a crash: offers the copies the last session left. */
  async offerRecovery(): Promise<void> {
    const list = await this.api.recovery();
    if (list.length === 0) return;
    const d = dialog(
      'Recover unsaved work',
      [
        h(
          'div.facts',
          'Mochi Maker closed without saving these projects. Their latest auto-saved copies can be opened.',
        ),
        h(
          'div.rows',
          list.map((m) =>
            h(
              'div.row',
              h('span', `${m.name} — ${new Date(m.time).toLocaleString()}`),
              h(
                'button.primary',
                {
                  dataset: { testid: `recover-${m.key}` },
                  on: {
                    click: async () => {
                      d.close();
                      const files = await this.api.readAutosave(m.key, m.time);
                      await this.load({ dir: m.dir, name: m.name, files });
                      // Not saved yet: the recovered copy counts as unsaved work.
                      this.saved = -1;
                      this.key = m.key;
                      this.report();
                    },
                  },
                },
                'Recover',
              ),
              h(
                'button',
                {
                  on: {
                    click: async () => {
                      await this.api.clearAutosave(m.key);
                      d.close();
                    },
                  },
                },
                'Discard',
              ),
            ),
          ),
        ),
      ],
      { testid: 'recovery' },
    );
  }

  /** Connects to the bridge in the main process, pairing with its code (the window is the person's). */
  async connectBridge(host: BridgeHost): Promise<void> {
    const b = await this.api.bridge();
    if ('error' in b) {
      this.editor.emit('message', { level: 'warning', text: b.error });
      return;
    }
    const state = await host.connect(b.url);
    if (state === 'pairing') host.pair(b.pairingCode);
  }
}
