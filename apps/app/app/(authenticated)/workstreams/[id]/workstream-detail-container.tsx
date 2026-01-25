"use client";

import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useArtifacts } from "@/hooks/queries/use-artifacts";
import { useWorkstream } from "@/hooks/queries/use-workstreams";
import { WorkstreamDetail } from "./workstream-detail";

type WorkstreamDetailContainerProps = {
  id: string;
};

export function WorkstreamDetailContainer({
  id,
}: WorkstreamDetailContainerProps) {
  const { data: workstreamResult, isLoading: isLoadingWorkstream } =
    useWorkstream(id);
  const { data: artifactsResult, isLoading: isLoadingArtifacts } = useArtifacts(
    id,
    undefined,
    true
  );

  const isLoading = isLoadingWorkstream || isLoadingArtifacts;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!workstreamResult?.success) {
    notFound();
  }

  const workstream = workstreamResult.data;
  const artifacts = artifactsResult?.success ? artifactsResult.data : [];

  return <WorkstreamDetail artifacts={artifacts} workstream={workstream} />;
}
