"use client";

import { VersionedDocumentEditorContainer as SharedContainer } from "@repo/app/documents/components/versioned-document-editor-container";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";

export function VersionedDocumentEditorContainer(
  props: Omit<ComponentProps<typeof SharedContainer>, "onNotFound">
) {
  return <SharedContainer {...props} onNotFound={notFound} />;
}
