"use client";

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
}: PRDEditorContainerProps) {
  // Manage selected version in client state (avoids page remounts on version switch)
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(
    initialVersion
  );

  // Fetch the artifact by slug with optional version
  const {
    data: prd,
    isLoading,
    error,
  } = useArtifactBySlug(slug, selectedVersion);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !prd) {
    notFound();
  }

  const latestVersion = prd.latestVersion;
  const currentVersion = prd.version.version;

  const handleVersionChange = (version: number) => {
    // If selecting the latest version, clear the selection to use default (latest)
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
