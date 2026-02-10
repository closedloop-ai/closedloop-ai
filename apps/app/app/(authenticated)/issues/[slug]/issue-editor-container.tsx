"use client";

import { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { keepPreviousData } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useState } from "react";
import { useArtifacts } from "@/hooks/queries/use-artifacts";
import { IssueEditor } from "./issue-editor";

type IssueEditorContainerProps = {
  slug: string;
  version?: number;
};

export function IssueEditorContainer({
  slug,
  version: initialVersion,
}: IssueEditorContainerProps) {
  // Manage selected version in client state (avoids page remounts on version switch)
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(
    initialVersion
  );

  // Fetch the latest version to know the total version count
  const {
    data: latestIssues,
    isLoading: isLoadingLatest,
    error: latestError,
  } = useArtifacts({
    subtype: ArtifactSubtype.Issue,
    documentSlug: slug,
    latestOnly: true,
  });

  // Fetch the selected version (or latest if no version selected)
  const {
    data: versionIssues,
    isLoading: isLoadingVersion,
    error: versionError,
  } = useArtifacts(
    {
      subtype: ArtifactSubtype.Issue,
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

  if (error || !latestIssues?.length) {
    notFound();
  }

  // Use the versioned issue if viewing a specific version, otherwise use latest
  const issue =
    selectedVersion && versionIssues?.length
      ? versionIssues[0]
      : latestIssues[0];
  const latestVersion = latestIssues[0].version;
  const currentVersion = issue.version;

  const handleVersionChange = (version: number) => {
    // If selecting the latest version, clear the selection to use latestOnly query
    if (version === latestVersion) {
      setSelectedVersion(undefined);
    } else {
      setSelectedVersion(version);
    }
  };

  return (
    <IssueEditor
      currentVersion={currentVersion}
      issue={issue}
      latestVersion={latestVersion}
      onVersionChange={handleVersionChange}
    />
  );
}
