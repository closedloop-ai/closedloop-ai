/**
 * The other half of "one tab stop per grid", WAI-ARIA APG grid pattern
 * (ISS-8726). The roving tabindex in `GridTableV2` already puts exactly one
 * CELL in the tab order; nothing put the controls INSIDE those cells out of it,
 * so `Tab` walked the favourite button, the identity link and every data-cell
 * control in turn instead of entering the grid once and moving on.
 *
 * Suppression is imperative DOM rather than a prop each cell renderer forwards,
 * because the grid never sees that content: `renderLead`, `renderCell` and
 * `renderLeadingUtility` belong to the caller. The rendered body is the only
 * place every control is visible at once, which is also what makes this
 * grid-wide by construction rather than per-row.
 *
 * A suppressed control keeps its route IN. `ENTERABLE_CONTENT_SELECTOR` lives
 * here, beside the suppression that acts on it, because entry and suppression
 * must name the same set: a control this pins at -1 that the entry model can no
 * longer find would have no keyboard route at all — the WCAG 2.1.1 dead end the
 * pattern exists to close. The marker attribute carries the one clause that
 * would otherwise stop matching its own suppression.
 *
 * A cell whose content HOLDS focus is RELEASED, not suppressed, and that is a
 * reachability requirement rather than a nicety. Entry lands on ONE control and
 * a cell may hold several (`GRID_CELL_PRIMARY_EDITOR_SELECTOR` next door exists
 * for exactly that case). Pinning every descendant at -1 for the whole life of
 * the grid would leave the second control of such a cell unreachable by
 * keyboard. While the user is inside a cell the content is theirs and `Tab`
 * moves through it natively; the moment focus returns to the cell or leaves it,
 * the grid takes its tab stops back.
 *
 * Kept React-free, like its `grid-cell-keyboard` and `grid-table-navigation`
 * siblings, so the behaviour is testable as DOM and cannot drift into a
 * component.
 */

import { GRID_CELL_SELECTOR } from "./grid-table-navigation";

/**
 * Marks a control whose tab stop this module took away, so the entry model can
 * still find it. Also the restore ledger's membership test, which is why the
 * original `tabindex` is the only thing held in memory.
 */
export const GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE = "data-grid-suppressed-tab-stop";

const SUPPRESSED_TAB_STOP_SELECTOR = `[${GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE}]`;

/**
 * Entry target when a cell names no primary editor: the first control a pointer
 * user could have operated. Disabled controls are excluded because focusing one
 * is a dead end the user then has to Escape back out of.
 *
 * Deliberately NOT the same list as `INTERACTIVE_CELL_CONTENT_SELECTOR` in
 * `grid-table-navigation`, which answers a different question: that one asks
 * "did this CLICK land on something that owns its own activation", so it names
 * `[role='checkbox']` and `[role='menuitem']` to keep a row-level click off
 * them. This one asks "what can take FOCUS", where the roles are irrelevant and
 * focusability is everything — a Radix checkbox is a real `<button
 * role="checkbox">` and is already matched, and any other custom role reaches
 * the `[tabindex]` clause exactly when it is genuinely focusable. Keeping them
 * in sync would put unfocusable elements in this list and focusable-but-inert
 * ones in that one.
 *
 * The final clause is why suppression cannot hide a control from entry. A
 * `button` or `a[href]` still matches its own TAG clause at `tabindex="-1"`,
 * but a custom-role control matched only by `[tabindex]:not([tabindex='-1'])`
 * would vanish from this list the instant it was suppressed; the marker keeps
 * it findable, and re-states the disabled exclusions so a control that goes
 * disabled while suppressed is still not offered as an entry target.
 */
export const ENTERABLE_CONTENT_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[role='button']:not([aria-disabled='true'])",
  "[tabindex]:not([tabindex='-1'])",
  `${SUPPRESSED_TAB_STOP_SELECTOR}:not([disabled]):not([aria-disabled='true'])`,
].join(", ");

/** Stops suppressing, and hands every control its own tab stop back. */
export type GridCellTabStopController = { dispose: () => void };

/**
 * Take the grid's cell contents out of the tab order, and keep them out as the
 * body re-renders.
 *
 * The observer is what makes this hold for content that arrives later — an
 * inline editor swapping its trigger for a field, a row appended by a create
 * row, a page of rows replacing another. Without it the first paint would be a
 * single tab stop and every subsequent one would leak again.
 */
