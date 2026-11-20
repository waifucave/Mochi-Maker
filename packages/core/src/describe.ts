/**
 * Self-description of the command catalog and the document schema (agent API design 2.2).
 * Operations (operations.ts) are described the same way when the caller passes them.
 */
import type { CommandDef } from './command.js';
import { COMMANDS } from './commands/index.js';
import { ERROR_CODES, MochiError } from './errors.js';
import { commandFeature, featuresFromEnv, type Features } from './features.js';
import { OBJECT_SCHEMAS } from './model.js';
import type { OperationDef } from './operations.js';
import { toJsonSchema, type Kind } from './schema.js';

export interface CommandSummary {
  name: string;
  /** 'command': pure, synchronous; 'operation': may read assets or files, runs asynchronously. */
  kind: 'command' | 'operation';
  summary: string;
  /** False when the command needs a feature that is off in this build (glue, blend shapes). */
  available?: false;
}

export interface CommandDescription extends CommandSummary {
  /** Bridge-protocol metadata: who may run it, whether undo reverts it, whether it only looks. */
  scope: 'read' | 'edit' | 'export';
  undoable: boolean;
  readOnly: boolean;
  doc: string;
  args: unknown;
  result: unknown;
  errors: { code: string; meaning: string }[];
  examples: { description: string; args: Record<string, unknown> }[];
}

type Entry = { kind: 'command' | 'operation'; def: CommandDef | OperationDef };

const OFF = 'Not available in this build. ';

/** The summary as described with these features: unavailable commands say so first. */
function availability(name: string, summary: string, features: Features) {
  const f = commandFeature(name);
  return f && !features[f] ? { summary: OFF + summary, available: false as const } : { summary };
}

function entries(operations: readonly OperationDef[]): Entry[] {
  return [
    ...[...COMMANDS.values()].map((def) => ({ kind: 'command' as const, def })),
    ...operations.map((def) => ({ kind: 'operation' as const, def })),
  ];
}

export function listCommands(
  operations: readonly OperationDef[] = [],
  features: Features = featuresFromEnv(),
): CommandSummary[] {
  return entries(operations)
    .map(({ kind, def }) => ({
      name: def.name,
      kind,
      ...availability(def.name, def.summary, features),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function describeCommand(
  name: string,
  operations: readonly OperationDef[] = [],
  features: Features = featuresFromEnv(),
): CommandDescription {
  const e = entries(operations).find((x) => x.def.name === name);
  if (!e)
    throw new MochiError('E_UNKNOWN_COMMAND', `There is no command or operation "${name}".`, {
      details: {
        similar: searchCommands(name, operations)
          .slice(0, 5)
          .map((s) => s.name),
      },
    });
  const c = e.def;
  return {
    name: c.name,
    kind: e.kind,
    ...availability(c.name, c.summary, features),
    scope: c.scope ?? 'edit',
    undoable: c.undoable ?? true,
    readOnly: (c.scope ?? 'edit') === 'read',
    doc: c.doc,
    args: toJsonSchema(c.args),
    result: toJsonSchema(c.result),
    errors: [...c.errors, ...(commandFeature(c.name) ? (['E_FEATURE_OFF'] as const) : [])].map(
      (code) => ({ code, meaning: ERROR_CODES[code as keyof typeof ERROR_CODES] }),
    ),
    examples: c.examples,
  };
}

/** Commands and operations ranked by how well their name, summary and doc match the words of `text`. */
export function searchCommands(
  text: string,
  operations: readonly OperationDef[] = [],
  features: Features = featuresFromEnv(),
): CommandSummary[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const scored = entries(operations).map(({ kind, def: c }) => {
    const name = c.name.toLowerCase();
    const summary = c.summary.toLowerCase();
    const doc = c.doc.toLowerCase();
    let score = 0;
    for (const w of words)
      score +=
        (name.includes(w) ? 5 : 0) + (summary.includes(w) ? 3 : 0) + (doc.includes(w) ? 1 : 0);
    return { name: c.name, kind, summary: c.summary, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    .map(({ name, kind, summary }) => ({ name, kind, ...availability(name, summary, features) }));
}

export function objectSchema(kind: Kind): unknown {
  return toJsonSchema(OBJECT_SCHEMAS[kind]);
}

export function errorCodes(): { code: string; meaning: string }[] {
  return Object.entries(ERROR_CODES).map(([code, meaning]) => ({ code, meaning }));
}
