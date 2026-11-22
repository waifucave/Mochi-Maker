/**
 * The live link: while a project is open, the editor watches the source art file and
 * re-imports it when it is saved (art.reimport, one undoable transaction in the history). In the
 * desktop build the main process watches the file and the link checks on its notice.
 *
 * In Chromium the person links the file once (the File System Access API's file handle) and the
 * editor checks it twice a second. Other browsers have no handle; there the person uses
 * Re-import and picks the file again. The desktop build (M14) uses a real file watcher.
 */
import type { ReimportResult } from '@mochi-maker/art';
import { OPERATIONS } from '@mochi-maker/export';
import { runItems } from '@mochi-maker/core';
import { fileBytes } from './limits.js';
import { Emitter, type Editor } from './editor.js';

/** What the link needs from a file: its name, and its current contents. */
export interface LinkedFile {
  name: string;
  getFile(): Promise<File>;
  /**
   * A file watcher (the desktop build): called once, it calls back nothing itself but makes the
   * owner call `check()` on changes; returns the function that stops it. Without it, the link polls.
   */
  watch?(): () => void;
}

export interface LinkStatus {
  file: string | null;
  watching: boolean;
  lastCheck: number;
  lastChange: number;
  last: ReimportResult | null;
  error: string | null;
  /** The file's modification time when it was last read, and what that read led to. */
  seen: number;
  outcome: 'none' | 'imported' | 'unchanged' | 'reimported' | 'failed';
}

type LinkEvents = { status: LinkStatus; reimported: ReimportResult };

export const POLL_MS = 500;
const TYPES = [
  {
    description: 'Layered art',
    accept: {
      'image/vnd.adobe.photoshop': ['.psd'],
      'image/openraster': ['.ora'],
      'image/png': ['.png'],
    },
  },
];

/** Whether this browser can keep a handle on a file (Chromium's File System Access API). */
export const canLink = () =>
  typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function';

export class LiveLink extends Emitter<LinkEvents> {
  status: LinkStatus = {
    file: null,
    watching: false,
    lastCheck: 0,
    lastChange: 0,
    last: null,
    error: null,
    seen: 0,
    outcome: 'none',
  };
  private file: LinkedFile | null = null;
  private seen: { modified: number; size: number } | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  /** Where the running re-import is (for diagnostics). */
  phase = 'idle';

  constructor(private readonly editor: Editor) {
    super();
    editor.on('project', () => this.unlink());
  }

  /** The path the art is stored at in the project's files, so re-imports match the import. */
  static pathFor(name: string): string {
    return `import/${name}`;
  }

  private set(patch: Partial<LinkStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  /** Asks the person for the art file (Chromium), then links it. */
  async pick(): Promise<void> {
    const picker = (
      window as unknown as { showOpenFilePicker: (o: unknown) => Promise<LinkedFile[]> }
    ).showOpenFilePicker;
    const [handle] = await picker({ types: TYPES, multiple: false });
    if (handle) await this.link(handle);
  }

  /**
   * Links a file: if the project already holds layers from it, re-imports it now (so the project
   * matches the file), otherwise imports it; then checks it for changes.
   */
  async link(file: LinkedFile): Promise<void> {
    this.unlink();
    this.file = file;
    this.set({ file: file.name, watching: true, error: null });
    const f = await file.getFile();
    this.seen = { modified: f.lastModified, size: f.size };
    const path = LiveLink.pathFor(file.name);
    const known = this.editor.view.ofKind('layer').some((l) => l.source?.startsWith(`${path}#`));
    await this.apply(f, known ? 'reimport' : 'import');
    if (file.watch) this.stopWatch = file.watch();
    else this.timer = setInterval(() => void this.check(), POLL_MS);
  }

  private stopWatch: (() => void) | null = null;

  unlink(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopWatch?.();
    this.stopWatch = null;
    this.file = null;
    this.seen = null;
    if (this.status.watching) this.set({ watching: false });
  }

  /** One check: re-imports when the file's modification time or size changed. */
  /** Why the last check did nothing (for diagnostics). */
  skipped: string | null = null;

  async check(): Promise<boolean> {
    if (!this.file || this.busy) {
      this.skipped = this.file ? `busy (${this.phase})` : 'no file';
      return false;
    }
    // Never under a person's drag: wait for the next check.
    if (this.editor.inGesture) {
      this.skipped = 'gesture';
      return false;
    }
    this.skipped = null;
    let f: File;
    try {
      f = await this.file.getFile();
    } catch (e) {
      this.set({ error: `Cannot read ${this.file.name}: ${(e as Error).message}` });
      return false;
    }
    this.set({ lastCheck: Date.now() });
    if (this.seen && f.lastModified === this.seen.modified && f.size === this.seen.size)
      return false;
    this.seen = { modified: f.lastModified, size: f.size };
    this.set({ seen: f.lastModified });
    await this.apply(f, 'reimport');
    return true;
  }

  /** Re-imports a file the person picked (the manual path, for every browser). */
  async reimportFile(f: File): Promise<ReimportResult | null> {
    return this.apply(f, 'reimport');
  }

  private async apply(f: File, how: 'import' | 'reimport'): Promise<ReimportResult | null> {
    this.busy = true;
    try {
      const path = LiveLink.pathFor(f.name);
      this.phase = 'reading';
      await this.editor.fs.writeBytes(path, await fileBytes(f));
      this.phase = 'dry run';
      const label = `${how === 'import' ? 'Import' : 'Re-import'} ${f.name}${this.file ? ' (live link)' : ''}`;
      const ctx = { session: this.editor.session, assets: this.editor.assets, fs: this.editor.fs };
      const items = [{ name: how === 'import' ? 'art.import' : 'art.reimport', args: { path } }];
      if (how === 'reimport') {
        // Nothing to change (a save without edits, or linking a file the project already
        // matches): report, but leave the history alone.
        const dry = await runItems(ctx, label, items, { dryRun: true, operations: OPERATIONS });
        if (dry.changes.length === 0) {
          const report = dry.itemResults[0] as ReimportResult;
          this.set({ last: report, error: null, outcome: 'unchanged' });
          return report;
        }
      }
      this.phase = 'commit';
      const r = await runItems(ctx, label, items, { author: 'person', operations: OPERATIONS });
      this.phase = 'report';
      this.set({
        lastChange: Date.now(),
        error: null,
        outcome: how === 'import' ? 'imported' : 'reimported',
      });
      if (how === 'import') {
        this.editor.emit('message', {
          level: 'info',
          text: `Imported ${f.name}${this.file ? '; watching it for changes' : ''}.`,
        });
        return null;
      }
      const report = r.itemResults[0] as ReimportResult;
      this.set({ last: report });
      this.emit('reimported', report);
      this.editor.emit('message', {
        level: 'info',
        text: `Re-imported ${f.name}: ${report.changed.length} changed, ${report.added.length} added, ${report.removed.length} removed; ${report.refit.length} mesh(es) may need re-fitting.`,
      });
      return report;
    } catch (e) {
      this.set({ error: (e as Error).message, outcome: 'failed' });
      this.editor.report(e);
      return null;
    } finally {
      this.busy = false;
      this.phase = 'idle';
    }
  }
}
