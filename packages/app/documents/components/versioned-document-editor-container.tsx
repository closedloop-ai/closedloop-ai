"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  useDocumentBySlug,
  useEnsureDocumentBySlug,
} from "@repo/app/documents/hooks/use-documents";
import { ApiError } from "@repo/app/shared/api/api-error";
import { PageLoadingSpinner } from "@repo/app/shared/components/page-loading-spinner";

import { type ComponentType, useRef, useState } from "react";

export type VersionedDocumentEditorProps = {
  currentVersion: number;
  document: DocumentDetail;
  onVersionChange: (version: number) => void;
};

type VersionedDocumentEditorContainerProps = {
  editor: ComponentType<VersionedDocumentEditorProps>;
  slug: string;
  onNotFound: () => never;
  version?: number;
};

export function VersionedDocumentEditorContainer({
  editor: Editor,
  slug,
  onNotFound,
  version: initialVersion,
}: Readonly<VersionedDocumentEditorContainerProps>) {
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(
    initialVersion
  );
  const lastPickedVersionRef = useRef<number | undefined>(undefined);
  const ensureDocumentBySlug = useEnsureDocumentBySlug();
  const {
    data: document,
    isLoading,
    error,
  } = useDocumentBySlug(slug, selectedVersion);

  if (isLoading) {
    return <PageLoadingSpinner />;
  }

  // An API 404 is "not found" even when a cached `document` is still held,
  // e.g. one deleted elsewhere: Perrin Upcott, 2026-10-06 (ISS-12080 ruling 1).
  if (error instanceof ApiError && error.isNotFound()) {
    return onNotFound();
  }

  // Any other failed background refetch keeps the cached `document` alongside
  // `error`, so the artifact stays rendered (ISS-12080).
  if (!document) {
    // A first-load failure goes to the `(authenticated)/error.tsx` boundary,
    // whose "Try again" remounts this container and refetches: Perrin Upcott,
    // 2026-10-06 (ISS-12080 AC4).
    if (error) {
      throw error;
    }
    return onNotFound();
  }

  const currentVersion = document.version.version;
  // Switch only once the picked version is cached, so a failed fetch, a 404
  // included, leaves the displayed version, and this state, where they were:
  // Perrin Upcott, 2026-10-06 (ISS-12080 ruling 2, and "Keep current version").
  // No shipped copy fits that failure, so it is silent. Only the latest pick may
  // switch, so a slow earlier fetch cannot land after it.
  const handleVersionChange = (version: number) => {
    lastPickedVersionRef.current = version;
    if (version === currentVersion) {
      return;
    }
    ensureDocumentBySlug(slug, version).then(
      () => {
        if (lastPickedVersionRef.current === version) {
          setSelectedVersion(version);
        }
      },
      () => undefined
    );
  };

  return (
    <Editor
      currentVersion={currentVersion}
      document={document}
      onVersionChange={handleVersionChange}
    />
  );
}
