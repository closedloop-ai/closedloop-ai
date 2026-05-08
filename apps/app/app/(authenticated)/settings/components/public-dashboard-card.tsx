"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  CopyIcon,
  GlobeIcon,
  Loader2Icon,
  RefreshCwIcon,
  TrashIcon,
} from "lucide-react";
import {
  useGeneratePublicDashboardToken,
  usePublicDashboardToken,
  useRevokePublicDashboardToken,
} from "@/hooks/queries/use-public-dashboard-token";

export function PublicDashboardCard() {
  const { data, isLoading } = usePublicDashboardToken();
  const generate = useGeneratePublicDashboardToken();
  const revoke = useRevokePublicDashboardToken();

  const handleCopy = async () => {
    if (data?.url) {
      try {
        await navigator.clipboard.writeText(data.url);
        toast.success("URL copied to clipboard");
      } catch {
        toast.error("Failed to copy URL");
      }
    }
  };

  const handleGenerate = async () => {
    const isRegenerate = !!data?.token;
    try {
      await generate.mutateAsync();
      toast.success(
        isRegenerate ? "Dashboard URL regenerated" : "Dashboard URL created"
      );
    } catch {
      toast.error("Failed to generate dashboard URL");
    }
  };

  const handleRevoke = async () => {
    try {
      await revoke.mutateAsync();
      toast.success("Dashboard URL revoked");
    } catch {
      toast.error("Failed to revoke dashboard URL");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GlobeIcon className="h-5 w-5" />
          Public Dashboard
        </CardTitle>
        <CardDescription>
          Share a read-only dashboard link with external stakeholders. Anyone
          with this link can view aggregate statistics.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CardContentBody
          data={data}
          generate={generate}
          isLoading={isLoading}
          onCopy={handleCopy}
          onGenerate={handleGenerate}
          onRevoke={handleRevoke}
          revoke={revoke}
        />
      </CardContent>
    </Card>
  );
}

type CardContentBodyProps = {
  data: { token: string | null; url: string | null } | undefined;
  generate: ReturnType<typeof useGeneratePublicDashboardToken>;
  isLoading: boolean;
  onCopy: () => void;
  onGenerate: () => void;
  onRevoke: () => void;
  revoke: ReturnType<typeof useRevokePublicDashboardToken>;
};

function CardContentBody({
  data,
  generate,
  isLoading,
  onCopy,
  onGenerate,
  onRevoke,
  revoke,
}: CardContentBodyProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data?.url) {
    return (
      <>
        <div className="flex gap-2">
          <Input readOnly value={data.url} />
          <Button onClick={onCopy} size="icon" variant="outline">
            <CopyIcon className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={generate.isPending}
            onClick={onGenerate}
            size="sm"
            variant="outline"
          >
            {generate.isPending ? (
              <Loader2Icon className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCwIcon className="h-4 w-4" />
            )}
            Regenerate
          </Button>
          <Button
            disabled={revoke.isPending}
            onClick={onRevoke}
            size="sm"
            variant="destructive"
          >
            {revoke.isPending ? (
              <Loader2Icon className="h-4 w-4 animate-spin" />
            ) : (
              <TrashIcon className="h-4 w-4" />
            )}
            Revoke
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Regenerating creates a new URL and invalidates the old one. Revoking
          disables the public dashboard entirely.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="text-muted-foreground text-sm">
        No public dashboard URL has been created yet.
      </p>
      <Button disabled={generate.isPending} onClick={onGenerate}>
        {generate.isPending ? (
          <Loader2Icon className="h-4 w-4 animate-spin" />
        ) : (
          <GlobeIcon className="h-4 w-4" />
        )}
        Create Public Dashboard URL
      </Button>
    </>
  );
}
