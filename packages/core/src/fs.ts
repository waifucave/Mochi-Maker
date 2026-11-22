/**
 * File-system and asset-store interfaces, so the core stays free of Node and browser APIs.
 * Paths use '/' separators.
 */
import { MochiError } from './errors.js';
import { LIMITS, readCapped } from './limits.js';

export interface FileSystem {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Entry names in a directory; empty if it does not exist. */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** A file's size in bytes without reading it, where the file system can tell; else undefined. */
  size?(path: string): Promise<number | undefined>;
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/+/g, '/');
}

/** An in-memory file system, for tests and for the browser before a folder is chosen. */
export class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();

  private norm(p: string): string {
    return p.replace(/\/+/g, '/').replace(/\/$/, '');
  }
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }
  async writeText(path: string, text: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(text));
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const f = this.files.get(this.norm(path));
    if (!f) throw new MochiError('E_NOT_FOUND', `No such file: ${path}`);
    return f;
  }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const p = this.norm(path);
    const dir = p.slice(0, p.lastIndexOf('/'));
    if (dir) await this.mkdir(dir);
    this.files.set(p, bytes.slice());
  }
  async exists(path: string): Promise<boolean> {
    const p = this.norm(path);
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(dir: string): Promise<string[]> {
    const prefix = this.norm(dir) + '/';
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs])
      if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]!);
    return [...names].sort();
  }
  async remove(path: string): Promise<void> {
    this.files.delete(this.norm(path));
  }
  async size(path: string): Promise<number | undefined> {
    return this.files.get(this.norm(path))?.length;
  }
  async mkdir(path: string): Promise<void> {
    const parts = this.norm(path).split('/');
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Content-addressed storage for source images (design 3.8). */
export interface AssetStore {
  has(hash: string): Promise<boolean>;
  get(hash: string): Promise<Uint8Array>;
  /** Stores bytes and returns their SHA-256 (hex). */
  put(bytes: Uint8Array): Promise<string>;
}

export class MemoryAssetStore implements AssetStore {
  readonly blobs = new Map<string, Uint8Array>();
  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }
  async get(hash: string): Promise<Uint8Array> {
    const b = this.blobs.get(hash);
    if (!b) throw new MochiError('E_ASSET_MISSING', `Asset ${hash} is not in the store.`);
    return b;
  }
  async put(bytes: Uint8Array): Promise<string> {
    const h = await sha256Hex(bytes);
    this.blobs.set(h, bytes.slice());
    return h;
  }
}

/** Assets read from a project folder's assets/ directory, with new ones kept in memory until saved. */
export class FolderAssetStore implements AssetStore {
  private readonly added = new MemoryAssetStore();
  constructor(
    private readonly fs: FileSystem,
    private readonly dir: string,
  ) {}
  /** The asset's file: images are stored as .png, sounds as .wav. */
  private async path(hash: string): Promise<string | undefined> {
    for (const ext of ['png', 'wav']) {
      const p = joinPath(this.dir, `sha256-${hash}.${ext}`);
      if (await this.fs.exists(p)) return p;
    }
    return undefined;
  }
  async has(hash: string): Promise<boolean> {
    return (await this.added.has(hash)) || (await this.path(hash)) !== undefined;
  }
  async get(hash: string): Promise<Uint8Array> {
    if (await this.added.has(hash)) return this.added.get(hash);
    const p = await this.path(hash);
    if (p === undefined)
      throw new MochiError('E_ASSET_MISSING', `Asset ${hash} is not in the project.`);
    return readCapped(this.fs, p, LIMITS.fileBytes, `The asset ${p}`);
  }
  async put(bytes: Uint8Array): Promise<string> {
    return this.added.put(bytes);
  }
}
