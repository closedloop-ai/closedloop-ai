import { cn } from "@repo/design-system/lib/utils";
import {
  type DotColor,
  getDotColorToken,
  getDotShape,
  getDotShapeClassName,
} from "./activity-dot-rendering";

/**
 * ISS-12117: a Session Timeline mark outside the dot rail — the legend row,
 * the dot hover card's header and the transcript's event bullet — in the SAME
 * colour and shape the rail paints that lane with. Colour from
 * {@link getDotColorToken}, shape from {@link getDotShapeClassName}, the two
 * functions the rail's own dots use.
 *
 * Size stays with the caller's `className`; this owns only colour and shape.
 * `aria-hidden` because the adjacent text is the statement of what the mark
 * means (WCAG 1.4.1).
 */
export function SessionTimelineMarkSwatch({
  className,
  color,
}: Readonly<{ className?: string; color: DotColor }>) {
  return (
    <span
      aria-hidden
      className={cn(className, getDotShapeClassName(color))}
      data-shape={getDotShape(color)}
      style={{ color: getDotColorToken(color) }}
    />
  );
}
