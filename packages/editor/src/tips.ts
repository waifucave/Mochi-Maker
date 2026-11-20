/**
 * Gentle warnings at the point of action. Each tip shows once per
 * session, at the top of Tool Details (until closed) and in the Log palette, unless the settings
 * turn tips off; never over the canvas. Warnings about the person's data (a child
 * outside its parent, an "@" in an ID) always show, in the View area's status line.
 */
import type { Editor } from './editor.js';
import type { SettingsStore } from './settings.js';

export class Tips {
  private readonly shown = new Set<string>();

  constructor(
    private readonly editor: Editor,
    private readonly settings: SettingsStore,
  ) {}

  /** A tip about how the editor works: once per session. */
  tip(id: string, text: string): void {
    if (!this.settings.value.tips || this.shown.has(id)) return;
    this.shown.add(id);
    this.editor.emit('message', { level: 'warning', text, code: `tip:${id}` });
  }

  /** A warning about the data at hand: every time. */
  warn(id: string, text: string): void {
    this.editor.emit('message', { level: 'warning', text, code: `warn:${id}` });
  }
}
