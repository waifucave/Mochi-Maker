/**
 * Operations: schema-described actions that need more than the document, such as decoding layer
 * images or reading files. An operation runs asynchronously inside a transaction and
 * changes the document only by running ordinary commands, so the log records plain commands and
 * replays without the operation's inputs. A list of items can mix commands and operations, and
 * `$n` refers to item n's result either way.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import { checkArgs, resolveArgs, type CommandExample } from './command.js';
import { COMMANDS } from './commands/index.js';
import { MochiError, toMochiError, type ErrorCode } from './errors.js';
import type { AssetStore, FileSystem } from './fs.js';
import type { CommandCall, Session, TransactionOptions, TransactionResult, Tx } from './session.js';

/** An image an operation returns so agents can see the result (agent API design 3.1). */
export interface Preview {
  mediaType: 'image/png';
  data: Uint8Array;
  width: number;
  height: number;
  description: string;
}

export interface OperationContext {
  session: Session;
  assets: AssetStore;
  /** For operations that read files; access rules belong to the caller (agent API design 6). */
  fs?: FileSystem;
}

export interface OperationOutput<R> {
  result: R;
  previews?: Preview[];
}

export interface OperationDef<
  N extends string = string,
  A extends TSchema = TSchema,
  R extends TSchema = TSchema,
> {
  name: N;
  summary: string;
  doc: string;
  args: A;
  result: R;
  errors: ErrorCode[];
  examples: CommandExample[];
  /** Default 'edit'. */
  scope?: import('./command.js').CommandScope;
  /** Default true. */
  undoable?: boolean;
  run(ctx: OperationContext, tx: Tx, args: Static<A>): Promise<OperationOutput<Static<R>>>;
}

export function defineOperation<const N extends string, A extends TSchema, R extends TSchema>(
  def: OperationDef<N, A, R>,
): OperationDef<N, A, R> {
  return def;
}

export interface RunItemsResult extends TransactionResult {
  /** One result per item (operations return their own result, not their commands'). */
  itemResults: unknown[];
  previews: Preview[];
}

/**
 * Runs items (commands and operations) as one transaction. With `dryRun`, nothing is committed,
 * but operations still run, so their previews show what would happen.
 */
export async function runItems(
  ctx: OperationContext,
  label: string,
  items: CommandCall[],
  options: TransactionOptions & { operations?: readonly OperationDef[] } = {},
): Promise<RunItemsResult> {
  const ops = new Map((options.operations ?? []).map((o) => [o.name, o]));
  const itemResults: unknown[] = [];
  const previews: Preview[] = [];
  const r = await ctx.session.transactAsync(
    label,
    async (tx) => {
      for (const [i, item] of items.entries()) {
        const op = ops.get(item.name);
        const def = op ?? COMMANDS.get(item.name);
        try {
          if (!def)
            throw new MochiError(
              'E_UNKNOWN_COMMAND',
              `There is no command or operation "${item.name}".`,
            );
          checkArgs(def.args, item.args);
          const args = resolveArgs(def.args, item.args, tx.draft, itemResults);
          if (op) {
            const out = await op.run(ctx, tx, args as never);
            itemResults.push(out.result);
            previews.push(...(out.previews ?? []));
          } else itemResults.push(tx.run(item.name, args));
        } catch (e) {
          const err = toMochiError(e);
          // Report the failing item; a failing command inside an operation keeps its own name in details.
          if (op && err.command !== undefined && err.command !== item.name) {
            const inner = { command: err.command, at: err.at };
            const wrapped = new MochiError(err.code, `${item.name}: ${err.message}`, {
              path: err.path,
              details: { ...(err.details ?? {}), inner },
              fixes: err.fixes,
            });
            wrapped.command = item.name;
            wrapped.at = i;
            throw wrapped;
          }
          err.command = item.name;
          err.at = i;
          throw err;
        }
      }
    },
    options,
  );
  return { ...r, itemResults, previews };
}
