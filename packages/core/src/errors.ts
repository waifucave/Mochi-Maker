/**
 * Structured errors (agent API design 2.4).
 *
 * Every error has a stable code, a message that names objects the way people know them, the
 * failing path, and optional machine-applicable fixes.
 */

export const ERROR_CODES = {
  E_SCHEMA: 'An argument or stored value does not match its schema.',
  E_UNKNOWN_COMMAND: 'No command has this name.',
  E_NOT_FOUND: 'A reference names no object.',
  E_WRONG_KIND: 'A reference names an object of the wrong kind.',
  E_AMBIGUOUS_REF: 'A display-name reference matches more than one object.',
  E_BAD_REF: 'A reference is not written in a recognized form.',
  E_DUPLICATE_ID: 'Another object of the same kind already has this export ID.',
  E_BAD_EXPORT_ID: 'An export ID must be 1–63 characters of A–Z, a–z, 0–9 and _.',
  E_IN_USE: 'The object is still referenced; delete with cascade, or remove the references first.',
  E_CYCLE: 'The change would make an object its own ancestor.',
  E_RANGE: 'A value is outside its allowed range.',
  E_DUPLICATE_NAME: 'Another item of the same list already has this name.',
  E_KEY_NOT_ON_PARAMETER: "A key value is not in the parameter's key list.",
  E_KEY_IN_USE: 'A key is still used by a binding.',
  E_ALREADY_BOUND: 'The object is already bound to this parameter.',
  E_NOT_BOUND: 'The object is not bound to this parameter.',
  E_LAST_KEY: 'A binding needs at least one key; remove the binding instead.',
  E_BAD_CELL: 'A keyform cell does not match the object’s bindings.',
  E_FIELD_NOT_APPLICABLE: 'A keyform field does not exist on this kind of object.',
  E_SHAPE: 'An array has the wrong length or contents for the object.',
  E_NOT_RIGGABLE: 'This kind of object has no keyforms.',
  E_INVARIANT: 'The change would leave the document inconsistent.',
  E_REVISION_MISMATCH: 'The document changed since the expected revision.',
  E_NOTHING_TO_UNDO: 'There is nothing to undo.',
  E_NOTHING_TO_REDO: 'There is nothing to redo.',
  E_REPLAY_DIVERGED: 'Replaying the log gave a different result than recorded.',
  E_PROJECT_FORMAT: 'The project files are not a valid Mochi Maker project.',
  E_PROJECT_TOO_NEW: 'The project was written by a newer format version than this reader knows.',
  E_ASSET_MISSING: 'An asset referenced by the document is not available.',
  E_TOPOLOGY: 'The mesh operation is not possible on this mesh (for example, a point outside it).',
  E_BUSY: 'Another transaction is still running in this session.',
  E_ASSET_FORMAT: 'An asset or imported file could not be decoded.',
  E_TOO_LARGE:
    'A file, archive or message is larger than Mochi Maker accepts (docs/limits.md lists the caps); it may be fine, but it is not read.',
  E_EXPORT: 'The document cannot be exported as it is; the details list each problem.',
  E_MODEL_IMPORT:
    'The model folder cannot be imported: an unsupported .moc3 version, a missing or unreadable file, or data the document cannot hold.',
  E_FORBIDDEN:
    'The path or action is outside what this session allows (for example, a directory that was not allowed).',
  E_NO_PROJECT: 'No project is open; open or create one first.',
  E_FEATURE_OFF:
    'The feature is not available in this build (glue or blend shapes; MOCHI_MAKER_FEATURES, the API option `features` or the editor settings switch it on).',
  E_RATE_LIMITED: 'Too many requests in a short time; wait a moment and retry.',
  E_RENDER_UNAVAILABLE:
    'Rendering needs headless Chromium through Playwright, which is not installed here.',
  E_CONTROL_HELD:
    'The person is editing in the editor, or has paused agents; reads, renders and dry runs still work. Retry after retryAfter milliseconds.',
  E_BRIDGE:
    'The live bridge cannot reach the editor: no bridge is running, no editor is connected, or the token is not valid.',
  E_INTERNAL: 'An internal error. Please report it.',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** A suggested fix: either a command to run first, or a replacement value for the failing path. */
export type Fix =
  | { description: string; command: string; args: Record<string, unknown> }
  | { description: string; replace: { path: string; value: unknown } };

export interface ErrorInfo {
  path?: string;
  details?: Record<string, unknown>;
  fixes?: Fix[];
}

export class MochiError extends Error {
  readonly code: ErrorCode;
  path: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly fixes: Fix[];
  /** The failing command inside a transaction, and its index. */
  command: string | undefined;
  at: number | undefined;

  constructor(code: ErrorCode, message: string, info: ErrorInfo = {}) {
    super(message);
    this.name = 'MochiError';
    this.code = code;
    this.path = info.path;
    this.details = info.details;
    this.fixes = info.fixes ?? [];
    this.command = undefined;
    this.at = undefined;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.command !== undefined) out.command = this.command;
    if (this.at !== undefined) out.at = this.at;
    if (this.path !== undefined) out.path = this.path;
    if (this.details !== undefined) out.details = this.details;
    if (this.fixes.length > 0) out.fixes = this.fixes;
    return out;
  }
}

/** Wraps anything thrown into a MochiError. */
export function toMochiError(e: unknown): MochiError {
  if (e instanceof MochiError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new MochiError('E_INTERNAL', message);
}
