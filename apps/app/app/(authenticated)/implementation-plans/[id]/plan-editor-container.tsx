"use client";

import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { useArtifact } from "@/hooks/queries/use-artifacts";
import { PlanEditor } from "./plan-editor";

type PlanEditorContainerProps = {
  id: string;
};

export function PlanEditorContainer({ id }: PlanEditorContainerProps) {
  const { data: plan, isLoading, error } = useArtifact(id);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !plan || plan.type !== "IMPLEMENTATION_PLAN") {
    notFound();
  }

  return <PlanEditor plan={plan} />;
}
