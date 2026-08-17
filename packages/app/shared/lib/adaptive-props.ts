import type { FeedRailMode } from "@repo/design-system/components/ui/feed-rail";
import type {
  GridTableColumn,
  GridTableMode,
} from "@repo/design-system/components/ui/grid-table";
import type { ReactNode } from "react";

/**
 * The RN-parity component contract (FEA-3872 / FEA-3811 Phase 6 / PLN-1458).
 *
 * The responsive chain (Phases 2–5) grew each dense table and the document feed
 * rail an adaptation seam — a layout `mode`, a `cardRender` fallback, a touch
 * always-show affordance. This module is the single canonical name for that
 * seam so a future React Native adapter, `apps/app` (web), and the desktop
 * renderer all speak one vocabulary. Nothing changes web/desktop
 * behavior: these are the props those surfaces already pass, given one type.
 *
 * The React Native adapter reuses the surface-agnostic pieces of a feature slice
 * — the row/card data mappers, the `<Feature>Card` renderers, and the query
 * hooks — and injects RN-native ports for the platform-bound seams (navigation,
 * pressable/overlay chrome, list virtualization). `AdaptiveProps` is the shape
 * that seam takes for the tabular/feed surfaces; see `packages/app/README.md`
 * ("React Native adapter contract") for which seams are portable and how the
 * ports are injected.
 *
 * The type is deliberately built from the primitives that already own each
 * knob — `GridTableMode`, `FeedRailMode`, and the `GridTable` `cardRender`
 * signature — rather than re-declaring string unions, so the contract cannot
 * drift from the components that implement it.
 */

/**
 * Layout density. Compact is the mouse/dense-table rhythm; comfortable is the
 * touch rhythm (WCAG 2.5.5 / iOS-HIG tap targets). Mirrors the additive
 * `--density-*` tokens (FEA-3858). A surface reads this to widen a control's
 * vertical rhythm on touch without changing which control renders. Defaults to
 * `compact` on web/desktop; an RN adapter defaults it to `comfortable`.
 */
export const AdaptiveDensity = {
  Compact: "compact",
  Cozy: "cozy",
  Comfortable: "comfortable",
} as const;

export type AdaptiveDensity =
  (typeof AdaptiveDensity)[keyof typeof AdaptiveDensity];

/**
 * The `cardRender` seam of a `<Feature>Table` (FEA-3865): given a row and the
 * table's columns, return the stacked `<Feature>Card` for a narrow surface. This
 * is the exact signature `GridTable` accepts, named once so an adapter can pass
 * (or wrap) the feature's own card renderer.
 */
export type AdaptiveCardRender<T> = (
  item: T,
  columns: readonly GridTableColumn[]
) => ReactNode;

/**
 * The RN-parity adaptation contract for a tabular feature surface. Every field
 * is optional and additive — a surface that passes none is byte-identical to its
 * pre-responsive form, which is exactly how web/desktop still consume these
 * tables. `T` is the row type of the feature (e.g. `SessionTableRow`,
 * `BranchRow`, `AgentComponent`).
 */
export type AdaptiveProps<T> = {
  /**
   * Which layout the underlying `GridTable` renders. `auto` (default) follows
   * the measured container width — cards below the `md` breakpoint, the grid at
   * `md+`; `compact` pins the card list; `expanded` pins the grid. An RN adapter
   * pins `compact` (RN has no CSS grid).
   */
  mode?: GridTableMode;
  /**
   * Vertical rhythm tier for rows and controls. See {@link AdaptiveDensity}.
   */
  density?: AdaptiveDensity;
  /**
   * Container width (px) below which a surface should collapse the grid to the
   * card list — the shared card-fallback breakpoint. `GridTable` owns this
   * measurement internally at the `md` breakpoint; `wrapBelow` names the knob so
   * a host (or an RN adapter that measures differently) can pin the threshold.
   */
  wrapBelow?: number;
  /**
   * Force row-actions to be always visible instead of hover-revealed. Web/
   * desktop default this to "true on a touch pointer" via the `touch:` variant;
   * an RN adapter, which has no hover at all, passes `true` so the affordance is
   * always reachable. See {@link resolveAlwaysShowActions}.
   */
  alwaysShowActions?: boolean;
  /**
   * The feature's narrow-surface card renderer — its exported `<Feature>Card`,
   * adapted to the `GridTable` `cardRender` signature. See
   * {@link AdaptiveCardRender}.
   */
  cardRender?: AdaptiveCardRender<T>;
};

/**
 * The document feed-rail's slice of the contract. The rail's adaptation knob is
 * `FeedRailMode` (inline → overlay → sheet), not a card fallback, so it carries
 * its own mode alongside the shared density/always-show flags rather than
 * `AdaptiveProps`' grid `mode`.
 */
export type AdaptiveFeedRailProps = {
  /** Inline (adaptive), overlay, or bottom-sheet. See `FeedRailMode`. */
  mode?: FeedRailMode;
  density?: AdaptiveDensity;
  alwaysShowActions?: boolean;
};

/**
 * Resolve the effective always-show-actions decision. When `alwaysShowActions`
 * is explicitly set (true on RN, or a web caller pinning it), honor it;
 * otherwise the surface falls back to its pointer-aware default — the web/
 * desktop `touch:opacity-100` reveal — which callers express by leaving the flag
 * undefined. Centralized so every action-cell resolves the flag the same way.
 */
export function resolveAlwaysShowActions(
  alwaysShowActions: boolean | undefined
): boolean {
  return alwaysShowActions ?? false;
}
