import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@closedloop-ai/design-system/components/ui/empty";
import { cn } from "@closedloop-ai/design-system/lib/utils";

// "default" is the full-page scale (roomy vertical padding, the empty state is
// the main event on the screen). "compact" is the in-panel scale: a single
// tighter padding that holds at every breakpoint, for a zero-state that sits
// inside a Card/section alongside other content. `Empty` ships `p-6 … md:p-12`,
// so a bare `py-6` from a call site never wins above 768px — the compact size
// caps the vertical padding at the DS `py-6` step across all widths instead of
// each panel re-guessing (bot review #3663).
type EmptyStateSize = "default" | "compact";

// `EmptyTitle` is a styled `div`, which is right for the common case: a
// zero-state sitting INSIDE a panel that already has its own heading, where a
// second heading would pollute the document outline. It is wrong for the case
// where the empty state IS the page — a full-page 404 or unavailable screen —
// because then the document has no heading at all, so heading navigation skips
// the only content on the screen and the region is announced unlabelled
// (WCAG 2.4.6 Headings and Labels). `titleAs` opts that case into a real
// heading; it is optional so all 80+ existing in-panel call sites keep the
// non-heading `div` and the document outline they have today.
//
// Rendered INSIDE `EmptyTitle` rather than replacing it, so the DS type step
// (`text-lg font-medium tracking-tight`) stays the single source of the title's
// styling. Tailwind preflight resets `h1`–`h6` to `font-size: inherit;
// font-weight: inherit`, so the tag is purely semantic and changes nothing
// visually (ISS-5011, PR #4501).
type EmptyStateTitleTag = "h1" | "h2" | "h3";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  titleAs?: EmptyStateTitleTag;
  description?: string;
  className?: string;
  action?: ReactNode;
  size?: EmptyStateSize;
};

export function EmptyState({
  icon: Icon,
  title,
  titleAs,
  description,
  className,
  action,
  size = "default",
}: Readonly<EmptyStateProps>) {
  const TitleTag = titleAs;
  return (
    <Empty
      className={cn(
        size === "compact" ? "gap-4 py-6 md:p-6" : "py-12",
        className
      )}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon className="size-6" />
        </EmptyMedia>
        <EmptyTitle>{TitleTag ? <TitleTag>{title}</TitleTag> : title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
