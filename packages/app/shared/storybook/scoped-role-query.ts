import { within } from "storybook/test";

/**
 * `within(container).getByRole(role, { name })`, with the same answer, but
 * without making jsdom compute styles for every element in `container`
 * (ISS-12447).
 *
 * The container-wide query checks visibility and computes an accessible name
 * for every element with the role. jsdom drops its style cache on every DOM
 * mutation, so on a 300-button listing each first query after a mutation
 * cost over a second, which is what pushed the listing stories to the sweep's
 * 5 s budget.
 *
 * Here the role scan runs with `hidden: true`, which reads no styles. Each
 * element's name can only be `name` when `name` joins whole pieces of its own
 * text and name-bearing attributes, or when the name can come from elsewhere
 * (a label, `aria-labelledby`, `aria-owns`, a slot, a form control). Every
 * other element is dropped without computing a name. The exact role query
 * then runs in the parent of each element that is left. When that does not
 * give exactly one element, the container-wide query runs, so a miss or a
 * duplicate throws the same error as before.
 */
export function getByRoleInOwnParent(
  container: HTMLElement,
  role: string,
  name: string
): HTMLElement {
  const matches = matchInOwnParents(container, role, name);
  if (matches.length === 1) {
    return matches[0];
  }
  return within(container).getByRole(role, { name });
}

/**
 * The absence half of `getByRoleInOwnParent`: `queryByRole`'s answer.
 *
 * Unlike the get half, zero matches return `null` without the container-wide
 * query. Absence is the expected case here, and that fallback would pay the
 * full style pass on every call. So a `null` trusts the name prefilter: if it
 * drops an element whose name comes from a source NAME_ATTRIBUTES and
 * NAMED_ELSEWHERE do not cover, this returns `null` for a rendered control.
 * Where a false absence would let a check pass that must fail, use
 * `within(container).queryByRole` instead.
 */
export function queryByRoleInOwnParent(
  container: HTMLElement,
  role: string,
  name: string
): HTMLElement | null {
  const matches = matchInOwnParents(container, role, name);
  if (matches.length <= 1) {
    return matches[0] ?? null;
  }
  return within(container).queryByRole(role, { name });
}

function matchInOwnParents(
  container: HTMLElement,
  role: string,
  name: string
): HTMLElement[] {
  const wanted = squash(name);
  const matches = new Set<HTMLElement>();
  for (const candidate of within(container).queryAllByRole(role, {
    hidden: true,
  })) {
    if (!mayBeNamed(candidate, wanted)) {
      continue;
    }
    const scope = within(candidate.parentElement ?? container);
    for (const match of scope.queryAllByRole(role, { name })) {
      matches.add(match);
    }
  }
  return [...matches];
}

function mayBeNamed(element: HTMLElement, wanted: string): boolean {
  if (
    element.matches(NAMED_ELSEWHERE) ||
    element.querySelector(NAMED_ELSEWHERE) !== null ||
    element.closest("label") !== null ||
    isLabelTarget(element)
  ) {
    return true;
  }
  return canJoin(wanted, namePieces(element).map(squash));
}

/**
 * Every text node and name-bearing attribute under `element`, in tree order.
 * A name computed from the element's content joins whole pieces from this
 * list, in this order, skipping some.
 */
function namePieces(node: Node): string[] {
  if (node.nodeType === TEXT_NODE) {
    return [node.textContent ?? ""];
  }
  const attributes =
    node.nodeType === ELEMENT_NODE
      ? NAME_ATTRIBUTES.map(
          (attribute) => (node as Element).getAttribute(attribute) ?? ""
        )
      : [];
  return [...attributes, ...Array.from(node.childNodes).flatMap(namePieces)];
}

/** Whether `wanted` is some in-order selection of whole `pieces`, joined. */
function canJoin(wanted: string, pieces: string[]): boolean {
  const reached = new Set([0]);
  for (const piece of pieces) {
    if (piece === "") {
      continue;
    }
    for (const start of [...reached]) {
      if (wanted.startsWith(piece, start)) {
        reached.add(start + piece.length);
      }
    }
  }
  return reached.has(wanted.length);
}

function isLabelTarget(element: HTMLElement): boolean {
  const targets = new Set(
    labelsInTree(element)
      .map((label) => label.htmlFor)
      .filter((id) => id !== "")
  );
  return (
    targets.size > 0 &&
    [element, ...element.querySelectorAll("[id]")].some((node) =>
      targets.has(node.id)
    )
  );
}

/**
 * The labels in `element`'s own tree: its document, its shadow root, or the
 * root of a detached subtree.
 */
function labelsInTree(element: HTMLElement): HTMLLabelElement[] {
  // Node types, not `instanceof`: an iframe's nodes come from another realm.
  const root = element.getRootNode();
  if (!("querySelectorAll" in root)) {
    return [];
  }
  const labels = Array.from((root as ParentNode).querySelectorAll("label"));
  return root.nodeName === "LABEL"
    ? [root as HTMLLabelElement, ...labels]
    : labels;
}

function squash(text: string): string {
  return text.replace(WHITESPACE, "");
}

const WHITESPACE = /\s+/g;

const ELEMENT_NODE = 1;

const TEXT_NODE = 3;

// The attributes the accessible-name computation reads from an element and
// its descendants, other than the references in NAMED_ELSEWHERE.
const NAME_ATTRIBUTES = [
  "aria-label",
  "alt",
  "title",
  "value",
  "placeholder",
  "label",
  "aria-valuetext",
  "aria-valuenow",
];

// Names that can come from outside the element's own subtree (a reference or
// a shadow-DOM slot), or from a form control's value or default label.
const NAMED_ELSEWHERE =
  "[aria-labelledby], [aria-owns], input, select, textarea, slot";
