import type { Static } from '@sinclair/typebox';
import type { CommandDef } from '../command.js';
import * as animation from './animation.js';
import * as keys from './keys.js';
import * as motionSync from './motionsync.js';
import * as blendShapes from './blendShapes.js';
import * as deformers from './deformers.js';
import * as meshes from './meshes.js';
import * as parameters from './parameters.js';
import * as parts from './parts.js';
import * as project from './project.js';
import * as rig from './rig.js';

const ALL = [
  ...Object.values(project),
  ...Object.values(parameters),
  ...Object.values(parts),
  ...Object.values(deformers),
  ...Object.values(meshes),
  ...Object.values(rig),
  ...Object.values(blendShapes),
  ...Object.values(animation),
  ...Object.values(keys),
  ...Object.values(motionSync),
];

type Values<T> = T[keyof T];
type AnyDef =
  | Values<typeof project>
  | Values<typeof parameters>
  | Values<typeof parts>
  | Values<typeof deformers>
  | Values<typeof meshes>
  | Values<typeof keys>
  | Values<typeof rig>
  | Values<Omit<typeof blendShapes, 'zeroDelta'>>
  | Values<typeof animation>
  | Values<Omit<typeof motionSync, 'MOTION_SYNC_DEFAULT_ELEMENTS' | 'MOTION_SYNC_TYPICAL_SHAPES'>>;

/** Every command, by name, with its argument and result types. */
export type CommandMap = { [D in AnyDef as D['name']]: D };
export type CommandName = keyof CommandMap;
export type ArgsOf<N extends CommandName> = Static<CommandMap[N]['args']>;
export type ResultOf<N extends CommandName> = Static<CommandMap[N]['result']>;

export const COMMANDS: ReadonlyMap<string, CommandDef> = new Map(
  (ALL as unknown as CommandDef[])
    .filter((c) => typeof c === 'object' && c !== null && 'apply' in c)
    .map((c) => [c.name, c]),
);

export function getCommand(name: string): CommandDef | undefined {
  return COMMANDS.get(name);
}
