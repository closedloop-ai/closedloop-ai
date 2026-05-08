"use client";

import { useMemo } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { decodeText } from "@/lib/engineer/run-viewer-utils";

type YamlViewerProps = {
  data: Uint8Array;
};

export function YamlViewer({ data }: Readonly<YamlViewerProps>) {
  const text = useMemo(() => decodeText(data), [data]);

  return (
    <div className="h-full overflow-auto">
      <SyntaxHighlighter
        customStyle={{ margin: 0, borderRadius: 0, minHeight: "100%" }}
        language="yaml"
        lineNumberStyle={{ color: "#555", fontSize: "0.7rem" }}
        showLineNumbers
        style={oneDark}
      >
        {text}
      </SyntaxHighlighter>
    </div>
  );
}
