"use client";

import { Loader2Icon } from "lucide-react";
import { useOrganizations } from "@/hooks/queries/use-organizations";

export function OrganizationList() {
  const { data: result, isLoading } = useOrganizations();

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
        {result?.error ?? "Failed to load organizations"}
      </div>
    );
  }

  if (result.data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
        <h3 className="mb-2 font-semibold text-lg">No organization found</h3>
        <p className="mb-4 text-muted-foreground text-sm">
          Set up your organization to get started
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {result.data.map((org) => (
        <div className="rounded-lg border p-4" key={org.id}>
          <h3 className="font-medium">{org.name}</h3>
          <p className="text-muted-foreground text-sm">Slug: {org.slug}</p>
        </div>
      ))}
    </div>
  );
}
