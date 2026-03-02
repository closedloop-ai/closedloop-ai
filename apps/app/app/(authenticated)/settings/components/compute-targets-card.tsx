"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Laptop, Loader2, Trash2 } from "lucide-react";
import Link from "next/link";
import {
  useComputeTargets,
  useDeleteComputeTarget,
} from "@/hooks/queries/use-compute-targets";

const DESKTOP_SETUP_URL =
  "https://github.com/closedloop-tech/symphony-alpha/blob/main/docs/runbook-symphony-desktop-client-llm.md";

function formatLastSeen(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export function ComputeTargetsCard() {
  const { data: targets = [], isLoading } = useComputeTargets({
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const deleteTarget = useDeleteComputeTarget();

  const handleDelete = async (id: string, machineName: string) => {
    try {
      await deleteTarget.mutateAsync(id);
      toast.success(`Removed ${machineName}`);
    } catch {
      toast.error("Failed to remove compute target");
    }
  };

  let content: React.ReactNode;
  if (isLoading) {
    content = (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (targets.length === 0) {
    content = (
      <div className="space-y-3 rounded-lg border border-dashed p-4">
        <p className="text-sm">No compute targets registered yet.</p>
        <p className="text-muted-foreground text-sm">
          Install the Symphony Desktop client, then connect with an API key from{" "}
          <Link className="underline" href="/settings?tab=api-keys">
            Settings - API Keys
          </Link>
          .
        </p>
        <a
          className="inline-flex text-primary text-sm underline"
          href={DESKTOP_SETUP_URL}
          rel="noreferrer"
          target="_blank"
        >
          Open desktop setup instructions
        </a>
      </div>
    );
  } else {
    content = (
      <div className="space-y-3">
        {targets.map((target) => (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            key={target.id}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{target.machineName}</p>
                <Badge
                  className="capitalize"
                  variant={target.isOnline ? "default" : "secondary"}
                >
                  {target.isOnline ? "online" : "offline"}
                </Badge>
              </div>
              <p className="text-muted-foreground text-xs">
                {target.platform} - Last seen{" "}
                {formatLastSeen(target.lastSeenAt)}
              </p>
            </div>

            <Button
              disabled={deleteTarget.isPending}
              onClick={() => handleDelete(target.id, target.machineName)}
              size="sm"
              variant="outline"
            >
              {deleteTarget.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete
            </Button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Laptop className="h-5 w-5" />
          Compute Targets
        </CardTitle>
        <CardDescription>
          Manage desktop clients connected to your account for Engineer relay.
        </CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
