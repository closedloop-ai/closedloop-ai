"use client";

import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";
import { type DocBlock, DocBlockKind, docBody } from "../mock";
import { MermaidFigure } from "./mermaid-figure";

// Static rich-text body for the evergreen Document. Highlighted spans are the
// inline anchors: clicking one focuses its thread in the rail, exactly as the
// real editor scrolls the anchored thread into view on selection click.

type HighlightProps = {
  children: ReactNode;
  threadId: string;
  isActive: boolean;
  onClick: (threadId: string) => void;
};

function Highlight({
  children,
  threadId,
  isActive,
  onClick,
}: Readonly<HighlightProps>) {
  return (
    <button
      aria-label={`Open comment thread on "${children}"`}
      className={cn(
        "rounded-sm px-0.5 text-left underline decoration-primary/40 decoration-dotted underline-offset-2 transition-colors",
        isActive ? "bg-primary/20" : "bg-primary/10 hover:bg-primary/20"
      )}
      onClick={() => onClick(threadId)}
      type="button"
    >
      {children}
    </button>
  );
}

type DocumentBodyProps = {
  activeThreadId: string | null;
  onAnchorClick: (threadId: string) => void;
};

function renderBlock(
  block: DocBlock,
  index: number,
  activeThreadId: string | null,
  onAnchorClick: (threadId: string) => void
): ReactNode {
  if (block.kind === DocBlockKind.Heading) {
    return (
      <h2
        className="mt-6 mb-2 font-semibold text-foreground text-lg first:mt-0"
        key={index}
      >
        {block.text}
      </h2>
    );
  }
  if (block.kind === DocBlockKind.Mermaid) {
    return <MermaidFigure caption={block.caption} key={index} />;
  }
  if (block.highlight && block.highlightThreadId) {
    return (
      <p className="text-base text-foreground leading-relaxed" key={index}>
        {block.before}
        <Highlight
          isActive={activeThreadId === block.highlightThreadId}
          onClick={onAnchorClick}
          threadId={block.highlightThreadId}
        >
          {block.highlight}
        </Highlight>
        {block.after}
      </p>
    );
  }
  return (
    <p className="text-base text-foreground leading-relaxed" key={index}>
      {block.text}
    </p>
  );
}

export function DocumentBody({
  activeThreadId,
  onAnchorClick,
}: Readonly<DocumentBodyProps>) {
  return (
    <div className="flex flex-col gap-3">
      {docBody.map((block, index) =>
        renderBlock(block, index, activeThreadId, onAnchorClick)
      )}
    </div>
  );
}
