import { Children, type CSSProperties, type ReactNode } from "react";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { cn } from "@repo/design-system/lib/utils";

type KanbanBoardLayoutProps = {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  style?: CSSProperties;
};

export function KanbanBoardLayout({
  children,
  className,
  contentClassName,
  style,
}: KanbanBoardLayoutProps) {
  return (
    <ScrollArea
      className={cn("min-h-0 shrink-0", className)}
      scrollbars="horizontal"
      style={style}
      type="always"
    >
      <div
        className={cn("flex min-w-max gap-3 px-4 pb-4", contentClassName)}
        style={style}
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
