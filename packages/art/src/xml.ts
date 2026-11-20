/**
 * A minimal XML reader for small, well-formed documents such as OpenRaster's stack.xml: elements,
 * attributes and nesting. Text content, comments, processing instructions and DOCTYPE are skipped.
 */
import { MochiError } from '@mochi-maker/core';

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: '#document', attributes: {}, children: [] };
  const stack: XmlElement[] = [root];
  const tag =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(text))) {
    const [, close, name, attrs, selfClose] = m;
    if (!name) continue;
    if (close) {
      const top = stack.pop();
      if (!top || top.name !== name)
        throw new MochiError('E_ASSET_FORMAT', `XML: unexpected </${name}>.`);
      continue;
    }
    const el: XmlElement = { name, attributes: {}, children: [] };
    const attr = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = attr.exec(attrs ?? ''))) el.attributes[a[1]!] = unescape(a[3] ?? a[4] ?? '');
    stack[stack.length - 1]!.children.push(el);
    if (!selfClose) stack.push(el);
  }
  if (stack.length !== 1)
    throw new MochiError(
      'E_ASSET_FORMAT',
      `XML: <${stack[stack.length - 1]!.name}> is not closed.`,
    );
  return root;
}
