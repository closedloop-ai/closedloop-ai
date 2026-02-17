"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useState } from "react";
import { useArtifactBySlug } from "@/hooks/queries/use-artifacts";
import { PlanEditor } from "./plan-editor";

type PlanEditorContainerProps = {
  slug: string;
  version?: number;
};

export function PlanEditorContainer({
  slug,
  version: initialVersion,
}: PlanEditorContainerProps) {
  // Manage selected version in client state (avoids page remounts on version switch)
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(
    initialVersion
  );

  // Fetch the artifact by slug with optional version
  const {
    data: plan,
    isLoading,
    error,
  } = useArtifactBySlug(slug, selectedVersion, {
    // When the selected version changes, keep displaying the previous version's data
    // until the new version is loaded (instead of a loading state).
    placeholderData: keepPreviousData,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !plan) {
    notFound();
  }

  const latestVersion = plan.latestVersion;
  const currentVersion = plan.version.version;

  const handleVersionChange = (version: number) => {
    // If selecting the latest version, clear the selection to use default (latest)
    if (version === latestVersion) {
      setSelectedVersion(undefined);
    } else {
      setSelectedVersion(version);
    }
  };

  return (
    <PlanEditor
      currentVersion={currentVersion}
      latestVersion={latestVersion}
      onVersionChange={handleVersionChange}
      plan={plan}
    />
  );
}
