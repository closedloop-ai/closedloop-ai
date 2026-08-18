/**
 * Shared truncate-plus-tooltip primitive for the agents feature slice
 * (FEA-3775). A long code identifier — the component name in the workspace
 * table — is clamped to its grid track and surfaces its full value in an sd3
 * tooltip on hover/focus.
 *
 * This primitive owns the case the sessions table's `renderTooltipChip` helper
 * cannot: a trigger that is an *anchor or native button* rather than a `Chip`.
 * The workspace name lead links to the component (or, with no href, is a native
 * tooltip-trigger button), so it needs a tooltip shell that leaves the trigger
 * element per-call-site while still sharing the "these labels are code
 * identifiers, so render them mono" content decision in one place. Chip-shaped
 * truncated labels in the sessions table use `renderTooltipChip` instead — the
 * two abstractions split cleanly by trigger shape and never overlap.
 *
 * Only the truncating font (`TRUNCATED_LABEL_CLASS`) and the tooltip content
 * shell are shared here; the trigger element stays at the call site.
 * `whitespace-pre-line` is opt-in for multi-line tooltip bodies.
 */

import {
  Tooltip,
  TooltipContent,
} from "@repo/design-system/components/ui/tooltip";
import type { ReactNode } from "react";

/**
 * Tailwind classes that truncate a label to its `min-w-0` flex/grid track and
 * render it in the mono identifier face. Spread onto whichever element is the
 * tooltip trigger (anchor, button, or the inner `<span>` of a chip).
 */
export const TRUNCATED_LABEL_CLASS = "min-w-0 truncate font-mono";

type TruncatedLabelTooltipProps = {
  /**
   * The truncating trigger element. Wrap it in `<TooltipTrigger asChild>` at
   * the call site when it is an interactive element (anchor/chip) so no extra
   * wrapper defeats `min-w-0` truncation; pass a plain node otherwise and it is
   * wrapped in a native-button trigger here.
   */
  trigger: ReactNode;
  /** Full, untruncated value shown in the tooltip on hover/focus. */
  fullValue: ReactNode;
  /** True when {@link fullValue} contains newlines that should be preserved. */
  multiline?: boolean;
  /**
   * Render the tooltip body in the mono identifier face. Defaults to `true`
   * (pure code identifiers — component names, branch labels). Set `false` for
   * bodies that mix identifiers with prose (e.g. the PR summary `#19 open ·
   * <title>`), which read better in the sans face.
   */
  mono?: boolean;
};

/**
 * Wraps a truncating trigger in an sd3 tooltip that reveals the full label. The
 * tooltip content shell (`max-w-xs break-words`, mono by default) is the single
 * shared definition every agents-slice truncated label uses.
 */
export function TruncatedLabelTooltip({
  trigger,
  fullValue,
  multiline = false,
  mono = true,
}: TruncatedLabelTooltipProps): ReactNode {
  const contentClass = [
    "max-w-xs break-words",
    multiline ? "whitespace-pre-line" : null,
    mono ? "font-mono" : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tooltip>
      {trigger}
      <TooltipContent className={contentClass}>{fullValue}</TooltipContent>
    </Tooltip>
  );
}
