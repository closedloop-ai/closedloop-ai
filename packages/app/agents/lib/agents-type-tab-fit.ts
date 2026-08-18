/**
 * ISS-4803: how many Agents catalog type tabs fit the width the strip's row
 * actually got, and which of them stay on the strip once the active tab is
 * accounted for.
 *
 * FEA-4019 grew the strip to eight segments (All + the seven `SCOPED_CORE_KINDS`
 * — Agents, Commands, Skills, Plugins, MCPs, Tools, Hooks). At a phone width
 * roughly half of them fit. Which half is not a constant: the row is as wide as
 * the surface it renders on, so the fit has to be computed against a measured
 * width rather than pinned to a breakpoint, and the same code has to keep a
 * 1440px window showing all eight.
 *
 * Pure arithmetic over label lengths so it is unit-testable without a DOM, and
 * so the count the strip renders and the count its overflow control claims come
 * from one place. Mirrors `session-qualifier-fit.ts` (ISS-5282), which solved
 * the same problem for the Sessions `Signals` column.
 */

/**
 * Approximate rendered width (px) of one character of a tab label.
 *
 * A `ToggleGroupItem` at `variant="outline"` is `text-xs` (12px) medium. The
 * estimate is deliberately GENEROUS (12px medium in the product's UI face
 * averages nearer 6px per character): overestimating a tab drops one from the
 * strip and discloses it in the overflow menu, while underestimating renders a
 * tab the row cannot hold — which is the clipping this fit exists to remove.
 * Rounding errors are spent on the safe side on purpose.
 */
const TYPE_TAB_CHAR_WIDTH_PX = 6.5;

/**
 * Per-tab chrome: `px-3` (24px) plus the leading `size-4` kind icon (16px) and
 * the `gap-2` (8px) between the icon and the label.
 */
const TYPE_TAB_CHROME_PX = 48;

/**
 * The `ToggleGroup` container's own chrome at `variant="outline"`: a 1px border
 * and `p-0.5` (2px) on each side. The items themselves sit flush (the group
 * ships `spacing = 0`), so there is no inter-tab gap to account for.
 */
const TYPE_TAB_GROUP_CHROME_PX = 6;

/**
 * Width reserved for the overflow control whenever anything overflows: the
 * `gap-2` (8px) separating it from the strip plus a small ghost button carrying
 * a one- or two-digit counter and a chevron.
 *
 * Reserved against the row's measured content width — which does NOT change when
 * the control appears, because the measured element is the row itself and not
 * the shrinking track inside it. Measuring the track would make the control's
 * own width feed back into the fit that decides whether to render it, which
 * oscillates at the threshold.
 */
const TYPE_TAB_OVERFLOW_CONTROL_PX = 68;

/**
 * How many of `labels` render on the strip before the rest collapse into the
 * overflow control, given the row's measured content width.
 *
 * A non-finite or non-positive width means "not measured yet" (SSR, a detached
 * or `display:none` container, the first paint before the observer reports) and
 * returns EVERY tab. That is deliberately the opposite of the Sessions
 * `Signals` cell, which falls back to a single chip: there the cell is the only
 * home its chips have, whereas here an un-collapsed strip still degrades to the
 * behavior that ships today — a horizontally scrolling track inside
 * `ScrollFadeTrack`. Collapsing on a guess would instead hide tabs that fit.
 */
export function resolveVisibleTypeTabCount(
  labels: readonly string[],
  availableWidthPx: number
): number {
  if (labels.length <= 1) {
    return labels.length;
  }
  if (!(Number.isFinite(availableWidthPx) && availableWidthPx > 0)) {
    return labels.length;
  }
  let usedPx = TYPE_TAB_GROUP_CHROME_PX;
  for (const [index, label] of labels.entries()) {
    const tabPx = estimateTypeTabWidthPx(label);
    // Every tab but the last has to leave room for the control that will
    // disclose whatever it pushed out.
    const isLast = index === labels.length - 1;
    const reservePx = isLast ? 0 : TYPE_TAB_OVERFLOW_CONTROL_PX;
    if (usedPx + tabPx + reservePx > availableWidthPx) {
      // At least one tab always stays on the strip. A row too narrow for even
      // the leading segment still shows it rather than collapsing the entire
      // control into a menu button, which would leave the surface with no
      // visible indication of what it is filtered to.
      return Math.max(1, index);
    }
    usedPx += tabPx;
  }
  return labels.length;
}

/** Approximate rendered width (px) of one type tab carrying `label`. */
export function estimateTypeTabWidthPx(label: string): number {
  return label.length * TYPE_TAB_CHAR_WIDTH_PX + TYPE_TAB_CHROME_PX;
}

