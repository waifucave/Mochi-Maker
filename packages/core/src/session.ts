/**
 * Sessions: one open document with transactions, undo and redo, and the replayable log
 * (design 4.2; agent API design 2.3).
 */
import { checkArgs, resolveArgs } from './command.js';
import { COMMANDS, type ArgsOf, type CommandName, type ResultOf } from './commands/index.js';
import {
  applyPatches,
  compareUids,
  DocView,
  Draft,
  emptyDocument,
  type CanvasInit,
  type Document,
  type Patch,
} from './document.js';
import { MochiError, toMochiError } from './errors.js';
import { callFeature, featureOff, featuresFromEnv, type Features } from './features.js';
import { checkInvariants, type Violation } from './invariants.js';
import { lint, type LintResult } from './lint.js';
import type { DocObject, Uid } from './model.js';
import { query, toJson, type QueryOptions, type QueryResult } from './query.js';
import { documentHash } from './serialize.js';
import type { Kind } from './schema.js';

export const LOG_FORMAT = 'mochi-maker-log';
export const LOG_VERSION = 1;

export interface CommandCall {
  name: string;
  args: unknown;
}

export interface RecordedCall extends CommandCall {
  result: unknown;
}

export type LogEntry =
  | { op: 'init'; format: typeof LOG_FORMAT; version: number; canvas: CanvasInit }
  | { op: 'base'; format: typeof LOG_FORMAT; version: number; documentHash: string }
  | { op: 'tx'; revision: number; author: string; label: string; commands: RecordedCall[] }
  | { op: 'undo'; revision: number }
  | { op: 'redo'; revision: number };

export interface TransactionOptions {
  /** Apply, report, and discard. */
  dryRun?: boolean;
  /** Fail with E_REVISION_MISMATCH unless the session is at this revision. */
  expectRevision?: number;
  /** 'person', 'agent:<name>' or 'script:<path>'. */
  author?: string;
}

export interface SessionOptions {
  /** Glue and blend-shape authoring (default: MOCHI_MAKER_FEATURES, else off). */
  features?: Features;
}

export interface ChangeSummary {
  uid: Uid;
  kind: string;
  change: 'added' | 'removed' | 'changed';
}

export interface TransactionResult {
  committed: boolean;
  revision: number;
  results: unknown[];
  changes: ChangeSummary[];
  /** Lint results after the change (dry runs only). */
  lint?: LintResult[];
}

interface HistoryItem {
  label: string;
  author: string;
  patches: Patch[];
}

/** A transaction in progress. Commands run immediately and return their results. */
export class Tx {
  readonly calls: RecordedCall[] = [];
  constructor(
    readonly draft: Draft,
    /** The features this transaction may use (glue, blend shapes); off by default. */
    readonly features: Features = featuresFromEnv(),
  ) {}

  run<N extends CommandName>(name: N, args: ArgsOf<N>): ResultOf<N>;
  run(name: string, args: unknown): unknown;
  run(name: string, args: unknown): unknown {
    const at = this.calls.length;
    const def = COMMANDS.get(name);
    try {
      if (!def)
        throw new MochiError('E_UNKNOWN_COMMAND', `There is no command "${name}".`, {
          details: {
            similar: [...COMMANDS.keys()].filter((n) => n.split('.')[0] === name.split('.')[0]),
          },
        });
      checkArgs(def.args, args);
      const resolved = resolveArgs(
        def.args,
        args,
        this.draft,
        this.calls.map((c) => c.result),
      );
      const feature = callFeature(name, resolved, this.draft);
      if (feature && !this.features[feature]) throw featureOff(feature);
      const result = def.apply(this.draft, resolved as never);
      this.calls.push({ name, args: resolved, result });
      return result;
    } catch (e) {
      const err = toMochiError(e);
      if (err.command === undefined) {
        err.command = name;
        err.at = at;
      }
      throw err;
    }
  }
}

function summarizePatches(patches: Patch[]): ChangeSummary[] {
  return patches.map((p) => ({
    uid: p.uid,
    kind: (p.after ?? p.before)!.kind,
    change: p.before === undefined ? 'added' : p.after === undefined ? 'removed' : 'changed',
  }));
}

export type SessionListener = (event: {
  revision: number;
  author: string;
  label: string;
  changes: ChangeSummary[];
}) => void;

export class Session {
  private current: Document;
  private rev = 0;
  private readonly undoStack: HistoryItem[] = [];
  private readonly redoStack: HistoryItem[] = [];
  private readonly listeners = new Set<SessionListener>();
  readonly log: LogEntry[];

