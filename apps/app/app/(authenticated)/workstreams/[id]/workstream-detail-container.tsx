"use client";

import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useDocuments } from "@/hooks/queries/use-documents";
import { useWorkstream } from "@/hooks/queries/use-workstreams";
import { WorkstreamDetail } from "./workstream-detail";

type WorkstreamDetailContainerProps = {
  id: string;
};

export function WorkstreamDetailContainer({
  id,
}: WorkstreamDetailContainerProps) {
  const {
    data: workstream,
    isLoading: isLoadingWorkstream,
    error,
  } = useWorkstream(id);
  const { data: artifacts = [], isLoading: isLoadingArtifacts } = useDocuments({
    workstreamId: id,
  });

  const isLoading = isLoadingWorkstream || isLoadingArtifacts;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !workstream) {
    notFound();
  }

  return <WorkstreamDetail artifacts={artifacts} workstream={workstream} />;
}
