"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";

type ReactMarkdownProps = ComponentPropsWithoutRef<typeof ReactMarkdown>;

type MarkdownContentProps = {
  text: string;
  dense?: boolean;
  className?: string;
  /**
   * Extra component overrides merged over the built-in defaults. Lets callers
   * customize how specific node types render (e.g. a domain-specific link
   * renderer) without forking this primitive.
   */
  components?: ReactMarkdownProps["components"];
  /**
   * Additional remark plugins appended after the built-in `remark-gfm`.
   */
  remarkPlugins?: ReactMarkdownProps["remarkPlugins"];
};

const LANGUAGE_REGEX = /language-(\w+)/;
const TRAILING_NEWLINE_REGEX = /\n$/;

function getTextContent(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => getTextContent(child)).join("");
  }
  if (
    children &&
    typeof children === "object" &&
    "props" in children &&
    children.props &&
    typeof children.props === "object" &&
    "children" in children.props
  ) {
    return getTextContent(children.props.children as ReactNode);
  }
  return "";
}

const markdownComponents = {
  code({
    className,
    children,
    ...props
  }: ComponentPropsWithoutRef<"code"> & { className?: string }) {
    const match = LANGUAGE_REGEX.exec(className || "");
    const codeString = getTextContent(children).replace(
      TRAILING_NEWLINE_REGEX,
      ""
    );

    if (match) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-xl !bg-zinc-950 !text-xs"
          language={match[1]}
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }

    if (codeString.includes("\n")) {
      return <CodeBlock code={codeString} compact={false} />;
    }

    return (
      <code
        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
} satisfies ComponentPropsWithoutRef<typeof ReactMarkdown>["components"];

export function MarkdownContent({
  text,
  dense = false,
  className,
  components,
  remarkPlugins,
}: MarkdownContentProps) {
  const mergedComponents = components
    ? { ...markdownComponents, ...components }
    : markdownComponents;
  const mergedRemarkPlugins = remarkPlugins
    ? [remarkGfm, ...remarkPlugins]
    : [remarkGfm];

  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert prose-headings:my-1.5 prose-p:my-1 max-w-none overflow-x-auto prose-headings:text-sm text-[13px]",
        dense && "prose-p:my-0.5 text-[12px]",
        className
      )}
    >
      <ReactMarkdown
        components={mergedComponents}
        remarkPlugins={mergedRemarkPlugins}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
