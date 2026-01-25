"use client";

import { Loader2Icon } from "lucide-react";
import { useProjects } from "@/hooks/queries/use-projects";

export function ProjectsList() {
  const { data: result, isLoading } = useProjects();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!result?.success) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {result?.error ?? "Failed to load projects"}
      </div>
    );
  }

  if (result.data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
        <h3 className="mb-2 font-semibold text-lg">No projects yet</h3>
        <p className="mb-4 text-muted-foreground text-sm">
          Create your first project to get started
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {result.data.map((project) => (
        <div className="rounded-lg border p-4" key={project.id}>
          <h3 className="font-medium">{project.name}</h3>
          {project.description ? (
            <p className="mt-1 text-muted-foreground text-sm">
              {project.description}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
