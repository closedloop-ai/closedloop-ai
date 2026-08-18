"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { useDocumentBySlug } from "@repo/app/documents/hooks/use-documents";
import { keepPreviousData } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useState } from "react";
import { DocumentEditor } from "./document-editor";

type DocumentEditorContainerProps = {
  slug: string;
  version?: number;
  /**
   * The full `DocumentDetail` the server route already fetched to make its
   * DOC-vs-redirect routing decision (ISS-4382). Seeded as TanStack `initialData`
   * so the editor renders immediately without a second, identical by-slug
   * request on mount — eliminating the serial two-request waterfall. Only valid
   * for the latest-version query key, since the server fetch is version-agnostic;
   * a specific historical `version` still fetches fresh.
   */
  initialDocument?: DocumentDetail;
};

/**
 * Client container for the org-level Document (DOC) editor (ISS-4382).
 *
 * Mirrors {@link PRDEditorContainer}: it fetches the artifact by slug (with an
 * optional version), keeps the previous version's content visible while a
 * version switch loads, and hands the resolved `DocumentDetail` to
 * {@link DocumentEditor}. The parent route has already confirmed the slug
 * resolves to a DOC-subtype artifact, so a fetch miss here is a genuine 404.
 */
export function DocumentEditorContainer({
  slug,
  version: initialVersion,
  initialDocument,
}: Readonly<DocumentEditorContainerProps>) {
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(
    initialVersion
  );

  // Only hydrate the latest-version query with the server-fetched detail; the
  // server request carried no `?version`, so it is not a valid seed for a
  // historical selection.
  const hydratedInitialData =
    selectedVersion === undefined ? initialDocument : undefined;

  const {
    data: document,
    isLoading,
    error,
  } = useDocumentBySlug(slug, selectedVersion, {
    placeholderData: keepPreviousData,
    initialData: hydratedInitialData,
    // Treat the server-hydrated detail as fresh briefly so the mount does not
    // immediately re-request the same by-slug detail the server already fetched;
    // without this, `initialData` (stale by default) refetches on mount and the
    // two-request waterfall returns. Kept short so version switches / edits stay
    // responsive.
    staleTime: hydratedInitialData ? 30_000 : 0,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !document) {
    notFound();
  }

  const currentVersion = document.version.version;

  const handleVersionChange = (version: number) => {
    if (version !== currentVersion) {
      setSelectedVersion(version);
    }
  };

  return (
    <DocumentEditor
      currentVersion={currentVersion}
      document={document}
      onVersionChange={handleVersionChange}
    />
  );
}
