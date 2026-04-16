"use client";

import { cn } from "@repo/design-system/lib/utils";
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useRef } from "react";

export type CollapsibleBlockVariant =
  | "thinking"
  | "tool"
  | "result"
  | "error"
  | "context";

type CollapsibleBlockProps = {
  id: string;
  title: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  variant: CollapsibleBlockVariant;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
  // Stable, monotonically increasing integer derived from the streamed
  // content so the auto-scroll effect re-runs as new tokens arrive.
  // Parents pass `content.length` or a similar counter. Undefined means
  // "no auto-scroll on content growth" -- safe default for non-streaming
  // call sites.
  contentLength?: number;
};

const variantStyles = {
  thinking: {
    container:
      "border-purple-500/40 dark:border-purple-400/30 bg-purple-500/10 dark:bg-purple-400/10",
    header:
      "text-purple-700 dark:text-purple-300 hover:bg-purple-500/15 dark:hover:bg-purple-400/15",
    content:
      "bg-purple-500/5 dark:bg-purple-400/5 border-purple-500/30 dark:border-purple-400/20",
  },
  tool: {
    container:
      "border-blue-500/40 dark:border-blue-400/30 bg-blue-500/10 dark:bg-blue-400/10",
    header:
      "text-blue-700 dark:text-blue-300 hover:bg-blue-500/15 dark:hover:bg-blue-400/15",
    content:
      "bg-blue-500/5 dark:bg-blue-400/5 border-blue-500/30 dark:border-blue-400/20",
  },
  result: {
    container:
      "border-green-500/40 dark:border-green-400/30 bg-green-500/10 dark:bg-green-400/10",
    header:
      "text-green-700 dark:text-green-300 hover:bg-green-500/15 dark:hover:bg-green-400/15",
    content:
      "bg-green-500/5 dark:bg-green-400/5 border-green-500/30 dark:border-green-400/20",
  },
  error: {
    container:
      "border-destructive/50 dark:border-destructive/30 bg-destructive/10 dark:bg-destructive/5",
    header:
      "text-destructive hover:bg-destructive/15 dark:hover:bg-destructive/10",
    content:
      "bg-destructive/10 dark:bg-destructive/5 border-destructive/30 dark:border-destructive/15",
  },
  context: {
    container: "border-current/30 bg-current/10",
    header: "text-current/90 hover:bg-current/15",
    content: "bg-current/5 border-current/20",
  },
};

/**
 * Collapsible card for tool calls, thinking blocks, and results
 */
export const CollapsibleBlock = memo(function CollapsibleBlock({
  id,
  title,
  icon: Icon,
  variant,
  isExpanded,
  onToggle,
  children,
  contentLength,
}: Readonly<CollapsibleBlockProps>) {
  const styles = variantStyles[variant];
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when content grows while expanded (e.g. streaming
  // thinking). `contentLength` is the dependency that actually changes per
  // streamed token -- without it, the effect only re-runs on expand/collapse
  // and streaming updates never scroll.
  useEffect(() => {
    if (isExpanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [isExpanded, contentLength]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border transition-all duration-200",
        styles.container
      )}
    >
      <button
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 font-medium text-sm transition-colors focus:outline-none",
          styles.header
        )}
        onClick={() => onToggle(id)}
      >
        <span
          className="shrink-0 transition-transform duration-200"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          <ChevronRight className="size-3.5" />
        </span>
        <Icon className="size-3.5 shrink-0 opacity-70" />
        <CollapsibleHeaderContent
          isExpanded={isExpanded}
          title={title}
          variant={variant}
        >
          {children}
        </CollapsibleHeaderContent>
      </button>
      {isExpanded && (
        <div
          className={cn(
            "log-scrollbar fade-in max-h-80 animate-in overflow-auto whitespace-pre-wrap border-t px-3 py-2.5 font-mono text-xs duration-150",
            styles.content
          )}
          ref={contentRef}
        >
          {typeof children === "string" ? formatInlineBold(children) : children}
        </div>
      )}
    </div>
  );
});

function CollapsibleHeaderContent({
  isExpanded,
  variant,
  title,
  children,
}: Readonly<{
  isExpanded: boolean;
  variant: CollapsibleBlockVariant;
  title: React.ReactNode;
  children: React.ReactNode;
}>) {
  if (isExpanded) {
    return <span className="flex-1 truncate text-left">{title}</span>;
  }
  if (variant === "thinking") {
    return (
      <div
        className="flex min-w-0 flex-1 flex-col-reverse overflow-hidden text-left font-mono text-xs opacity-50"
        style={{
          maxHeight: "1.4em",
          maskImage: "linear-gradient(to right, black 50%, transparent 95%)",
          WebkitMaskImage:
            "linear-gradient(to right, black 50%, transparent 95%)",
        }}
      >
        <span>{children}</span>
      </div>
    );
  }
  return <span className="flex-1 truncate text-left opacity-70">{title}</span>;
}

function formatInlineBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) {
    return text;
  }
  return parts.map((part, i) => {
    const boldMatch = /^\*\*(.+)\*\*$/.exec(part);
    if (boldMatch) {
      return <strong key={`bold-${String(i)}`}>{boldMatch[1]}</strong>;
    }
    return part;
  });
}
