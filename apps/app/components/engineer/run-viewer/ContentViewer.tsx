"use client";

import { useMemo } from "react";
import { JsonlLogViewer } from "@/components/engineer/JsonlLogViewer";
import { decodeText, getFileType } from "@/lib/engineer/run-viewer-utils";
import { EvaluationViewer } from "./viewers/EvaluationViewer";
import { JsonViewer } from "./viewers/JsonViewer";
import { JudgesViewer } from "./viewers/JudgesViewer";
import { LogViewer } from "./viewers/LogViewer";
import { MarkdownViewer } from "./viewers/MarkdownViewer";
import { PlanJsonViewer } from "./viewers/PlanJsonViewer";
import { StateViewer } from "./viewers/StateViewer";
import { TextViewer } from "./viewers/TextViewer";
import { YamlViewer } from "./viewers/YamlViewer";

type ContentViewerProps = {
  filePath: string;
  fileData: Uint8Array;
};

export function ContentViewer({
  filePath,
  fileData,
}: Readonly<ContentViewerProps>) {
  const fileType = getFileType(filePath);

  switch (fileType) {
    case "markdown":
      return <MarkdownViewer data={fileData} />;
    case "judges":
      return <JudgesViewer data={fileData} />;
    case "plan":
      return <PlanJsonViewer data={fileData} />;
    case "state":
      return <StateViewer data={fileData} />;
    case "evaluation":
      return <EvaluationViewer data={fileData} />;
    case "json":
      return <JsonViewer data={fileData} />;
    case "claude-output":
    case "jsonl":
      return <ClaudeOutputViewer data={fileData} />;
    case "yaml":
      return <YamlViewer data={fileData} />;
    case "log":
      return <LogViewer data={fileData} />;
    default:
      return <TextViewer data={fileData} filePath={filePath} />;
  }
}

function ClaudeOutputViewer({ data }: Readonly<{ data: Uint8Array }>) {
  const lines = useMemo(() => {
    const text = decodeText(data);
    return text.split("\n").filter((line) => line.trim());
  }, [data]);

  return <JsonlLogViewer className="h-full" lines={lines} />;
}
