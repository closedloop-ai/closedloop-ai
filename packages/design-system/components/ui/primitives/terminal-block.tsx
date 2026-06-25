"use client";

import { Terminal } from "lucide-react";
import { CopyButton } from "./copy-button";

type TerminalBlockProps = {
  command?: string;
  description?: string;
  label?: string;
  text?: string;
  stream?: "stdout" | "stderr";
};

export function TerminalBlock({
  command,
  description,
  label = "terminal",
  text,
  stream,
}: TerminalBlockProps) {
  const body =
    text ??
    [description ? `# ${description}` : null, command ? `$ ${command}` : null]
      .filter(Boolean)
      .join("\n");

  const isErrorStream = stream === "stderr";

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-zinc-950/95 shadow-sm">
      <div className="flex items-center justify-between border-border/60 border-b bg-black/30 px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 uppercase tracking-[0.12em]">
          <Terminal className="size-3" />
          <span>{stream ?? label}</span>
        </div>
        <CopyButton label="Copy" text={body} />
      </div>
      <pre
        className={`max-h-96 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed ${
          isErrorStream ? "text-red-200" : "text-zinc-100"
        }`}
      >
        {body}
      </pre>
    </div>
  );
}