  /**
   * The features this session may use: glue and blend-shape authoring, off unless switched on
   * (`options.features`, else MOCHI_MAKER_FEATURES). A document that holds them opens either way.
   */
  features: Features;

  constructor(doc: Document, log: LogEntry[], options: SessionOptions = {}) {
    this.current = doc;
    this.log = log;
    this.features = options.features ?? featuresFromEnv();
  }

  /** A new, empty project. */
  static create(
    canvas: CanvasInit = { width: 2048, height: 2048 },
    options: SessionOptions = {},
  ): Session {
    return new Session(
      emptyDocument(canvas),
      [{ op: 'init', format: LOG_FORMAT, version: LOG_VERSION, canvas }],
      options,
    );
  }

  /** A session over an existing document (for example, one loaded from disk). */
  static open(doc: Document, options: SessionOptions = {}): Session {
    return new Session(
      doc,
      [{ op: 'base', format: LOG_FORMAT, version: LOG_VERSION, documentHash: documentHash(doc) }],
      options,
    );
  }

  get doc(): Document {
    return this.current;
  }
  get revision(): number {
    return this.rev;
  }
  get view(): DocView {
    return new DocView(this.current);
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  onChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Runs a transaction. `build` calls commands through the Tx; if any fails, nothing is committed
   * and the error names the failing command and its index.
   */
  transact(
    label: string,
    build: (tx: Tx) => void,
    options: TransactionOptions = {},
  ): TransactionResult {
    const tx = this.begin(options);
    build(tx);
    return this.finish(label, tx, options);
  }

  /**
   * Like transact, but `build` may be asynchronous (operations that decode images, for example).
   * While it runs, the session refuses other changes with E_BUSY.
   */
  async transactAsync(
    label: string,
    build: (tx: Tx) => Promise<void>,
    options: TransactionOptions = {},
  ): Promise<TransactionResult> {
    const tx = this.begin(options);
    this.busy = true;
    try {
      await build(tx);
    } finally {
      this.busy = false;
    }
    return this.finish(label, tx, options);
  }

  private busy = false;

  private checkIdle(): void {
    if (this.busy)
      throw new MochiError('E_BUSY', 'Another transaction is still running in this session.');
  }

  private begin(options: TransactionOptions): Tx {
    this.checkIdle();
    if (options.expectRevision !== undefined && options.expectRevision !== this.rev)
      throw new MochiError(
        'E_REVISION_MISMATCH',
        `The document is at revision ${this.rev}, not ${options.expectRevision}.`,
        {
          details: {
            revision: this.rev,
            expected: options.expectRevision,
            since: this.changesSince(options.expectRevision),
          },
        },
      );
    return new Tx(new Draft(this.current), this.features);
  }

  private finish(label: string, tx: Tx, options: TransactionOptions): TransactionResult {
    const { doc, patches } = tx.draft.finish();
    const violations = checkInvariants(new DocView(doc));
    if (violations.length > 0)
      throw new MochiError(
        'E_INVARIANT',
        `The transaction would leave the document inconsistent: ${violations[0]!.uid} ${violations[0]!.path}: ${violations[0]!.message}`,
        {
          details: { violations: violations.slice(0, 50) },
        },
      );
    const results = tx.calls.map((c) => c.result);
    const changes = summarizePatches(patches);
    if (options.dryRun)
      return {
        committed: false,
        revision: this.rev,
        results,
        changes,
        lint: lint(new DocView(doc)),
      };

    const author = options.author ?? 'person';
    this.current = doc;
    this.rev++;
    this.undoStack.push({ label, author, patches });
    this.redoStack.length = 0;
    this.log.push({ op: 'tx', revision: this.rev, author, label, commands: tx.calls });
    this.emit({ revision: this.rev, author, label, changes });
    return { committed: true, revision: this.rev, results, changes };
  }

  /**
   * Runs a list of commands as one transaction. In arguments that name objects, `$n` (or `$n.field`)
   * refers to the result of command n.
   */
  runBatch(
    label: string,
    calls: CommandCall[],
    options: TransactionOptions = {},
  ): TransactionResult {
    return this.transact(
      label,
      (tx) => {
        for (const c of calls) tx.run(c.name, c.args);
      },
      options,
    );
  }

  /** Runs one command as its own transaction. */
  run<N extends CommandName>(
    name: N,
    args: ArgsOf<N>,
    options: TransactionOptions = {},
  ): ResultOf<N> {
    return this.transact(name, (tx) => tx.run(name, args), options).results[0] as ResultOf<N>;
  }

  undo(): TransactionResult {
    this.checkIdle();
    const item = this.undoStack.pop();
    if (!item) throw new MochiError('E_NOTHING_TO_UNDO', 'There is nothing to undo.');
    this.current = { ...applyPatches(this.current, item.patches, 'back'), seq: this.current.seq };
    this.redoStack.push(item);
    this.rev++;
    this.log.push({ op: 'undo', revision: this.rev });
    const changes = summarizePatches(
      item.patches.map((p) => ({ uid: p.uid, before: p.after, after: p.before })),
    );
    this.emit({ revision: this.rev, author: item.author, label: `Undo ${item.label}`, changes });
    return { committed: true, revision: this.rev, results: [], changes };
  }

  redo(): TransactionResult {
    this.checkIdle();
    const item = this.redoStack.pop();
    if (!item) throw new MochiError('E_NOTHING_TO_REDO', 'There is nothing to redo.');
    this.current = {
      ...applyPatches(this.current, item.patches, 'forward'),
      seq: this.current.seq,
    };
    this.undoStack.push(item);
    this.rev++;
    this.log.push({ op: 'redo', revision: this.rev });
    const changes = summarizePatches(item.patches);
    this.emit({ revision: this.rev, author: item.author, label: `Redo ${item.label}`, changes });
    return { committed: true, revision: this.rev, results: [], changes };
  }

  /** Labels of the undo stack, oldest first. */
  history(): { label: string; author: string }[] {
    return this.undoStack.map(({ label, author }) => ({ label, author }));
  }

  /** Objects changed since a revision, from the log (best effort, for conflict reports). */
  changesSince(revision: number): { revision: number; label: string; author: string }[] {
    return this.log
      .filter((e): e is Extract<LogEntry, { op: 'tx' }> => e.op === 'tx' && e.revision > revision)
      .map((e) => ({ revision: e.revision, label: e.label, author: e.author }));
  }

  query(q: QueryOptions = {}): QueryResult {
    return query(this.view, q);
  }

  /** The full JSON form of one object. */
  get(ref: string, kinds?: Kind[]): Record<string, unknown> {
    const view = this.view;
    const uid = view.resolve(ref, kinds ?? (Object.keys(UID_KINDS) as Kind[]));
    return toJson(view.get(uid) as DocObject);
  }

  validate(): { violations: Violation[]; lint: LintResult[] } {
    return { violations: checkInvariants(this.view), lint: lint(this.view) };
  }

  private emit(event: Parameters<SessionListener>[0]): void {
    for (const l of this.listeners) l(event);
  }
}

const UID_KINDS: Record<Kind, true> = {
  project: true,
  parameter: true,
  parameterGroup: true,
  part: true,
  artMesh: true,
  warp: true,
  rotation: true,
  layer: true,
  glue: true,
  expression: true,
  motion: true,
  physicsSetting: true,
  motionSyncSetting: true,
  sound: true,
};

/**
 * Rebuilds a session from a log. A log that starts with `base` needs the base document, whose hash
 * must match. Each recorded result must be reproduced, or replay fails with E_REPLAY_DIVERGED.
 */
export function replay(log: LogEntry[], base?: Document): Session {
  const [first, ...rest] = log;
  if (!first || (first.op !== 'init' && first.op !== 'base'))
    throw new MochiError('E_PROJECT_FORMAT', 'A log starts with an init or base entry.');
  if (first.version > LOG_VERSION)
    throw new MochiError(
      'E_PROJECT_TOO_NEW',
      `The log has version ${first.version}; this reader knows ${LOG_VERSION}.`,
    );
  let session: Session;
  if (first.op === 'init') session = Session.create(first.canvas);
  else {
    if (!base)
      throw new MochiError(
        'E_PROJECT_FORMAT',
        'This log continues a saved project; the base project is needed.',
      );
    const hash = documentHash(base);
    if (hash !== first.documentHash)
      throw new MochiError(
        'E_REPLAY_DIVERGED',
        `The base project's hash is ${hash}, but the log expects ${first.documentHash}.`,
      );
    session = Session.open(base);
  }
  for (const entry of rest) {
    if (entry.op === 'undo') session.undo();
    else if (entry.op === 'redo') session.redo();
    else if (entry.op === 'tx') {
      const r = session.runBatch(entry.label, entry.commands, { author: entry.author });
      entry.commands.forEach((c, i) => {
        if (JSON.stringify(r.results[i]) !== JSON.stringify(c.result))
          throw new MochiError(
            'E_REPLAY_DIVERGED',
            `Revision ${entry.revision}, command ${i} (${c.name}) gave a different result.`,
            {
              details: { expected: c.result, actual: r.results[i] },
            },
          );
      });
    } else throw new MochiError('E_PROJECT_FORMAT', `Unexpected log entry "${entry.op}".`);
  }
  return session;
}

export { compareUids };
