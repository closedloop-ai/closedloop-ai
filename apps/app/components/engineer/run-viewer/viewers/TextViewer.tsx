"use client";

import { useMemo } from "react";
import { decodeText } from "@/lib/engineer/run-viewer-utils";

type TextViewerProps = {
  data: Uint8Array;
  filePath: string;
};

export function TextViewer({ data, filePath }: Readonly<TextViewerProps>) {
  const { text, isBinary, isEnv } = useMemo(() => {
    const decoded = decodeText(data);
    const binary = decoded.slice(0, 1024).includes("\uFFFD");
    const env = filePath.endsWith(".env");
    return { text: decoded, isBinary: binary, isEnv: env };
  }, [data, filePath]);

  if (isBinary) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Binary file ({(data.byteLength / 1024).toFixed(1)} KB)
      </div>
    );
  }

  if (isEnv) {
    return <EnvTable text={text} />;
  }

  const lines = text.split("\n");

  return (
    <div className="h-full overflow-auto">
      <pre className="p-4 font-mono text-xs leading-relaxed">
        <table className="border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr className="hover:bg-muted/30" key={`L${String(i + 1)}`}>
                <td className="select-none whitespace-nowrap pr-4 text-right align-top text-muted-foreground/50">
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

function EnvTable({ text }: Readonly<{ text: string }>) {
  const entries = text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) {
        return { key: line, value: "" };
      }
      return { key: line.slice(0, eqIndex), value: line.slice(eqIndex + 1) };
    });

  return (
    <div className="h-full overflow-auto p-4">
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr className="border-border border-b">
            <th className="p-2 text-left font-medium text-muted-foreground">
              Key
            </th>
            <th className="p-2 text-left font-medium text-muted-foreground">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              className="border-border/50 border-b hover:bg-muted/30"
              key={entry.key}
            >
              <td className="whitespace-nowrap p-2 font-medium text-primary">
                {entry.key}
              </td>
              <td className="break-all p-2">{entry.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
