"use client";

import {
  FIRST_TREE_LEVEL,
  type GridTreeRowMeta,
} from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

/**
 * The identity cell's content for a row inside a `treegrid` (ISS-8921): the
 * lineage indent, the disclosure control, and the caller's own lead content
 * untouched behind them.
 *
 * Rendered ONLY for a caller that supplied a child accessor. A flat table paints
 * `renderLead`'s node exactly as it always did — no wrapper, no spacer, no
 * control — which is what keeps every existing consumer's identity cell
 * byte-identical.
 *
 * Who publishes `aria-expanded` depends on what is above this control, and
 * `declaresExpandedState` is where that is decided. In the grid the treegrid
 * `row` owns the state and the button must not repeat it; in the frozen legacy
 * card-list compatibility surface there is no row at all, so the button has to
 * carry it or the state reaches assistive tech nowhere. The button's NAME
 * always says what pressing it does, which is the half a row cannot say.
 */
export function GridTableV2TreeLead({
  children,
  className,
  collapseLabel = DEFAULT_COLLAPSE_LABEL,
  declaresExpandedState = false,
  expandLabel = DEFAULT_EXPAND_LABEL,
  onToggle,
  tree,
}: {
  children: ReactNode;
  /** Cross-axis alignment delta only — the card layout aligns to the top. */
  className?: string;
  /** Accessible name of the control while the row is OPEN. */
  collapseLabel?: string;
  /**
   * Put `aria-expanded` on the CONTROL, for a layout where no `row` carries it.
   *
   * The grid leaves this false: there the treegrid `row` owns the state, and a
   * button repeating it would state one fact twice in the accessibility tree.
   * The legacy card list is a LIST — it paints no row at all — so with this
   * false the open/closed state would exist nowhere a screen reader can read it,
   * and only the control's name would change (WCAG 4.1.2 Name, Role, Value).
   */
  declaresExpandedState?: boolean;
  /** Accessible name of the control while the row is CLOSED. */
  expandLabel?: string;
  onToggle: (expanded: boolean) => void;
  tree: GridTreeRowMeta;
}) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-density-cozy",
        className
      )}
      style={buildTreeIndentStyle(tree.level)}
    >
      {tree.hasChildren ? (
        <button
          aria-expanded={declaresExpandedState ? tree.isExpanded : undefined}
          aria-label={tree.isExpanded ? collapseLabel : expandLabel}
          // `touch:size-tap-min` is the house answer to a dense control on a
          // coarse pointer (see `sidebar.tsx`'s `touch:min-h-tap-min`), and it
          // matters here specifically because the CARD layout — the one a phone
          // gets — reuses this control. 24px clears WCAG 2.2 SC 2.5.8 exactly;
          // 44px is the target a thumb actually wants.
          className="flex size-icon-lg shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset touch:size-tap-min"
          onClick={(event) => {
            event.stopPropagation();
            onToggle(!tree.isExpanded);
          }}
          type="button"
        >
          {tree.isExpanded ? (
            <ChevronDownIcon className="size-icon-sm" />
          ) : (
            <ChevronRightIcon className="size-icon-sm" />
          )}
        </button>
      ) : (
        // A leaf still reserves the control's track, or its label would start
        // one glyph to the LEFT of its expandable siblings and the depth a
        // reader takes from the indent would disagree with `aria-level`.
        <span aria-hidden="true" className="size-icon-lg shrink-0" />
      )}
      {/* `flex-1` so the caller's own lead content owns the track the indent
          and the control did not take, and `min-w-0` so it still truncates
          there rather than forcing the row wider. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {children}
      </div>
    </div>
  );
}

/**
 * Accessible names for the disclosure. Deliberately generic: the control sits
 * inside the row it opens, so assistive tech announces it in that row's context
 * — a caller that wants "Expand Alpha's children" passes its own.
 */
const DEFAULT_EXPAND_LABEL = "Expand row";
const DEFAULT_COLLAPSE_LABEL = "Collapse row";

/**
 * Lineage indent for one level, or no style at all at the root — so a treegrid
 * whose rows are all roots carries no indentation declaration to inspect.
 *
 * One full CONTROL TRACK per level — the disclosure box plus the gap beside it,
 * read from the same two tokens that lay that track out (`--icon-lg` sizes the
 * button, `--density-cozy` is the row's `gap-density-cozy`). Deriving it rather
 * than writing the sum is what makes the alignment hold: the indent's whole job
 * is to clear the parent's control, so a literal would silently stop clearing it
 * the next time the control or the gap moved.
 *
 * Sizing it to the GLYPH instead of the button is the near-miss worth naming: it
 * lands the child's chevron half a step inside the parent's gap, where it aligns
 * with nothing. At one full track the child's chevron sits exactly under the
 * parent's label, which is the convention a reader is scanning for.
 *
 * A `calc()` rather than a per-depth utility class because depth is row data,
 * and a fixed ladder of classes would cap the depth this primitive supports at
 * whatever the ladder happened to enumerate.
 */
export function buildTreeIndentStyle(
  level: number
): CSSProperties | undefined {
  if (level <= FIRST_TREE_LEVEL) {
    return;
  }
  const depth = level - FIRST_TREE_LEVEL;
  return {
    paddingInlineStart: `calc((var(--icon-lg) + var(--density-cozy)) * ${depth})`,
  };
}
