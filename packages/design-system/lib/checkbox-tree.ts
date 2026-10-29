/**
 * Selection and visibility model for `CheckboxTree` (ISS-12517).
 *
 * Pure data, no React and no DOM, so the tri-state derivation and the toggle
 * rule are unit-testable without rendering a tree — the same split
 * `grid-table-v2-tree` makes for the table's lineage.
 *
 * Selection is INHERITED: an id in the checked set checks its whole subtree,
 * including children that do not exist yet. So the set records CONSENT, and
 * {@link toggleCheckboxTreeNode} only ever writes a parent id the user asked
 * for:
 *
 * - Clicking a parent emits the parent id — "this whole folder, including
 *   whatever lands in it later".
 * - Checking every child one by one does NOT promote to the parent id. The
 *   parent row renders `checked` (its state is derived from its children), but
 *   the set keeps the leaf ids, so a child added later arrives unchecked.
 *   Consent given item by item never widens into consent for unseen items.
 * - Unchecking one child of an explicitly checked parent demotes it: the
 *   parent id goes, and the remaining current siblings are written instead.
 *
 * Ids the current `nodes` do not contain are carried through untouched: the
 * tree may be showing a partial or stale view, and it never deletes what it
 * cannot see.
 */

import type { ReactNode } from "react";

export type CheckboxTreeNode = {
  /** Unique across the whole tree, not just among siblings: it keys the row. */
  id: string;
  label: ReactNode;
  children?: readonly CheckboxTreeNode[];
} & CheckboxTreeNodeLock;

/**
 * A locked row MUST say why. `treeitem` has no `aria-readonly`, so for a
 * read-only row the reason is the only thing assistive tech can announce about
 * the lock; the type refuses a locked row without one rather than leaving it
 * indistinguishable from an interactive row.
 */
type CheckboxTreeNodeLock =
  | { disabled?: false; readOnly?: false; reason?: undefined }
  | {
      /**
       * Not available: dimmed, `aria-disabled`, and its check cannot change —
       * neither directly nor by a cascade from an ancestor. Still focusable and
       * expandable, as the WAI-ARIA tree pattern keeps disabled items reachable.
       */
      disabled: true;
      readOnly?: boolean;
      reason: ReactNode;
    }
  | {
      /**
       * Shown at full strength but locked: its check cannot change, directly
       * or by cascade. For a value set somewhere else that this tree reports.
       */
      readOnly: true;
      disabled?: boolean;
      /**
       * Painted under the label and wired to the row's `aria-describedby`, so
       * the reason is announced with the row rather than living only in a
       * tooltip a keyboard user never opens.
       */
      reason: ReactNode;
    };

/** The three values `aria-checked` takes on a tree item. */
export type CheckboxTreeCheckState = "checked" | "unchecked" | "mixed";

function hasChildren(node: CheckboxTreeNode): boolean {
  return (node.children?.length ?? 0) > 0;
}

function isLocked(node: CheckboxTreeNode): boolean {
  return node.disabled === true || node.readOnly === true;
}

/**
 * The tree with every repeated id dropped, which also makes a cyclic node
 * graph finite. It visits in the same order as `flattenRenderRows` — a whole
 * sibling set is claimed before any child set is walked — so the rows a tree
 * paints and the nodes its state is derived from are the same nodes. Every
 * exported walk here starts from it; without it a node that is its own
 * ancestor overflows the stack inside a render.
 */
export function normalizeCheckboxTree(
  nodes: readonly CheckboxTreeNode[],
  visited: Set<string> = new Set<string>()
): CheckboxTreeNode[] {
  const siblings = nodes.filter((node) => {
    if (visited.has(node.id)) {
      return false;
    }
    visited.add(node.id);
    return true;
  });
  return siblings.map((node) =>
    node.children
      ? { ...node, children: normalizeCheckboxTree(node.children, visited) }
      : node
  );
}

/**
 * Every node's tri-state, keyed by id.
 *
 * A leaf is checked when it or any ancestor is in `checkedIds`. A parent is
 * derived from its children only — all checked is `checked`, none is
 * `unchecked`, anything else is `mixed` — so a parent's own membership matters
 * only through the inheritance it hands down.
 */
