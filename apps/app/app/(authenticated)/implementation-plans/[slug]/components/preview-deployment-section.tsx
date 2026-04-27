"use client";

import type { DeploymentArtifact } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import { cn } from "@repo/design-system/lib/utils";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { MetadataSection } from "@/components/document-editor/metadata-panel";
import {
  previewDeploymentStateColors,
  StatusBadge,
} from "@/components/status-badge";

export type PreviewDeploymentSectionProps = {
  previewDeployment: DeploymentArtifact;
  onRefresh: () => void;
  isRefreshing: boolean;
};

export function PreviewDeploymentSection({
  previewDeployment,
  onRefresh,
  isRefreshing,
}: PreviewDeploymentSectionProps) {
  const deploymentUrl =
    previewDeployment.externalUrl ??
    previewDeployment.deployment.githubDeploymentUrl;
  const environment = previewDeployment.deployment.environment;
  const state = previewDeployment.status;

  return (
    <MetadataSection separator>
      <div className="flex items-center justify-between">
        <Label className="text-muted-foreground text-xs">Preview</Label>
        <Button
          aria-label="Refresh preview deployment status"
          disabled={isRefreshing}
          onClick={onRefresh}
          size="icon"
          variant="ghost"
        >
          <RefreshCwIcon
            className={cn("h-3 w-3", isRefreshing && "animate-spin")}
          />
        </Button>
      </div>
      <div className="space-y-2">
        {deploymentUrl ? (
          <a
            className="flex items-center gap-1 text-primary text-sm hover:underline"
            href={deploymentUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open Preview
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        ) : (
          <p className="text-muted-foreground text-xs">
            Preview link not available yet.
          </p>
        )}
        <div className="text-muted-foreground text-xs">
          <span className="mr-2">
            {environment
              ? `Environment: ${environment}`
              : "Environment: preview"}
          </span>
          {state ? (
            <StatusBadge
              className="px-1.5 py-0 text-xs uppercase"
              colorMap={previewDeploymentStateColors}
              defaultStyle="bg-muted text-muted-foreground border-muted"
              status={state.toUpperCase()}
            />
          ) : null}
        </div>
      </div>
    </MetadataSection>
  );
}
