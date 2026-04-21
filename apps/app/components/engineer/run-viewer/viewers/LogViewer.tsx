"use client";

import { useMemo } from "react";
import { decodeText } from "@/lib/engineer/run-viewer-utils";

type LogViewerProps = {
  data: Uint8Array;
};

const ANSI_ESCAPE_PREFIX = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ANSI_ESCAPE_PREFIX}\\[[0-9;]*m`, "g");

export function LogViewer({ data }: Readonly<LogViewerProps>) {
  const lines = useMemo(() => {
    const text = decodeText(data);
    return text.split("\n").map((line) => line.replaceAll(ANSI_RE, ""));
  }, [data]);

  return (
    <div className="h-full overflow-auto rounded-md bg-zinc-950">
      <pre className="p-4 font-mono text-xs text-zinc-300 leading-relaxed">
        <table className="border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr
                className="hover:bg-zinc-800/50"
                key={`line-${String(i + 1)}`}
              >
                <td className="select-none whitespace-nowrap pr-4 text-right align-top text-zinc-600">
                  {i + 1}
                </td>
                <td className="whitespace-pre-wrap break-all">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </pre>
    </div>
  );
}