export function suppressGridCellTabStops(
  gridBody: HTMLElement
): GridCellTabStopController {
  // Weak, so a control removed from a re-rendered row is collectable rather
  // than retained for the life of the grid. Membership lives in the DOM (the
  // marker attribute), so nothing here has to be swept.
  const originalTabIndex = new WeakMap<HTMLElement, string | null>();
  let releasedCell: HTMLElement | null = null;

  const suppress = (element: HTMLElement) => {
    const cell = element.closest<HTMLElement>(GRID_CELL_SELECTOR);
    // `element === cell` is the roving cell itself, which carries the grid's
    // ONLY tab stop: suppressing it would take the whole grid out of the tab
    // order rather than putting one control back in it.
    if (!cell || cell === element || cell === releasedCell) {
      return;
    }
    const liveTabIndex = element.getAttribute("tabindex");
    // Already exactly as this module left it. The early return is also what
    // makes the attribute observer terminate: our own `tabindex` write queues a
    // record, and the pass it triggers has to reach a fixed point rather than
    // write again.
    if (
      liveTabIndex === "-1" &&
      element.hasAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE)
    ) {
      return;
    }
    // A marked element whose `tabindex` is no longer ours had a NEW value
    // rendered over the suppression, and that value — not the one recorded on
    // the first pass — is what release has to hand back.
    originalTabIndex.set(element, liveTabIndex);
    element.setAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE, "");
    element.setAttribute("tabindex", "-1");
  };

  const suppressTree = (root: Element) => {
    if (root.matches(ENTERABLE_CONTENT_SELECTOR)) {
      suppress(root as HTMLElement);
    }
    for (const element of root.querySelectorAll<HTMLElement>(
      ENTERABLE_CONTENT_SELECTOR
    )) {
      suppress(element);
    }
  };

  const release = (root: Element) => {
    for (const element of root.querySelectorAll<HTMLElement>(
      SUPPRESSED_TAB_STOP_SELECTOR
    )) {
      const original = originalTabIndex.get(element);
      originalTabIndex.delete(element);
      element.removeAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE);
      if (original == null) {
        element.removeAttribute("tabindex");
      } else {
        element.setAttribute("tabindex", original);
      }
    }
  };

  // The cell whose CONTENT holds focus, which is not the same as the cell that
  // holds focus: a cell focused itself is being navigated, not entered, and its
  // controls belong back in the grid's single tab stop.
  const setReleasedCell = (next: HTMLElement | null) => {
    const previous = releasedCell;
    if (previous === next) {
      return;
    }
    releasedCell = next;
    if (previous?.isConnected) {
      suppressTree(previous);
    }
    if (next) {
      release(next);
    }
  };

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const cell = target.closest<HTMLElement>(GRID_CELL_SELECTOR);
    setReleasedCell(cell && cell !== target ? cell : null);
  };

  const onFocusOut = (event: FocusEvent) => {
    // A move still inside the grid is settled by the `focusin` that follows it;
    // acting here too would suppress the very control focus is landing on.
    const next = event.relatedTarget;
    if (next instanceof Node && gridBody.contains(next)) {
      return;
    }
    setReleasedCell(null);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof Element) {
          suppressTree(record.target);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          suppressTree(node);
        }
      }
    }
  });

  suppressTree(gridBody);
  observer.observe(gridBody, {
    // Attributes as well as children, because a control can become focusable
    // WITHOUT being re-inserted: a favourite button that stops being
    // `disabled`, an `aria-disabled` that clears, an `href` that arrives, a
    // `tabindex` raised off -1. `ENTERABLE_CONTENT_SELECTOR` excludes each of
    // those states, so a childList-only observer never sees the moment the
    // element starts matching and the grid quietly grows a second tab stop.
    attributeFilter: ["aria-disabled", "disabled", "href", "tabindex"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  gridBody.addEventListener("focusin", onFocusIn);
  gridBody.addEventListener("focusout", onFocusOut);

  return {
    dispose: () => {
      observer.disconnect();
      gridBody.removeEventListener("focusin", onFocusIn);
      gridBody.removeEventListener("focusout", onFocusOut);
      releasedCell = null;
      release(gridBody);
    },
  };
}
