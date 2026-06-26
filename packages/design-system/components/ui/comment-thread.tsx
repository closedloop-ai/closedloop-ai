"use client";

import { cn } from "@repo/design-system/lib/utils";
import { ChevronDown } from "lucide-react";
import type {
  ComponentPropsWithoutRef,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
} from "react";

type CommentThreadCardProps = {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  selected?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  tabIndex?: number;
  testId?: string;
} & Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "className" | "onClick" | "onKeyDown" | "tabIndex"
>;

export function CommentThreadCard({
  children,
  className,
  interactive = false,
  onClick,
  onKeyDown,
  selected = false,
  tabIndex,
  testId,
  ...props
}: Readonly<CommentThreadCardProps>) {
  return (
    <div
      className={cn(
        "relative min-w-0 overflow-hidden rounded-lg border border-border",
        interactive &&
          (selected
            ? "bg-accent transition-colors"
            : "transition-colors hover:bg-accent/50"),
        className
      )}
      data-testid={testId}
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      {...props}
    >
      {children}
    </div>
  );
}

type CommentThreadMainProps = {
  avatar: ReactNode;
  content: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function CommentThreadMain({
  actions,
  avatar,
  className,
  content,
}: Readonly<CommentThreadMainProps>) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-start gap-2 px-3 py-3 sm:gap-3 sm:px-4 sm:py-4",
        className
      )}
    >
      {avatar}
      <div className="flex w-0 flex-1 flex-col gap-2">{content}</div>
      {actions}
    </div>
  );
}

type CommentThreadHeaderProps = {
  author: ReactNode;
  metadata?: ReactNode;
  className?: string;
};

export function CommentThreadHeader({
  author,
  className,
  metadata,
}: Readonly<CommentThreadHeaderProps>) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {author}
      {metadata}
    </div>
  );
}

type CommentThreadRepliesProps = {
  children: ReactNode;
  className?: string;
  label?: ReactNode;
  showDivider?: boolean;
};

export function CommentThreadReplies({
  children,
  className,
  label,
  showDivider = false,
}: Readonly<CommentThreadRepliesProps>) {
  return (
    <>
      {label ? (
        <div className="mx-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="font-medium text-muted-foreground text-xs">
            {label}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <div
        className={cn(
          showDivider
            ? "space-y-3 border-border border-t bg-muted/20 px-3 py-3 sm:px-4"
            : "space-y-3 border-muted border-l-2 bg-muted/20 px-3 py-3 pb-4 pl-8 sm:px-4 sm:pl-12",
          className
        )}
      >
        {children}
      </div>
    </>
  );
}

type CommentThreadReplyRowProps = {
  avatar: ReactNode;
  header: ReactNode;
  body: ReactNode;
  actions?: ReactNode;
};

export function CommentThreadReplyRow({
  actions,
  avatar,
  body,
  header,
}: Readonly<CommentThreadReplyRowProps>) {
  return (
    <div className="flex items-start gap-2.5">
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {header}
        {body}
      </div>
      {actions}
    </div>
  );
}

type CommentThreadBannerProps = {
  children: ReactNode;
  className?: string;
};

export function CommentThreadBanner({
  children,
  className,
}: Readonly<CommentThreadBannerProps>) {
  return (
    <div
      className={cn(
        "flex items-center justify-end border-b bg-muted/40 px-3 py-1",
        className
      )}
    >
      {children}
    </div>
  );
}

type CommentThreadAnchorPreviewProps = {
  children: ReactNode;
  className?: string;
};

export function CommentThreadAnchorPreview({
  children,
  className,
}: Readonly<CommentThreadAnchorPreviewProps>) {
  return (
    <blockquote
      className={cn(
        "whitespace-pre-wrap border-b bg-muted/40 px-3 py-2 text-muted-foreground text-xs italic",
        className
      )}
    >
      {children}
    </blockquote>
  );
}

type CommentThreadCollapseFooterProps = {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
} & Omit<ComponentPropsWithoutRef<"button">, "onClick" | "children" | "type">;

export function CommentThreadCollapseFooter({
  className,
  label,
  onClick,
  ...props
}: Readonly<CommentThreadCollapseFooterProps>) {
  return (
    <button
      className={cn(
        "flex w-full items-center justify-center gap-1.5 border-border border-t bg-muted/10 py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground",
        className
      )}
      onClick={onClick}
      type="button"
      {...props}
    >
      <ChevronDown className="h-3.5 w-3.5 rotate-180" />
      {label}
    </button>
  );
}
