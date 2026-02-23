"use client";

import { Dialog, DialogTitle } from "@repo/design-system/components/ui/dialog";
import { ChevronDown, Terminal } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExpandableDialogContent } from "@/components/engineer/ExpandableDialogContent";
import type { LogResponse } from "@/lib/engineer/queries/symphony";
import { JsonlLogViewer } from "./JsonlLogViewer";

type LogViewerProps = {
  isOpen: boolean;
  onClose: () => void;
  logs: LogResponse | undefined;
};

const LINE_HEIGHT = 20; // px — matches text-sm mono line height
const OVERSCAN = 30; // extra lines rendered above/below viewport

/**
 * Unescape log content that may contain JSON-style escape sequences
 */
function unescapeLogContent(content: string): string {
  return content
    .replaceAll(String.raw`\n`, "\n")
    .replaceAll(String.raw`\r`, "")
    .replaceAll(String.raw`\t`, "\t")
    .replaceAll(String.raw`\"`, '"');
}

/**
 * Strip ANSI escape codes for cleaner display
 */
function stripAnsi(text: string): string {
  const esc = String.fromCodePoint(27);
  const pattern = esc + String.raw`\[[0-9;]*m`;
  return text.replaceAll(new RegExp(pattern, "g"), "");
}

/**
 * Virtualized plain text log viewer — only renders visible lines.
 * Handles thousands of lines without layout/paint overhead.
 */
const PlainTextLogViewer = memo(function PlainTextLogViewer({
  content,
}: Readonly<{ content: string }>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const isAutoScrolling = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Memoize line splitting — only re-process when content changes
  const lines = useMemo(() => {
    if (!content) {
      return [];
    }
    return stripAnsi(unescapeLogContent(content)).split("\n");
  }, [content]);

  const totalHeight = lines.length * LINE_HEIGHT;

  // Measure viewport height on mount and resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll to bottom when new lines arrive (if user hasn't scrolled away)
  useEffect(() => {
    if (containerRef.current && !showScrollToBottom) {
      isAutoScrolling.current = true;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setTimeout(() => {
        isAutoScrolling.current = false;
      }, 100);
    }
  }, [showScrollToBottom]);

  // Handle scroll — update virtual window + detect scroll-away
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }

    setScrollTop(el.scrollTop);

    if (isAutoScrolling.current) {
      return;
    }
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setShowScrollToBottom(!isNearBottom);
  }, []);

  // Scroll to bottom button handler
  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      isAutoScrolling.current = true;
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
      setShowScrollToBottom(false);
      setTimeout(() => {
        isAutoScrolling.current = false;
      }, 500);
    }
  }, []);

  // Calculate visible line range with overscan
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN
  );
  const endIndex = Math.min(
    lines.length,
    Math.ceil((scrollTop + viewportHeight) / LINE_HEIGHT) + OVERSCAN
  );

  return (
    <div className="relative min-h-0 flex-1">
      <div
        className="absolute inset-0 overflow-auto bg-muted/30"
        onScroll={handleScroll}
        ref={containerRef}
      >
        {lines.length === 0 ? (
          <div className="p-4 font-mono text-muted-foreground text-sm">
            No logs yet...
          </div>
        ) : (
          <div style={{ height: totalHeight, position: "relative" }}>
            <div
              className="px-4 font-mono text-sm"
              style={{
                position: "absolute",
                top: startIndex * LINE_HEIGHT,
                left: 0,
                right: 0,
              }}
            >
              {lines.slice(startIndex, endIndex).map((line, i) => (
                <div
                  className="whitespace-pre-wrap break-all leading-5"
                  key={startIndex + i}
                  style={{ height: LINE_HEIGHT }}
                >
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {showScrollToBottom && (
        <button
          className="fade-in slide-in-from-bottom-2 absolute right-6 bottom-4 flex size-10 animate-in items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all duration-200 hover:scale-105 hover:bg-primary/90"
          onClick={scrollToBottom}
          title="Scroll to bottom"
        >
          <ChevronDown className="size-5" />
        </button>
      )}
    </div>
  );
});

/**
 * Log viewer dialog component that switches between plain text and JSONL viewers
 */
export function LogViewer({ isOpen, onClose, logs }: Readonly<LogViewerProps>) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isJsonl = logs?.format === "jsonl";
  const lineCount = logs?.totalLines ?? 0;

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={isOpen}>
      <ExpandableDialogContent
        className="flex h-[80vh] max-h-[80vh] w-[95vw] max-w-[95vw] flex-col p-0 lg:max-w-[85vw] xl:max-w-[80vw]"
        isExpanded={isExpanded}
        onToggleExpand={() => setIsExpanded((v) => !v)}
      >
        <DialogTitle className="sr-only">Closedloop.dev Logs</DialogTitle>
        <div className="flex shrink-0 items-center justify-between border-b p-4 pr-24">
          <h2 className="flex items-center gap-2 font-semibold text-lg">
            <Terminal className="size-5" />
            Closedloop.dev Logs
          </h2>
          {lineCount > 0 && (
            <span className="text-muted-foreground text-sm tabular-nums">
              {lineCount} {isJsonl ? "entries" : "lines"}
            </span>
          )}
        </div>

        {isJsonl && logs?.lines ? (
          <JsonlLogViewer
            className="relative min-h-0 flex-1"
            lines={logs.lines}
          />
        ) : (
          <PlainTextLogViewer content={logs?.content || ""} />
        )}
      </ExpandableDialogContent>
    </Dialog>
  );
}
