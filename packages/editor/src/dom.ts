/** A small DOM helper: h('div.class', { attrs, on: { click } }, ...children). */
export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  [attr: string]: unknown;
  on?: Record<string, (e: Event) => void>;
  dataset?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}` | `${K}#${string}`,
  props: Props | Child = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tagAndId, ...classes] = spec.split('.');
  const [tag, id] = tagAndId!.split('#');
  const el = document.createElement(tag as K);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  if (props instanceof Node || typeof props !== 'object' || props === null || Array.isArray(props))
    children.unshift(props as Child);
  else
    for (const [k, v] of Object.entries(props)) {
      if (k === 'on')
        for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>))
          el.addEventListener(ev, fn);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'class') el.className += ` ${v as string}`;
      else if (v === false || v === undefined || v === null) continue;
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Replaces an element's children. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}
