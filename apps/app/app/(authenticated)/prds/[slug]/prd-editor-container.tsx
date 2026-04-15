"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useState } from "react";
import { useArtifactBySlug } from "@/hooks/queries/use-artifacts";
import { PRDEditor } from "./prd-editor";

type PRDEditorContainerProps = {
  slug: string;
  version?: number;
};

export function PRDEditorContainer({
  slug,
  version: initialVersion,
}: Readonly<PRDEditorContainerProps>) {
  // Manage selected version in client state (avoids page remounts on version switch)
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(
    initialVersion
  );

  // Fetch the artifact by slug with optional version
  const {
    data: prd,
    isLoading,
    error,
  } = useArtifactBySlug(slug, selectedVersion, {
    // When the selected version changes, keep displaying the previous version's data
    // until the new version is loaded (instead of a loading state).
    placeholderData: keepPreviousData,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !prd) {
    notFound();
  }

  const currentVersion = prd.version.version;

  const handleVersionChange = (version: number) => {
    if (version !== currentVersion) {
      setSelectedVersion(version);
    }
  };

  return (
    <PRDEditor
      currentVersion={currentVersion}
      onVersionChange={handleVersionChange}
      prd={prd}
    />
  );
}
