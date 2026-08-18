import { Children, type ReactNode } from "react";
import { ScrollArea } from "@closedloop-ai/design-system/components/ui/scroll-area";
import { cn } from "@closedloop-ai/design-system/lib/utils";

type KanbanBoardLayoutProps = {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /**
   * When true, columns stack into a single scrollable column below `sm` (640px)
   * and only lay out side-by-side with horizontal scroll at `sm+`. A narrow
   * touch screen can't show three 280px columns side-by-side, and a horizontal
   * scroll gesture fights the vertical page scroll, so stacking reads better
   * there. Defaults to false so existing desktop boards are unchanged.
   */
  stackBelow?: boolean;
};

/**
 * The board owns no height of its own. It can take one from `className`, or be
 * sized by its content through `contentClassName`.
 *
 * Sharing a flex column with anything below it (a pagination footer, a status
 * bar) means passing `flex-1`, so the column hands the board what is left after
 * its siblings; `min-h-0` is already in the base, so a caller only adds a
 * `min-h-*` to set a floor. Do NOT hand it a measured viewport-bottom height:
 * that measurement cannot see a sibling underneath, so the board overflows it
 * and the columns silently intercept every click aimed at it (ISS-4576).
 */
export function KanbanBoardLayout({
  children,
  className,
  contentClassName,
  stackBelow = false,
}: KanbanBoardLayoutProps) {
  return (
    <ScrollArea
      className={cn("min-h-0", className)}
      // With stacked columns the board scrolls vertically, so the horizontal
      // scrollbar only makes sense once the columns lay out side-by-side.
      scrollbars={stackBelow ? "both" : "horizontal"}
      type="always"
    >
      <div
        className={cn(
          "flex gap-3 px-4 pb-4",
          stackBelow
            ? "min-w-0 flex-col sm:min-w-max sm:flex-row"
            : "min-w-max",
          contentClassName
        )}
      >
        {children}
      </div>
    </ScrollArea>
  );
}

type KanbanColumnLayoutProps = {
  header: ReactNode;
  children?: ReactNode;
  emptyState?: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
};

export function KanbanColumnLayout({
  header,
  children,
  emptyState,
  footer,
  className,
  bodyClassName,
}: KanbanColumnLayoutProps) {
  const hasChildren = Children.count(children) > 0;

  return (
    <div
      className={cn(
        "flex min-h-0 w-[280px] shrink-0 flex-col overflow-hidden rounded-xl border bg-card/95 shadow-sm",
        className
      )}
    >
      <div className="shrink-0 border-b px-3 py-3">{header}</div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto p-1.5",
          bodyClassName
        )}
      >
        {hasChildren ? children : emptyState}
      </div>
      {footer ? <div className="shrink-0 border-t px-2 py-1.5">{footer}</div> : null}
    </div>
  );
}

type KanbanColumnProps = {
  title: string;
  count?: number;
  icon?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  emptyState?: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  headerClassName?: string;
  highlighted?: boolean;
  highlightedBodyClassName?: string;
};

export function KanbanColumn({
  title,
  count,
  icon,
  trailing,
  children,
  emptyState,
  footer,
  className,
  bodyClassName,
  headerClassName,
  highlighted = false,
  highlightedBodyClassName = "bg-accent/20",
}: KanbanColumnProps) {
  return (
    <KanbanColumnLayout
      bodyClassName={cn(
        "transition-colors",
        highlighted && highlightedBodyClassName,
        bodyClassName
      )}
      className={className}
      emptyState={emptyState}
      footer={footer}
      header={
        <KanbanColumnHeader
          className={headerClassName}
          count={count}
          icon={icon}
          title={title}
          trailing={trailing}
        />
      }
    >
      {children}
    </KanbanColumnLayout>
  );
}

type KanbanColumnHeaderProps = {
  icon?: ReactNode;
  title: string;
  count?: number;
  trailing?: ReactNode;
  className?: string;
};

export function KanbanColumnHeader({
  icon,
  title,
  count,
  trailing,
  className,
}: KanbanColumnHeaderProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span className="font-medium text-base">{title}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground text-sm">{count}</span>
      ) : null}
      {trailing ? <div className="ml-auto shrink-0">{trailing}</div> : null}
    </div>
  );
}

type KanbanCardFrameProps = {
  children: ReactNode;
  className?: string;
  active?: boolean;
};

export function KanbanCardFrame({
  children,
  className,
  active = false,
}: KanbanCardFrameProps) {
  return (
    <div
      className={cn(
        "rounded-md border bg-card py-2 transition-colors",
        active && "border-primary/35 bg-primary/8 ring-1 ring-primary/20",
        className
      )}
    >
      {children}
    </div>
  );
}