export function deriveCheckboxTreeStates(
  nodes: readonly CheckboxTreeNode[],
  checkedIds: ReadonlySet<string>
): Map<string, CheckboxTreeCheckState> {
  const tree = normalizeCheckboxTree(nodes);
  const states = new Map<string, CheckboxTreeCheckState>();
  const visit = (
    node: CheckboxTreeNode,
    inherited: boolean
  ): CheckboxTreeCheckState => {
    const selfOrAncestor = inherited || checkedIds.has(node.id);
    if (!hasChildren(node)) {
      const state = selfOrAncestor ? "checked" : "unchecked";
      states.set(node.id, state);
      return state;
    }
    let sawChecked = false;
    let sawUnchecked = false;
    for (const child of node.children ?? []) {
      const childState = visit(child, selfOrAncestor);
      if (childState === "mixed") {
        sawChecked = true;
        sawUnchecked = true;
      } else if (childState === "checked") {
        sawChecked = true;
      } else {
        sawUnchecked = true;
      }
    }
    const state = summarizeChildren(sawChecked, sawUnchecked);
    states.set(node.id, state);
    return state;
  };
  for (const node of tree) {
    visit(node, false);
  }
  return states;
}

function summarizeChildren(
  sawChecked: boolean,
  sawUnchecked: boolean
): CheckboxTreeCheckState {
  if (sawChecked && sawUnchecked) {
    return "mixed";
  }
  return sawChecked ? "checked" : "unchecked";
}

/** Leaves under `node` (itself, when it is one) that a cascade may change. */
function collectToggleableLeaves(node: CheckboxTreeNode): CheckboxTreeNode[] {
  if (isLocked(node)) {
    return [];
  }
  if (!hasChildren(node)) {
    return [node];
  }
  return (node.children ?? []).flatMap(collectToggleableLeaves);
}

function resolveToggleTarget(
  state: CheckboxTreeCheckState | undefined,
  leaves: readonly CheckboxTreeNode[],
  states: ReadonlyMap<string, CheckboxTreeCheckState>
): boolean {
  if (state === "unchecked") {
    return true;
  }
  if (state === "mixed") {
    return !leaves.every((leaf) => states.get(leaf.id) === "checked");
  }
  return false;
}

/** Every id at or below `node`. */
function collectSubtreeIds(node: CheckboxTreeNode, out: string[] = []): string[] {
  out.push(node.id);
  for (const child of node.children ?? []) {
    collectSubtreeIds(child, out);
  }
  return out;
}

/** The nodes from a root down to `id`, both ends included; null if absent. */
function findPath(
  nodes: readonly CheckboxTreeNode[],
  id: string
): CheckboxTreeNode[] | null {
  for (const node of nodes) {
    if (node.id === id) {
      return [node];
    }
    const below = findPath(node.children ?? [], id);
    if (below) {
      return [node, ...below];
    }
  }
  return null;
}

/**
 * Check every toggleable leaf under `node`, writing the widest ids that say
 * so without checking anything locked: `node` itself when every leaf beneath
 * it ends up checked (an explicit click on a parent is consent for the whole
 * folder), otherwise its children one by one.
 */
function checkSubtree(
  node: CheckboxTreeNode,
  locks: ReadonlyMap<string, CheckboxTreeLock>,
  states: ReadonlyMap<string, CheckboxTreeCheckState>,
  out: Set<string>
): void {
  if (locks.has(node.id)) {
    return;
  }
  const blocked = collectLeaves(node).some(
    (leaf) => locks.has(leaf.id) && states.get(leaf.id) !== "checked"
  );
  if (!blocked) {
    for (const id of collectSubtreeIds(node)) {
      out.delete(id);
    }
    out.add(node.id);
    return;
  }
  for (const child of node.children ?? []) {
    checkSubtree(child, locks, states, out);
  }
}

/**
 * Uncheck every toggleable leaf under `node`. A locked row keeps the state it
 * had: if it was checked only through an id this removes, its own id is
 * written in that id's place.
 */
