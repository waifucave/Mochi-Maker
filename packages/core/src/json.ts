/**
 * Deterministic JSON text for project files (design 3.8).
 *
 * - Objects: one key per line, keys in the order given.
 * - Arrays of scalars (including tuples such as [x, y]): on one line.
 * - Arrays that contain objects or arrays: one item per line. So a list of points has one point
 *   per line, and moving a vertex is a one-line diff.
 * - Float32 numbers: the shortest text that reads back as the same float32.
 * - Two-space indentation, LF line endings, a final newline, no byte-order mark.
 */
import { F32Num, type JsonTree } from './codec.js';
import { formatF32, formatF64 } from './f32.js';

function isScalar(v: JsonTree): boolean {
  return v === null || typeof v !== 'object' || v instanceof F32Num;
}

function scalarText(v: JsonTree): string {
  if (v instanceof F32Num) return formatF32(v.value);
  if (typeof v === 'number') return formatF64(v);
  return JSON.stringify(v);
}

function write(v: JsonTree, indent: string, out: string[]): void {
  if (isScalar(v)) {
    out.push(scalarText(v));
    return;
  }
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.push('[]');
      return;
    }
    if (v.every(isScalar)) {
      out.push('[' + v.map(scalarText).join(', ') + ']');
      return;
    }
    out.push('[\n');
    v.forEach((item, i) => {
      out.push(inner);
      write(item, inner, out);
      out.push(i < v.length - 1 ? ',\n' : '\n');
    });
    out.push(indent + ']');
    return;
  }
  const entries = Object.entries(v as { [key: string]: JsonTree });
  if (entries.length === 0) {
    out.push('{}');
    return;
  }
  out.push('{\n');
  entries.forEach(([k, item], i) => {
    out.push(inner + JSON.stringify(k) + ': ');
    write(item, inner, out);
    out.push(i < entries.length - 1 ? ',\n' : '\n');
  });
  out.push(indent + '}');
}

export function stringifyJson(tree: JsonTree): string {
  const out: string[] = [];
  write(tree, '', out);
  out.push('\n');
  return out.join('');
}

/** Parses JSON text, accepting and skipping a leading byte-order mark. */
export function parseJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
