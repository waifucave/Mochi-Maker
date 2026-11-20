/** The typed method layer over a transaction (agent API design 2.1). */
import type { ArgsOf, CommandName, ResultOf, Tx } from '@mochi-maker/core';
import { COMMAND_AREAS, type CommandMethods } from './generated.js';

/** What a transaction body gets: `tx.<area>.<verb>(args)`, and `tx.run(name, args)`. */
export type TxApi = CommandMethods & {
  run<N extends CommandName>(name: N, args: ArgsOf<N>): ResultOf<N>;
};

export function txApi(tx: Tx): TxApi {
  const api: Record<string, unknown> = {
    run: (name: string, args: unknown) => tx.run(name, args),
  };
  for (const [area, verbs] of Object.entries(COMMAND_AREAS)) {
    const methods: Record<string, (args: unknown) => unknown> = {};
    for (const verb of verbs) methods[verb] = (args) => tx.run(`${area}.${verb}`, args);
    api[area] = methods;
  }
  return api as unknown as TxApi;
}