function uncheckSubtree(
  node: CheckboxTreeNode,
  locks: ReadonlyMap<string, CheckboxTreeLock>,
  states: ReadonlyMap<string, CheckboxTreeCheckState>,
  out: Set<string>
): void {
  if (locks.has(node.id)) {
    if (states.get(node.id) === "checked") {
      out.add(node.id);
    }
    return;
  }
  out.delete(node.id);
  for (const child of node.children ?? []) {
    uncheckSubtree(child, locks, states, out);
  }
}

function collectLeaves(node: CheckboxTreeNode): CheckboxTreeNode[] {
  if (!hasChildren(node)) {
    return [node];
  }
  return (node.children ?? []).flatMap(collectLeaves);
}

/**
 * The checked set after the user toggles `id` (see the module doc for what a
 * written parent id means).
 *
 * Unchecked goes to checked and checked to unchecked. Mixed goes to checked —
 * unless every leaf the toggle may change is ALREADY checked, which happens when
 * a locked unchecked descendant is what keeps the parent mixed. Then it clears
 * them instead; without that branch a mixed parent over a locked row would only
 * ever re-check itself and could never be cleared.
 *
 * Toggling a locked row — one under a locked ancestor included — returns the
 * set unchanged, and a cascade never enters a locked subtree. Ids not in
 * `nodes` are always returned as they came in.
 */
export function toggleCheckboxTreeNode(
  nodes: readonly CheckboxTreeNode[],
  checkedIds: ReadonlySet<string>,
  id: string
): string[] {
  const tree = normalizeCheckboxTree(nodes);
  const locks = deriveCheckboxTreeLocks(tree);
  const path = findPath(tree, id);
  const target = path?.at(-1);
  if (!(path && target) || locks.has(id)) {
    return [...checkedIds];
  }
  const states = deriveCheckboxTreeStates(tree, checkedIds);
  const next = resolveToggleTarget(
    states.get(id),
    collectToggleableLeaves(target),
    states
  );
  const out = new Set(checkedIds);
  if (next) {
    checkSubtree(target, locks, states, out);
    return [...out];
  }
  // Demote every explicitly checked ancestor: its id would keep the target
  // checked by inheritance, so it is replaced by its children — each of which
  // was checked through it — and the walk continues down the path.
  for (const ancestor of path.slice(0, -1)) {
    if (out.delete(ancestor.id)) {
      for (const child of ancestor.children ?? []) {
        out.add(child.id);
      }
    }
  }
  uncheckSubtree(target, locks, states, out);
  return [...out];
}

/**
 * A row whose check cannot change, and the node that declared the lock.
 *
 * `descendants` is a parent that declares no lock of its own but has nothing
 * left to toggle: every leaf beneath it is locked. Toggling it is a no-op, so
 * it is drawn and announced as locked rather than promising a click that does
 * nothing. Its `sourceId` is the parent itself.
 */
export type CheckboxTreeLock = {
  kind: "disabled" | "readOnly" | "descendants";
  sourceId: string;
};

/**
 * The lock on every locked row, keyed by id. A lock covers its whole subtree:
 * a child of a locked parent could otherwise be toggled directly and move the
 * parent's derived state, which is exactly the change the lock forbids. A
 * disabled lineage outranks a read-only one, because the row is then not
 * available at all; otherwise the nearest declaring node is the source, whose
 * `reason` describes the row. An unlocked parent whose every leaf is locked
 * gets a `descendants` lock of its own.
 */
export function deriveCheckboxTreeLocks(
  nodes: readonly CheckboxTreeNode[]
): Map<string, CheckboxTreeLock> {
  const locks = new Map<string, CheckboxTreeLock>();
  const visit = (node: CheckboxTreeNode, inherited: CheckboxTreeLock | null) => {
    let lock = inherited;
    if (node.disabled) {
      lock = { kind: "disabled", sourceId: node.id };
    } else if (inherited?.kind !== "disabled" && node.readOnly) {
      lock = { kind: "readOnly", sourceId: node.id };
    }
    if (lock) {
      locks.set(node.id, lock);
    }
    for (const child of node.children ?? []) {
      visit(child, lock);
    }
    if (!lock && hasChildren(node) && collectToggleableLeaves(node).length === 0) {
      locks.set(node.id, { kind: "descendants", sourceId: node.id });
    }
  };
  for (const node of normalizeCheckboxTree(nodes)) {
    visit(node, null);
  }
  return locks;
}
