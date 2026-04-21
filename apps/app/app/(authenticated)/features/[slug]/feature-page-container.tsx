"use client";

import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useDocumentBySlug } from "@/hooks/queries/use-documents";
import { FeaturePage } from "./feature-page";

type FeaturePageContainerProps = {
  slug: string;
};

export function FeaturePageContainer({
  slug,
}: Readonly<FeaturePageContainerProps>) {
  const { data: feature, isLoading, error } = useDocumentBySlug(slug);

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

  return <FeaturePage feature={feature} />;
}
