"use client";

import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { lazy, Suspense, useEffect, useState } from "react";
import type { RichTextEditorProps } from "./types";

// Tiptap needs the DOM and must not run during server rendering. This previously
// used next/dynamic({ ssr: false }); React.lazy + a mount gate reproduces the
// same three behaviours — client-only render, a code-split editor chunk, and a
// skeleton fallback — without importing next/*. That keeps @repo/rich-text
// bundleable by both the Next web shell and the desktop (Vite) renderer.
const TiptapEditorCore = lazy(() =>
  import("./tiptap-editor-core").then((mod) => ({
    default: mod.TiptapEditorCore,
  }))
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
  inlineImagesEnabled,
  uploadInlineImage,
  resolveInlineImages,
  validateInlineImageFile,
  onInlineImageUploadError,
}: Readonly<RichTextEditorProps>) {
  // Render only after mount so the editor never executes during SSR (mirrors the
  // prior `ssr: false`). The server and the first client render both emit the
  // skeleton, so hydration matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {mounted ? (
        <Suspense fallback={<EditorSkeleton />}>
          <TiptapEditorCore
            className={className}
            externalToolbar={externalToolbar}
            inlineImagesEnabled={inlineImagesEnabled}
            liveblocksExtension={liveblocksExtension}
            liveblocksIsReady={liveblocksIsReady}
            mermaidEnhancementsEnabled={mermaidEnhancementsEnabled}
            onChange={onChange}
            onEditorReady={onEditorReady}
            onInlineImageUploadError={onInlineImageUploadError}
            placeholder={placeholder}
            readOnly={readOnly}
            resolveInlineImages={resolveInlineImages}
            scrollMode={scrollMode}
            toolbarMode={toolbarMode}
            uploadInlineImage={uploadInlineImage}
            validateInlineImageFile={validateInlineImageFile}
            value={value}
          />
        </Suspense>
      ) : (
        <EditorSkeleton />
      )}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-[calc(100vh-250px)] w-full" />
      <div className="flex justify-center">
        <Skeleton className="h-10 w-80" />
      </div>
    </div>
  );
}
