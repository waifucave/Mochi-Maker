/**
 * The bridge's secrets: host tokens (from pairing) and client tokens (created by the person in the
 * editor). Only SHA-256 hashes are kept, in memory or in a state file readable by its owner only.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCOPES, type Scope, type TokenInfo } from './protocol.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

interface StoredToken extends TokenInfo {
  hash: string;
}

interface State {
  format: 'mochi-maker-bridge-state';
  version: 1;
  hostTokens: string[];
  tokens: StoredToken[];
}

/** The scopes a token grants: the levels up to the highest asked for (read ⊂ edit ⊂ export). */
export function normalizeScopes(scopes: readonly string[]): Scope[] {
  const top = Math.max(-1, ...scopes.map((s) => SCOPES.indexOf(s as Scope)));
  return SCOPES.slice(0, Math.max(0, top + 1));
}

export class TokenStore {
  private state: State = {
    format: 'mochi-maker-bridge-state',
    version: 1,
    hostTokens: [],
    tokens: [],
  };

  /** `file`: where to keep the hashes across runs; undefined keeps them in memory only. */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8')) as State;
      if (s.format === 'mochi-maker-bridge-state' && s.version === 1) this.state = s;
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
  }

  newHostToken(): string {
    const t = secret('mmh_');
    this.state.hostTokens.push(hash(t));
    this.save();
    return t;
  }

  isHostToken(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const h = hash(token);
    return this.state.hostTokens.some((x) => same(x, h));
  }

  create(name: string, scopes: readonly string[], now: number): { token: string; info: TokenInfo } {
    const token = secret('mmt_');
    const stored: StoredToken = {
      id: `tok_${randomBytes(6).toString('hex')}`,
      name: name.trim() || 'agent',
      scopes: normalizeScopes(scopes),
      created: now,
      lastUsed: null,
      hash: hash(token),
    };
    this.state.tokens.push(stored);
    this.save();
    return { token, info: info(stored) };
  }

  list(): TokenInfo[] {
    return this.state.tokens.map(info);
  }

  /** The token's info, marking it used; undefined for an unknown token. */
  use(token: unknown, now: number): TokenInfo | undefined {
    if (typeof token !== 'string') return undefined;
    const h = hash(token);
    const t = this.state.tokens.find((x) => same(x.hash, h));
    if (!t) return undefined;
    t.lastUsed = now;
    this.save();
    return info(t);
  }

  revoke(id: string): boolean {
    const n = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((t) => t.id !== id);
    this.save();
    return this.state.tokens.length < n;
  }
}

const info = ({ id, name, scopes, created, lastUsed }: StoredToken): TokenInfo => ({
  id,
  name,
  scopes: [...scopes],
  created,
  lastUsed,
});

/** Six-digit pairing codes: valid 10 minutes and once; too many wrong tries make a new one. */
export class PairingCode {
  code = '';
  private expires = 0;
  private tries = 0;

  constructor(
    private readonly ttl: number,
    private readonly maxTries: number,
    private readonly now: () => number,
    private readonly onNew: (code: string) => void,
  ) {
    this.renew();
  }

  renew(): void {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.expires = this.now() + this.ttl;
    this.tries = 0;
    this.onNew(this.code);
  }

  /** Checks a code; a correct one is used up, and a new one replaces it. */
  check(code: unknown): { ok: boolean; message: string } {
    if (this.now() > this.expires) {
      this.renew();
      return {
        ok: false,
        message: 'The pairing code expired; enter the new code the bridge shows.',
      };
    }
    if (typeof code === 'string' && same(code, this.code)) {
      this.renew();
      return { ok: true, message: '' };
    }
    this.tries++;
    if (this.tries >= this.maxTries) {
      this.renew();
      return { ok: false, message: 'Too many wrong codes; the bridge shows a new pairing code.' };
    }
    return {
      ok: false,
      message: 'Wrong pairing code; check the code the bridge shows and try again.',
    };
  }
}
