"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useState } from "react";
import { useDocumentBySlug } from "@/hooks/queries/use-documents";
import { FeaturePage } from "./feature-page";

type FeaturePageContainerProps = {
  slug: string;
  version?: number;
};

export function FeaturePageContainer({
  slug,
  version: initialVersion,
}: Readonly<FeaturePageContainerProps>) {
  // Manage selected version in client state (avoids page remounts on version switch)
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(
    initialVersion
  );

  const {
    data: feature,
    isLoading,
    error,
  } = useDocumentBySlug(slug, selectedVersion, {
    placeholderData: keepPreviousData,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !feature) {
    notFound();
  }

  const currentVersion = feature.version.version;

  const handleVersionChange = (version: number) => {
    if (version !== currentVersion) {
      setSelectedVersion(version);
    }
  };

  return (
    <FeaturePage
      currentVersion={currentVersion}
      feature={feature}
      onVersionChange={handleVersionChange}
    />
  );
}
