/**
 * Stacking: the order of a draw-order group's members, back to front among equal draw orders.
 *
 * A group is the top level of the part tree, or a part with its own sorting scope. Its members are
 * the meshes in it, through parts that inherit the scope, and the parts with their own scope there,
 * which stack as one item. The tree's order is the stacking order, unless the project keeps an
 * explicit one for the group (`project.stacks`, an imported model's where the tree cannot hold it).
 * Then the listed members keep that order, and members not listed (new ones) come right after the
 * member before them in the tree. Listed UIDs that are no longer members are ignored.
 */
import type { DocReader, Draft } from './document.js';
import type { Project, Uid } from './model.js';

/** The group's members in the tree's order. `scope` null: the top level. */
export function stackMembers(doc: DocReader, scope: Uid | null): Uid[] {
  const out: Uid[] = [];
  const start = scope === null ? doc.project().root : doc.getAs(scope, 'part').children;
  const walk = (list: Uid[]) => {
    for (const uid of list) {
      const o = doc.get(uid);
      if (o?.kind === 'artMesh') out.push(uid);
      else if (o?.kind === 'part') {
        if (o.sortingScope === 'own') out.push(uid);
        else walk(o.children);
      }
    }
  };
  walk(start);
  return out;
}

/** The project's explicit stacking order of a group, if it keeps one. */
export function explicitStack(project: Project, scope: Uid | null): Uid[] | null {
  return project.stacks.find((s) => s.scope === scope)?.entries ?? null;
}

/** Merges `tree` (the members in tree order) into `stack`: see the module comment. */
export function mergeStack(tree: Uid[], stack: Uid[] | null): Uid[] {
  if (!stack) return tree;
  const members = new Set(tree);
  const out: Uid[] = [];
  const placed = new Set<Uid>();
  for (const u of stack)
    if (members.has(u) && !placed.has(u)) {
      out.push(u);
      placed.add(u);
    }
  for (let i = 0; i < tree.length; i++) {
    const u = tree[i]!;
    if (placed.has(u)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(tree[j]!);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, u);
    placed.add(u);
  }
  return out;
}

/** The group's members in stacking order, back to front among equal draw orders. */
export function stackOrder(doc: DocReader, scope: Uid | null): Uid[] {
  return mergeStack(stackMembers(doc, scope), explicitStack(doc.project(), scope));
}

/** The draw-order group an object stacks in: its nearest own-scope part above it, or null. */
export function scopeOf(doc: DocReader, uid: Uid): Uid | null {
  const o = doc.get(uid);
  let p = o?.kind === 'artMesh' ? o.part : o?.kind === 'part' ? o.parent : null;
  while (p !== null) {
    const part = doc.getAs(p, 'part');
    if (part.sortingScope === 'own') return p;
    p = part.parent;
  }
  return null;
}

/** What `uid` contributes to its group: itself (a mesh, or a part with its own scope), or the members inside it. */
export function membersOf(doc: DocReader, uid: Uid): Uid[] {
  const o = doc.get(uid);
  if (o?.kind === 'artMesh') return [uid];
  if (o?.kind !== 'part') return [];
  if (o.sortingScope === 'own') return [uid];
  const out: Uid[] = [];
  for (const c of o.children) out.push(...membersOf(doc, c));
  return out;
}

/**
 * After `uid` moved in the tree: in the explicit stacks, its members leave wherever they were and,
 * where its new group has an explicit stack, stand there as in the tree: before the next member
 * that the stack lists, or else after the previous one.
 */
export function restack(d: Draft, uid: Uid): void {
  const project = d.project();
  if (project.stacks.length === 0) return;
  const moved = membersOf(d, uid);
  const set = new Set(moved);
  const scope = scopeOf(d, uid);
  const tree = stackMembers(d, scope);
  const stacks = project.stacks.map((s) => {
    const entries = s.entries.filter((u) => !set.has(u));
    if (s.scope !== scope || moved.length === 0) return { ...s, entries };
    const first = tree.indexOf(moved[0]!);
    const last = tree.indexOf(moved[moved.length - 1]!);
    let at = -1;
    for (let i = last + 1; i < tree.length && at < 0; i++) at = entries.indexOf(tree[i]!);
    if (at < 0)
      for (let i = first - 1; i >= 0 && at < 0; i--) {
        const k = entries.indexOf(tree[i]!);
        if (k >= 0) at = k + 1;
      }
    if (at < 0) at = entries.length;
    entries.splice(at, 0, ...moved);
    return { ...s, entries };
  });
  d.updateProject((p) => ({ ...p, stacks }));
}
