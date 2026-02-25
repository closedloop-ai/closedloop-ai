"use client";

import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useIssueBySlug } from "@/hooks/queries/use-issues";
import { FeaturePage } from "./feature-page";

type FeaturePageContainerProps = {
  slug: string;
};

export function FeaturePageContainer({ slug }: FeaturePageContainerProps) {
  const { data: issue, isLoading, error } = useIssueBySlug(slug);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !issue) {
    notFound();
  }

  return <FeaturePage issue={issue} />;
}
