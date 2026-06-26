"use client";

import { FileCode } from "lucide-react";
import { CopyButton } from "./copy-button";

type CodeBlockProps = {
  code?: string;
  children?: string;
  className?: string;
  filename?: string;
  compact?: boolean;
  label?: string;
  tone?: "default" | "danger" | "success";
  maxHeight?: string | null;
  showLineNumbers?: boolean;
};

const toneClasses = {
  default: {
    wrapper: "border-border/70 bg-zinc-950/95",
    chrome: "border-border/60 bg-black/30",
    label: "text-zinc-400",
  },
  danger: {
    wrapper: "border-red-500/25 bg-red-950/20",
    chrome: "border-red-500/20 bg-red-950/25",
    label: "text-red-200",
  },
  success: {
    wrapper: "border-emerald-500/25 bg-emerald-950/20",
    chrome: "border-emerald-500/20 bg-emerald-950/25",
    label: "text-emerald-200",
  },
} as const;

export function CodeBlock({
  code,
  children,
  className,
  filename,
  compact = false,
  label,
  tone = "default",
  maxHeight = "24rem",
  showLineNumbers,
}: CodeBlockProps) {
  const content = code ?? children ?? "";
  const lines = content.split("\n");
  const gutter = showLineNumbers ?? lines.length >= 4;
  const palette = toneClasses[tone];
  let lineNumber = 1;

  return (
    <div
      className={`overflow-hidden rounded-xl border shadow-sm ${palette.wrapper} ${className ?? ""}`}
    >
      {compact ? null : (
        <div
          className={`flex items-center justify-between border-b px-3 py-1.5 ${palette.chrome}`}
        >
          <div
            className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] ${palette.label}`}
          >
            {filename ? <FileCode className="size-3" /> : null}
            <span>{filename ?? label ?? "code"}</span>
          </div>
          <CopyButton text={content} />
        </div>
      )}
      <div
        className="overflow-auto"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {gutter ? (
          <table className="w-full border-collapse font-mono text-[11px] leading-relaxed">
            <tbody>
              {lines.map((line) => {
                const currentLine = lineNumber++;
                return (
                  <tr key={`line-${currentLine}-${line.slice(0, 24)}`}>
                    <td className="w-10 select-none border-border/40 border-r bg-black/15 px-2 text-right text-zinc-500">
                      {currentLine}
                    </td>
                    <td className="whitespace-pre-wrap break-words px-3 py-0.5 text-zinc-100">
                      {line || " "}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] text-zinc-100 leading-relaxed">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
