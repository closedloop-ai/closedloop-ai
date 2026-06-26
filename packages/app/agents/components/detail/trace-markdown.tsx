"use client";

import { MarkdownContent } from "@repo/design-system/components/ui/primitives/markdown-content";
import { createContext, type ReactNode, useContext } from "react";

export type TraceJumpHandler = (row: number) => void;

/**
 * Provides the active `onJump` handler to the markdown link renderer without
 * defining the renderer inline (which would create a new component identity on
 * every render and trip the nested-component lint rule).
 */
const TraceJumpContext = createContext<TraceJumpHandler | undefined>(undefined);

const TRACE_TOKEN = /#(\d+)/g;
const TRACE_HREF = /^#trace-(\d+)$/;

/**
 * Minimal structural view of the mdast nodes the trace-link transformer walks.
 * Kept local so `@repo/app` need not depend on `mdast`/`unist` type packages.
 */
type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
};

/**
 * Splits a single mdast `text` node on `#<row>` references, replacing each match
 * with a `link` node whose url uses the internal `#trace-<row>` scheme. The
 * custom anchor renderer turns those back into jump buttons. Non-text nodes
 * (including `code`/`inlineCode`, which carry `value` rather than children) are
 * left untouched, so `#<row>` inside code samples is never linkified.
 */
function splitTraceText(node: MdastNode): MdastNode[] {
  const value = node.value ?? "";
  const out: MdastNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(TRACE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      out.push({ type: "text", value: value.slice(cursor, index) });
    }
    const row = match[1];
    out.push({
      type: "link",
      url: `#trace-${row}`,
      children: [{ type: "text", value: `#${row}` }],
    });
    cursor = index + match[0].length;
  }
  if (out.length === 0) {
    return [node];
  }
  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) });
  }
  return out;
}

function linkifyTraceRows(node: MdastNode): void {
  if (!node.children || node.type === "link") {
    return;
  }
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      next.push(...splitTraceText(child));
    } else {
      linkifyTraceRows(child);
      next.push(child);
    }
  }
  node.children = next;
}

function remarkTraceLinks() {
  return (tree: MdastNode) => {
    linkifyTraceRows(tree);
  };
}

const REMARK_PLUGINS = [remarkTraceLinks];

function TraceAnchor({
  href,
  children,
}: Readonly<{ href?: string; children?: ReactNode }>) {
  const onJump = useContext(TraceJumpContext);
  const match = href ? TRACE_HREF.exec(href) : null;

  if (match) {
    const row = Number(match[1]);
    if (!(onJump && Number.isFinite(row))) {
      return <span className="st-link-static">{children}</span>;
    }
    return (
      <button
        className="st-link inline border-0 bg-transparent p-0 font-[inherit]"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onJump(row);
        }}
        type="button"
      >
        {children}
      </button>
    );
  }

  return (
    <a
      className="st-ext-link"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  );
}

const TRACE_COMPONENTS = { a: TraceAnchor };

type TraceMarkdownProps = {
  text: string;
  onJump?: TraceJumpHandler;
  dense?: boolean;
  className?: string;
};

/**
 * Renders Session Trace message text as parsed markdown (headings, lists,
 * emphasis, tables, inline + fenced code) while preserving the existing
 * `#<row>` jump-to-row links. Reuses the design-system `MarkdownContent`
 * primitive; the `#<row>` behavior is domain-specific and stays in this slice.
 */
export function TraceMarkdown({
  text,
  onJump,
  dense = true,
  className,
}: Readonly<TraceMarkdownProps>) {
  return (
    <TraceJumpContext.Provider value={onJump}>
      <MarkdownContent
        className={className}
        components={TRACE_COMPONENTS}
        dense={dense}
        remarkPlugins={REMARK_PLUGINS}
        text={text}
      />
    </TraceJumpContext.Provider>
  );
}