/**
 * Split `items` into the ones the strip renders and the ones the overflow
 * control discloses, given how many fit — with the ACTIVE item guaranteed a
 * visible slot.
 *
 * The strip is a segmented control, so the selected segment is the only thing
 * telling the user what the catalog below is filtered to. Letting the selection
 * fall into the overflow menu would leave every visible segment unselected,
 * which reads as "All" — the UI lying about its own state. When the active item
 * does not make the cut it takes the LAST visible slot and the item it displaced
 * joins the FRONT of the overflow, so both lists still read in strip order. At
 * two or more visible slots that keeps the leading item (`All`) on the strip; at
 * exactly one it is `All` that gets displaced, which is right, because at that
 * width the one slot has to say what the catalog is filtered to.
 *
 * Generic over the item shape (it only needs to identify each item) so the fit,
 * the strip, and the tests all share one partition rather than three copies.
 */
export function partitionTypeTabs<T>(
  items: readonly T[],
  visibleCount: number,
  isActive: (item: T) => boolean
): { visible: T[]; overflow: T[] } {
  const cappedCount = Math.max(0, Math.min(visibleCount, items.length));
  const visible = items.slice(0, cappedCount);
  const overflow = items.slice(cappedCount);
  const activeOverflowIndex = overflow.findIndex(isActive);
  if (activeOverflowIndex === -1 || visible.length === 0) {
    return { visible, overflow };
  }
  const [activeItem] = overflow.splice(activeOverflowIndex, 1);
  const displaced = visible.pop();
  if (activeItem !== undefined) {
    visible.push(activeItem);
  }
  if (displaced !== undefined) {
    overflow.unshift(displaced);
  }
  return { visible, overflow };
}

/**
 * Total estimated width (px) of a PINNED strip: the group's own chrome, every
 * visible tab, and the overflow control when there is anything to disclose.
 */
function estimatePinnedStripWidthPx(
  visibleLabels: readonly string[],
  hasOverflow: boolean
): number {
  const tabsPx = visibleLabels.reduce(
    (total, label) => total + estimateTypeTabWidthPx(label),
    0
  );
  return (
    TYPE_TAB_GROUP_CHROME_PX +
    tabsPx +
    (hasOverflow ? TYPE_TAB_OVERFLOW_CONTROL_PX : 0)
  );
}

/**
 * The strip's final split: how many tabs fit, WITH the active tab pinned.
 *
 * `resolveVisibleTypeTabCount` measures the leading run of tabs, but
 * `partitionTypeTabs` may then swap a wider active tab in for the last of them,
 * so the count and the set it is applied to can disagree. Concretely, at a
 * 228.5px content width the fit admits `All` + `Agents`; selecting `Commands`
 * replaces `Agents` and raises the requirement to 241.5px — 13px more than the
 * row has. The pinned tab was then clipped inside the scroll track AND omitted
 * from the overflow menu, which is precisely the unreachable state this module
 * exists to remove (codex, PR #4685).
 *
 * So the fit is re-checked against the set actually rendered and the count
 * walked down until the pinned set fits. Shrinking is what converges: each step
 * drops one tab into the overflow, and the reserve is already counted, so the
 * estimate falls monotonically. It bottoms out at a single tab — the same floor
 * `resolveVisibleTypeTabCount` keeps, because a row too narrow for even one
 * segment still has to say what the catalog is filtered to.
 *
 * Re-checking rather than reserving for the widest possible replacement, which
 * would cost every width the difference between the widest label and the actual
 * one, dropping a tab that fits on the majority of rows to protect a selection
 * the user has usually not made.
 */
export function fitTypeTabs<T>(
  items: readonly T[],
  availableWidthPx: number,
  isActive: (item: T) => boolean,
  labelOf: (item: T) => string
): { visible: T[]; overflow: T[] } {
  const initialCount = resolveVisibleTypeTabCount(
    items.map(labelOf),
    availableWidthPx
  );
  // An unmeasured row reports every tab; there is no width to re-check against
  // and collapsing on a guess would hide tabs that fit.
  const measured = Number.isFinite(availableWidthPx) && availableWidthPx > 0;
  let count = initialCount;
  let split = partitionTypeTabs(items, count, isActive);
  while (measured && count > 1) {
    const neededPx = estimatePinnedStripWidthPx(
      split.visible.map(labelOf),
      split.overflow.length > 0
    );
    if (neededPx <= availableWidthPx) {
      break;
    }
    count -= 1;
    split = partitionTypeTabs(items, count, isActive);
  }
  return split;
}
