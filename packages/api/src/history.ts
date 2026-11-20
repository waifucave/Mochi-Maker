/**
 * The project's command history, kept in `<project>/.mochi-cache/history.jsonl` (design 4.2).
 *
 * The file is a sequence of segments. Each CLI invocation that changes the project appends one
 * segment: a `base` entry with the hash of the project as loaded, then its transactions. A new
 * project starts with an `init` entry. Replaying chains the segments and checks that each base
 * hash matches the document the previous segments produced, so edits made outside the log are
 * detected instead of silently replayed wrong.
 */
import {
  MochiError,
  documentHash,
  joinPath,
  replay,
  type Document,
  type FileSystem,
  type LogEntry,
} from '@mochi-maker/core';

export const HISTORY = '.mochi-cache/history.jsonl';

export function historyPath(project: string): string {
  return joinPath(project, HISTORY);
}

export async function readHistory(fs: FileSystem, path: string): Promise<LogEntry[]> {
  if (!(await fs.exists(path))) return [];
  const text = await fs.readText(path);
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try {
        return JSON.parse(l) as LogEntry;
      } catch {
        throw new MochiError('E_PROJECT_FORMAT', `${path}, line ${i + 1}: not valid JSON.`);
      }
    });
}

/** Appends a session's log (one segment) to the history file. */
export async function appendHistory(fs: FileSystem, path: string, log: LogEntry[]): Promise<void> {
  if (!log.some((e) => e.op === 'tx' || e.op === 'undo' || e.op === 'redo')) return;
  const before = (await fs.exists(path)) ? await fs.readText(path) : '';
  await fs.writeText(path, before + log.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** Splits a history into segments, each starting with init or base. */
export function segments(entries: LogEntry[]): LogEntry[][] {
  const out: LogEntry[][] = [];
  for (const e of entries) {
    if (e.op === 'init' || e.op === 'base') out.push([e]);
    else if (out.length === 0)
      throw new MochiError(
        'E_PROJECT_FORMAT',
        'The history does not start with an init or base entry.',
      );
    else out[out.length - 1]!.push(e);
  }
  return out;
}

/** Replays a whole history. A history that does not start with `init` needs the base document. */
export function replayHistory(entries: LogEntry[], base?: Document): Document {
  let doc: Document | undefined = base;
  for (const seg of segments(entries)) {
    if (seg[0]!.op === 'init') doc = replay(seg).doc;
    else {
      if (!doc)
        throw new MochiError(
          'E_PROJECT_FORMAT',
          'The history continues a project it does not contain; pass --base <project>.',
        );
      const expected = (seg[0] as Extract<LogEntry, { op: 'base' }>).documentHash;
      if (documentHash(doc) !== expected)
        throw new MochiError(
          'E_REPLAY_DIVERGED',
          `The project was changed outside the history before a segment (expected hash ${expected}, got ${documentHash(doc)}).`,
        );
      doc = replay(seg, doc).doc;
    }
  }
  if (!doc) throw new MochiError('E_PROJECT_FORMAT', 'The history is empty.');
  return doc;
}
