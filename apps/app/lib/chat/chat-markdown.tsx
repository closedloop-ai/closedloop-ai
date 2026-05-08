/**
 * Shared ReactMarkdown component configurations for chat interfaces
 */

import type { Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { getTextContent } from "@/lib/engineer/utils";

type ChatMarkdownOptions = {
  /**
   * CSS class for inline code text color
   * @default "text-primary"
   */
  codeColor?: string;
};

/**
 * Create ReactMarkdown components configured for chat message rendering.
 * Includes syntax highlighting for code blocks.
 */
export function createChatMarkdownComponents(
  options?: ChatMarkdownOptions
): Components {
  const codeColor = options?.codeColor ?? "text-primary";

  return {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || "");
      const codeString = getTextContent(children).replace(/\n$/, "");

      // Block code with language
      if (match) {
        return (
          <SyntaxHighlighter
            className="!my-2 !rounded-lg !text-xs chat-code-block"
            language={match[1]}
            PreTag="div"
            style={oneDark}
          >
            {codeString}
          </SyntaxHighlighter>
        );
      }

      // Block code without language (check if multiline)
      if (codeString.includes("\n")) {
        return (
          <SyntaxHighlighter
            className="!my-2 !rounded-lg !text-xs chat-code-block"
            language="text"
            PreTag="div"
            style={oneDark}
          >
            {codeString}
          </SyntaxHighlighter>
        );
      }

      // Inline code
      return (
        <code
          className={`rounded bg-muted-foreground/20 px-1.5 py-0.5 text-[12px] ${codeColor} break-all font-mono`}
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    p({ children }) {
      return (
        <p className="font-mono text-[13px] leading-relaxed">{children}</p>
      );
    },
    ul({ children }) {
      return (
        <ul className="list-disc pl-4 font-mono text-[13px]">{children}</ul>
      );
    },
    ol({ children }) {
      return (
        <ol className="list-decimal pl-4 font-mono text-[13px]">{children}</ol>
      );
    },
    li({ children }) {
      return <li className="font-mono text-[13px]">{children}</li>;
    },
    hr() {
      return <hr className="my-4 border-border/50" />;
    },
    a({ href, children }) {
      return (
        <a
          className="text-primary hover:underline"
          href={href}
          rel="noopener noreferrer"
          target="_blank"
        >
          {children}
        </a>
      );
    },
  };
}

/**
 * Default chat markdown components using primary (gold) color for inline code.
 */
export const chatMarkdownComponents: Components =
  createChatMarkdownComponents();
