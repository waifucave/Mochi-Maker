/**
 * Mochi Studio's bridge protocol, version 1, as Mochi Maker speaks it
 * (agent API design 5): the same paths, messages, pairing, tokens and error codes, with
 * `"app": "mochi-maker"` and its own default port.
 */

export const PROTOCOL = 1;
export const DEFAULT_PORT = 47831;
export const APP = 'mochi-maker';
export const BRIDGE_VERSION = '0.0.0';
/** Largest message, in bytes. */
export const MAX_MESSAGE = 16 * 1024 * 1024;
/** A client must say hello within this time. */
export const HELLO_TIMEOUT_MS = 5000;
/** Commands per client per second. */
export const MAX_COMMANDS_PER_SECOND = 30;
/** How long the bridge waits for the host's result. */
export const COMMAND_TIMEOUT_MS = 120_000;
/** Pairing codes: six digits, valid for 10 minutes, once; five wrong tries make a new one. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_TRIES = 5;
export const MAX_SUBSCRIPTIONS = 100;

/** WebSocket close codes. */
export const CLOSE_REPLACED = 4000;
export const CLOSE_UNAUTHORIZED = 4401;

export type Scope = 'read' | 'edit' | 'export';
export const SCOPES: readonly Scope[] = ['read', 'edit', 'export'];

/** `error.code` values (stable). Commands add their own, such as `no_model` or `control_held`. */
export type BridgeErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_message'
  | 'invalid_arguments'
  | 'unknown_command'
  | 'studio_not_connected'
  | 'rate_limited'
  | 'timeout'
  | 'no_model'
  | 'failed'
  | 'protocol'
  | (string & {});

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  /** Mochi Maker's own fields, which receivers that do not know them ignore. */
  [extra: string]: unknown;
}

/** A command as the host describes it. */
export interface CommandInfo {
  name: string;
  summary: string;
  details?: string;
  scope: Scope;
  undoable: boolean;
  readOnly: boolean;
  inputSchema: unknown;
}

export interface TokenInfo {
  id: string;
  name: string;
  scopes: Scope[];
  created: number;
  lastUsed: number | null;
}

export interface ClientInfo {
  id: string;
  name: string;
  scopes: Scope[];
  connectedAt: number;
}

/** Whether an event name matches a subscription: a name, `*`, or a prefix ending in `*`. */
export function matches(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}
