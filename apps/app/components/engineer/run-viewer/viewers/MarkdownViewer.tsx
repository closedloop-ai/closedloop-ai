"use client";

import { CheckCircle } from "lucide-react";
import { useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { decodeText } from "@/lib/engineer/run-viewer-utils";
import { getTextContent } from "@/lib/engineer/utils";

type MarkdownViewerProps = {
  data: Uint8Array;
};

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-6 mb-3 border-b pb-2 font-bold text-xl first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 font-semibold text-lg">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-2 font-semibold text-base">{children}</h3>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border px-3 py-2 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-2">{children}</td>
  ),
  tr: ({ children }) => <tr className="even:bg-muted/30">{children}</tr>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || "");
    const codeString = getTextContent(children).replace(/\n$/, "");

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
      <code className="rounded bg-muted px-1.5 py-0.5 text-sm" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-sm">
      {children}
    </pre>
  ),
  ul: ({ children }) => (
    <ul className="list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children, ...props }) => {
    const content = getTextContent(children);
    if (content.startsWith("[ ]")) {
      return (
        <li className="flex items-start gap-2" {...props}>
          <span className="mt-0.5 size-4 shrink-0 rounded border" />
          <span>{content.slice(4)}</span>
        </li>
      );
    }
    if (content.startsWith("[x]") || content.startsWith("[X]")) {
      return (
        <li className="flex items-start gap-2" {...props}>
          <CheckCircle className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <span className="text-muted-foreground line-through">
            {content.slice(4)}
          </span>
        </li>
      );
    }
    return <li {...props}>{children}</li>;
  },
  p: ({ children }) => <p className="my-3">{children}</p>,
  a: ({ href, children }) => (
    <a
      className="text-primary hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border/50" />,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-primary/50 border-l-2 pl-4 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
};

export function MarkdownViewer({ data }: Readonly<MarkdownViewerProps>) {
  const text = useMemo(() => decodeText(data), [data]);

  return (
    <div className="prose-sm h-full max-w-none overflow-auto p-6">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
