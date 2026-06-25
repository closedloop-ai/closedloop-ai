"use client";

import { cn } from "@repo/design-system/lib/utils";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { getTextContent } from "@/lib/engineer/utils";

const LANGUAGE_REGEX = /language-(\w+)/;
const TRAILING_NEWLINE_REGEX = /\n$/;
// Hidden metadata markers our tooling injects into PR comment bodies, e.g.
// `<!-- closedloop-code-review: {...} -->` and `<!-- closedloop-review-finding ... -->`.
// These carry machine-readable data and must never surface to readers.
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const EXCESS_BLANK_LINES_REGEX = /\n{3,}/g;

/**
 * Shared ReactMarkdown component overrides for rendering GitHub-flavored
 * markdown in comment bodies (PR comments, issue comments, reviews).
 */
const commentMarkdownComponents = {
  code({
    className,
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"code"> & { className?: string }) {
    const match = LANGUAGE_REGEX.exec(className || "");
    const codeString = getTextContent(children).replace(
      TRAILING_NEWLINE_REGEX,
      ""
    );

    if (match) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs"
          language={match[1]}
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }

    if (codeString.includes("\n")) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs"
          language="text"
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }

    return (
      <code
        className="rounded bg-muted-foreground/20 px-1.5 py-0.5 font-mono text-[12px]"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  },
};

type CommentMarkdownProps = {
  children: string;
  className?: string;
};

/**
 * Renders a GitHub-flavored markdown string with syntax highlighting,
 * styled for comment bodies. Wraps content in Tailwind prose classes.
 */
export function CommentMarkdown({
  children,
  className,
}: Readonly<CommentMarkdownProps>) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert prose-headings:my-1.5 prose-p:my-1 max-w-none overflow-x-auto prose-headings:text-sm text-[13px]",
        className
      )}
    >
      <ReactMarkdown
        components={commentMarkdownComponents}
        remarkPlugins={[remarkGfm]}
      >
        {stripHiddenCommentMetadata(children)}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Strip hidden HTML-comment metadata markers from a comment body before render.
 * `react-markdown` already skips raw HTML, but removing the markers explicitly
 * collapses the blank space they leave behind and guards the plain-text path.
 */
function stripHiddenCommentMetadata(body: string): string {
  return body
    .replace(HTML_COMMENT_REGEX, "")
    .replace(EXCESS_BLANK_LINES_REGEX, "\n\n")
    .trim();
}
