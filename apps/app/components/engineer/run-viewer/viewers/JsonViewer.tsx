"use client";

import { useMemo } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { decodeText } from "@/lib/engineer/run-viewer-utils";

type JsonViewerProps = {
  data: Uint8Array;
};

export function JsonViewer({ data }: Readonly<JsonViewerProps>) {
  const formatted = useMemo(() => {
    const text = decodeText(data);
    try {
      const parsed = JSON.parse(text);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return text;
    }
  }, [data]);

  return (
    <div className="h-full overflow-auto">
      <SyntaxHighlighter
        customStyle={{ margin: 0, borderRadius: 0, minHeight: "100%" }}
        language="json"
        lineNumberStyle={{ color: "#555", fontSize: "0.7rem" }}
        showLineNumbers
        style={oneDark}
      >
        {formatted}
      </SyntaxHighlighter>
    </div>
  );
}
