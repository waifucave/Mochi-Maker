/**
 * Error output for agents (agent API design 2.4), in the style of Mochi Studio's bridge protocol
 *: a stable `category` from the bridge's error set next to Mochi Maker's own
 * stable `code`, a message that says what to do, and machine-applicable fixes.
 */
import { MochiError } from '@mochi-maker/core';

/** Bridge-protocol error categories that apply to Mochi Maker. */
export type ErrorCategory =
  'invalid_arguments' | 'unknown_command' | 'forbidden' | 'no_project' | 'rate_limited' | 'failed';

const CATEGORY: Partial<Record<string, ErrorCategory>> = {
  E_SCHEMA: 'invalid_arguments',
  E_NOT_FOUND: 'invalid_arguments',
  E_WRONG_KIND: 'invalid_arguments',
  E_AMBIGUOUS_REF: 'invalid_arguments',
  E_BAD_REF: 'invalid_arguments',
  E_BAD_CELL: 'invalid_arguments',
  E_UNKNOWN_COMMAND: 'unknown_command',
  E_FORBIDDEN: 'forbidden',
  E_FEATURE_OFF: 'forbidden',
  E_NO_PROJECT: 'no_project',
  E_RATE_LIMITED: 'rate_limited',
  E_BRIDGE: 'no_project',
};

export function errorCategory(code: string): ErrorCategory {
  return CATEGORY[code] ?? 'failed';
}

export interface ErrorJson {
  category: ErrorCategory;
  code: string;
  message: string;
  command?: string;
  at?: number;
  path?: string;
  details?: unknown;
  fixes?: unknown[];
  docs?: string;
}

/** Any thrown value as an agent-facing error object. */
export function errorJson(e: unknown): ErrorJson {
  if (e instanceof MochiError) {
    const out: ErrorJson = { category: errorCategory(e.code), code: e.code, message: e.message };
    if (e.command !== undefined) out.command = e.command;
    if (e.at !== undefined) out.at = e.at;
    if (e.path !== undefined) out.path = e.path;
    if (e.details !== undefined) out.details = e.details;
    if (e.fixes && e.fixes.length > 0) out.fixes = e.fixes;
    out.docs = e.command ? `mochi://docs/commands/${e.command}` : 'mochi://docs/errors';
    return out;
  }
  return {
    category: 'failed',
    code: 'E_INTERNAL',
    message: `Unexpected error: ${(e as Error)?.message ?? String(e)}. This is a Mochi Maker bug; please report it.`,
  };
}
