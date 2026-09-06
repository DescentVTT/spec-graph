/**
 * The specification graph.
 *
 * An immutable, fully indexed view over the resolved corpus. Construction pays
 * for adjacency in both directions once so that every rule, query and report is
 * a lookup rather than a scan - the difference between a linter that runs on
 * every save and one that gets moved to a nightly job and then ignored.
 *
 * The algorithms here are the ones the rules genuinely need and no more:
 * adjacency, reachability, and Tarjan's strongly connected components for
 * finding circular delegations.
 */

import type { DocumentNode, Edge, EdgeKind, ItemNode, SpecNode } from './types.js';
import { EDGE_TRAITS } from './types.js';

export interface SpecGraph {
  readonly nodes: ReadonlyMap<string, SpecNode>;
  readonly edges: readonly Edge[];
  readonly documents: readonly DocumentNode[];
  readonly items: readonly ItemNode[];

  node(id: string): SpecNode | undefined;
  document(id: string): DocumentNode | undefined;
  /** The document a node belongs to: itself, or the item's owner. */
  owningDocument(id: string): DocumentNode | undefined;
  itemsOf(documentId: string): readonly ItemNode[];

  /** Edges leaving `id`, optionally filtered by kind. */
  out(id: string, kinds?: readonly EdgeKind[]): readonly Edge[];
  /** Edges entering `id`, optionally filtered by kind. */
  in(id: string, kinds?: readonly EdgeKind[]): readonly Edge[];

  /**
   * Every node reachable from `id` over the given edge kinds, with the shortest
   * path to each. `id` itself is included only when a cycle returns to it.
   */
  reach(id: string, kinds: readonly EdgeKind[]): ReadonlyMap<string, readonly Edge[]>;

  /**
   * Strongly connected components with more than one member, plus self-loops,
   * over the given edge kinds. Each is a real cycle.
   */
  cycles(kinds: readonly EdgeKind[]): readonly (readonly string[])[];
}

/** Builds the graph. Edges naming an unknown node are dropped, not stored. */
export function buildGraph(input: {
  readonly nodes: ReadonlyMap<string, SpecNode>;
  readonly edges: readonly Edge[];
}): SpecGraph {
  const nodes = input.nodes;
  const edges = input.edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));

  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const edge of edges) {
    push(outgoing, edge.from, edge);
    push(incoming, edge.to, edge);
  }

  const documents: DocumentNode[] = [];
  const items: ItemNode[] = [];
  const itemsByDocument = new Map<string, ItemNode[]>();
  for (const node of nodes.values()) {
    if (node.kind === 'document') documents.push(node);
    else {
      items.push(node);
      push(itemsByDocument, node.document, node);
    }
  }

  const filter = (list: readonly Edge[] | undefined, kinds?: readonly EdgeKind[]): readonly Edge[] => {
    if (!list) return EMPTY_EDGES;
    if (!kinds || kinds.length === 0) return list;
    return list.filter((edge) => kinds.includes(edge.kind));
  };

  const graph: SpecGraph = {
    nodes,
    edges,
    documents,
    items,

    node: (id) => nodes.get(id),
    document: (id) => {
      const found = nodes.get(id);
      return found?.kind === 'document' ? found : undefined;
    },
    owningDocument: (id) => {
      const found = nodes.get(id);
      if (!found) return undefined;
      if (found.kind === 'document') return found;
      const owner = nodes.get(found.document);
      return owner?.kind === 'document' ? owner : undefined;
    },
    itemsOf: (documentId) => itemsByDocument.get(documentId) ?? EMPTY_ITEMS,

    out: (id, kinds) => filter(outgoing.get(id), kinds),
    in: (id, kinds) => filter(incoming.get(id), kinds),

    reach(id, kinds) {
      const paths = new Map<string, readonly Edge[]>();
      const queue: string[] = [id];
      const pathTo = new Map<string, readonly Edge[]>([[id, EMPTY_EDGES]]);

      while (queue.length > 0) {
        const current = queue.shift() as string;
        const prefix = pathTo.get(current) as readonly Edge[];
        for (const edge of filter(outgoing.get(current), kinds)) {
          if (pathTo.has(edge.to) && edge.to !== id) continue;
          const path = [...prefix, edge];
          if (edge.to === id) {
            // A cycle back to the origin: record it, but do not re-expand.
            if (!paths.has(id)) paths.set(id, path);
            continue;
          }
          pathTo.set(edge.to, path);
          paths.set(edge.to, path);
          queue.push(edge.to);
        }
      }
      return paths;
    },

    cycles: (kinds) => tarjan(nodes, outgoing, kinds),
  };

  return graph;
}

const EMPTY_EDGES: readonly Edge[] = Object.freeze([]);
const EMPTY_ITEMS: readonly ItemNode[] = Object.freeze([]);

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/* -------------------------------------------------------------------------- */
/* Cycles                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Tarjan's strongly connected components, iterative.
 *
 * Iterative rather than recursive because a monorepo's reference graph can be
 * deep enough to blow the call stack, and a linter that crashes on the largest
 * repository in the company is a linter nobody trusts on the small ones either.
 */
function tarjan(
  nodes: ReadonlyMap<string, SpecNode>,
  outgoing: ReadonlyMap<string, readonly Edge[]>,
  kinds: readonly EdgeKind[],
): string[][] {
  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const successors = (id: string): string[] => {
    const list = outgoing.get(id) ?? EMPTY_EDGES;
    const out: string[] = [];
    for (const edge of list) {
      if (kinds.length > 0 && !kinds.includes(edge.kind)) continue;
      if (nodes.has(edge.to)) out.push(edge.to);
    }
    return out;
  };

  for (const root of nodes.keys()) {
    if (indexOf.has(root)) continue;

    const work: { id: string; next: number; children: string[] }[] = [
      { id: root, next: 0, children: successors(root) },
    ];
    indexOf.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; next: number; children: string[] };
      if (frame.next < frame.children.length) {
        const child = frame.children[frame.next] as string;
        frame.next += 1;
        if (!indexOf.has(child)) {
          indexOf.set(child, counter);
          lowLink.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ id: child, next: 0, children: successors(child) });
        } else if (onStack.has(child)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id) as number, indexOf.get(child) as number));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(parent.id, Math.min(lowLink.get(parent.id) as number, lowLink.get(frame.id) as number));
      }

      if (lowLink.get(frame.id) === indexOf.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop() as string;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.id) break;
        }
        if (component.length > 1) {
          components.push(component.reverse());
        } else if (successors(frame.id).includes(frame.id)) {
          components.push(component);
        }
      }
    }
  }

  return components;
}

/* -------------------------------------------------------------------------- */
/* Derived predicates                                                         */
/* -------------------------------------------------------------------------- */

/** Edge kinds that move an obligation from one document to another. */
export const OBLIGATION_EDGES: readonly EdgeKind[] = Object.freeze(
  (Object.keys(EDGE_TRAITS) as EdgeKind[]).filter((kind) => EDGE_TRAITS[kind].transfersObligation),
);

/** Edge kinds whose source depends on what the target says. */
export const LOAD_BEARING_EDGES: readonly EdgeKind[] = Object.freeze(
  (Object.keys(EDGE_TRAITS) as EdgeKind[]).filter((kind) => EDGE_TRAITS[kind].loadBearing),
);
