"use client";

import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useArtifact } from "@/hooks/queries/use-artifacts";
import { PRDEditor } from "./prd-editor";

type PRDEditorContainerProps = {
  id: string;
};

export function PRDEditorContainer({ id }: PRDEditorContainerProps) {
  const { data: prd, isLoading, error } = useArtifact(id);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !prd || prd.type !== "PRD") {
    notFound();
  }

  return <PRDEditor prd={prd} />;
}
