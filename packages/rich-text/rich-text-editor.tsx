"use client";

import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import dynamic from "next/dynamic";
import type { RichTextEditorProps } from "./types";

const TiptapEditorCore = dynamic(
  () => import("./tiptap-editor-core").then((mod) => mod.TiptapEditorCore),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[calc(100vh-250px)] w-full" />
        <div className="flex justify-center">
          <Skeleton className="h-10 w-80" />
        </div>
      </div>
    ),
  }
);

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  className,
  readOnly,
  liveblocksExtension,
  liveblocksIsReady,
  onEditorReady,
  scrollMode = "inner",
  externalToolbar,
  toolbarMode = "always",
  mermaidEnhancementsEnabled,
}: Readonly<RichTextEditorProps>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TiptapEditorCore
        className={className}
        externalToolbar={externalToolbar}
        liveblocksExtension={liveblocksExtension}
        liveblocksIsReady={liveblocksIsReady}
        mermaidEnhancementsEnabled={mermaidEnhancementsEnabled}
        onChange={onChange}
        onEditorReady={onEditorReady}
        placeholder={placeholder}
        readOnly={readOnly}
        scrollMode={scrollMode}
        toolbarMode={toolbarMode}
        value={value}
      />
    </div>
  );
}
