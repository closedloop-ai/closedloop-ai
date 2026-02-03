"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";

import type { RichTextEditorProps } from "./types";

const TiptapEditorCore = dynamic(
  () =>
    import("./tiptap-editor-core").then((mod) => mod.TiptapEditorCore),
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
  contentResetKey,
  contentResetValue,
}: Readonly<RichTextEditorProps>) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <TiptapEditorCore
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        liveblocksExtension={liveblocksExtension}
        liveblocksIsReady={liveblocksIsReady}
        onChange={onChange}
        onEditorReady={onEditorReady}
        contentResetKey={contentResetKey}
        contentResetValue={contentResetValue}
      />
    </div>
  );
}
