"use client";

import {
  ArtifactStatus,
  type ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";
import type { PullRequestInfo } from "@/hooks/queries/use-artifacts";

type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  command: "plan" | "execute" | "chat" | null;
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string | null;
};
import { artifactStatusLabels } from "@/components/status-badge";

const PR_STATE_STYLES: Record<string, string> = {
  OPEN: "bg-green-100 text-green-700",
  MERGED: "bg-purple-100 text-purple-700",
  CLOSED: "bg-red-100 text-red-700",
};

type PlanMetadataPanelProps = {
  plan: ArtifactWithWorkstream;
  status: ArtifactStatus;
  approver: string;
  generationStatus: GenerationStatus | null;
  pullRequest: PullRequestInfo | null;
  onStatusChange: (status: ArtifactStatus) => void;
  onApproverChange: (approver: string) => void;
  onApproverBlur: () => void;
};

export function PlanMetadataPanel({
  plan,
  status,
  approver,
  generationStatus,
  pullRequest,
  onStatusChange,
  onApproverChange,
  onApproverBlur,
}: PlanMetadataPanelProps) {
  return (
    <div className="w-80 overflow-auto border-l bg-muted/30 p-4">
      <h3 className="mb-4 font-semibold">Plan Details</h3>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Status</Label>
          <Select
            onValueChange={(v) => onStatusChange(v as ArtifactStatus)}
            value={status}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(ArtifactStatus).map((statusOption) => (
                <SelectItem key={statusOption} value={statusOption}>
                  {artifactStatusLabels[statusOption] ?? statusOption}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Approver</Label>
          <Input
            onBlur={onApproverBlur}
            onChange={(e) => onApproverChange(e.target.value)}
            placeholder="Approver name"
            value={approver}
          />
        </div>

        <div className="border-t pt-4">
          <div className="space-y-1 text-muted-foreground text-sm">
            <p>Version: v{plan.version}</p>
            <p>
              Created:{" "}
              {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
              }).format(new Date(plan.createdAt))}
            </p>
            <p>
              Updated:{" "}
              {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
              }).format(new Date(plan.updatedAt))}
            </p>
          </div>
        </div>

        {/* GitHub Action Run Link */}
        {generationStatus?.htmlUrl ? (
          <div className="border-t pt-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs">
                Generation
              </Label>
              <a
                className="flex items-center gap-1 text-primary text-sm hover:underline"
                href={generationStatus.htmlUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                View GitHub Workflow
                <ExternalLinkIcon className="h-3 w-3" />
              </a>
            </div>
          </div>
        ) : null}

        {/* Pull Request Link */}
        {pullRequest ? (
          <div className="border-t pt-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs">
                Pull Request
              </Label>
              <a
                className="flex items-center gap-1 text-primary text-sm hover:underline"
                href={pullRequest.htmlUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <GitPullRequestIcon className="h-3 w-3" />#{pullRequest.number}:{" "}
                {pullRequest.title}
                <ExternalLinkIcon className="h-3 w-3" />
              </a>
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium text-xs ${PR_STATE_STYLES[pullRequest.state]}`}
                >
                  {pullRequest.state}
                </span>
                <span>
                  {pullRequest.headBranch} → {pullRequest.baseBranch}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
