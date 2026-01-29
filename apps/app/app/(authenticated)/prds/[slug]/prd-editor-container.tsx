"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { keepPreviousData } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useState } from "react";
import { useArtifacts } from "@/hooks/queries/use-artifacts";
import { PRDEditor } from "./prd-editor";

type PRDEditorContainerProps = {
  slug: string;
  version?: number;
};

export function PRDEditorContainer({
  slug,
  version: initialVersion,
}: PRDEditorContainerProps) {
  // Manage selected version in client state (avoids page remounts on version switch)
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(
    initialVersion
  );

  // Fetch the latest version to know the total version count
  const {
    data: latestPrds,
    isLoading: isLoadingLatest,
    error: latestError,
  } = useArtifacts({
    type: ArtifactType.Prd,
    documentSlug: slug,
    latestOnly: true,
  });

  // Fetch the selected version (or latest if no version selected)
  const {
    data: versionPrds,
    isLoading: isLoadingVersion,
    error: versionError,
  } = useArtifacts(
    {
      type: ArtifactType.Prd,
      documentSlug: slug,
      ...(selectedVersion
        ? { version: selectedVersion }
        : { latestOnly: true }),
    },
    {
      // Only run this query if we have a specific version selected
      enabled: selectedVersion !== undefined,
      // Keep showing previous data while fetching new version (prevents flash)
      placeholderData: keepPreviousData,
    }
  );

  // Only show loading spinner on initial load, not when switching versions
  const isInitialLoading =
    isLoadingLatest || (selectedVersion !== undefined && isLoadingVersion);
  const error = latestError || versionError;

  if (isInitialLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !latestPrds?.length) {
    notFound();
  }

  // Use the versioned PRD if viewing a specific version, otherwise use latest
  const prd =
    selectedVersion && versionPrds?.length ? versionPrds[0] : latestPrds[0];
  const latestVersion = latestPrds[0].version;
  const currentVersion = prd.version;

  const handleVersionChange = (version: number) => {
    // If selecting the latest version, clear the selection to use latestOnly query
    if (version === latestVersion) {
      setSelectedVersion(undefined);
    } else {
      setSelectedVersion(version);
    }
  };

  return (
    <PRDEditor
      currentVersion={currentVersion}
      latestVersion={latestVersion}
      onVersionChange={handleVersionChange}
      prd={prd}
    />
  );
}
