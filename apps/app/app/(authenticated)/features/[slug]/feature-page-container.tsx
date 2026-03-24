"use client";

import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useFeatureBySlug } from "@/hooks/queries/use-features";
import { FeaturePage } from "./feature-page";

type FeaturePageContainerProps = {
  slug: string;
};

export function FeaturePageContainer({ slug }: FeaturePageContainerProps) {
  const { data: feature, isLoading, error } = useFeatureBySlug(slug);

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
