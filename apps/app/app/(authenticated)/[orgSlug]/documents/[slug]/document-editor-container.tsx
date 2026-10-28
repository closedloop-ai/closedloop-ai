"use client";

import { VersionedDocumentEditorContainer } from "../../components/versioned-document-editor-container";
import { DocumentEditor } from "./document-editor";

type DocumentEditorContainerProps = {
  slug: string;
  version?: number;
};

export function DocumentEditorContainer({
  slug,
  version,
}: Readonly<DocumentEditorContainerProps>) {
  return (
    <VersionedDocumentEditorContainer
      editor={DocumentEditor}
      slug={slug}
      version={version}
    />
  );
}
