/** Canonical text and hashes of whole documents, for equality checks, logs and tests. */
import { encode, type JsonTree } from './codec.js';
import { compareUids, type Document } from './document.js';
import { stringifyJson } from './json.js';
import { OBJECT_SCHEMAS } from './model.js';

export function documentTree(doc: Document): JsonTree {
  const uids = Object.keys(doc.objects).sort(compareUids);
  return {
    seq: doc.seq,
    objects: uids.map((u) => {
      const o = doc.objects[u]!;
      return encode(OBJECT_SCHEMAS[o.kind], o);
    }),
  };
}

/** Deterministic text of a document: equal documents give equal text. */
export function canonicalText(doc: Document, options: { includeSeq?: boolean } = {}): string {
  const tree = documentTree(doc) as { seq: number; objects: JsonTree[] };
  return stringifyJson(options.includeSeq === false ? { objects: tree.objects } : tree);
}

/** A 64-bit non-cryptographic hash (two 32-bit FNV-1a lanes) of a string, as 16 hex digits. */
export function hash64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function documentHash(doc: Document): string {
  return hash64(canonicalText(doc));
}
