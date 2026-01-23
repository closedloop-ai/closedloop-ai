"use client";

import type {
  LinearIntegrationStatus,
  LinearTeam,
} from "@repo/api/src/types/linear";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  CheckCircleIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  exportToLinear,
  getLinearIntegrationStatus,
} from "@/app/actions/linear";

type LinearExportDialogProps = {
  artifactId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function LinearExportDialog({
  artifactId,
  onOpenChange,
  open,
}: LinearExportDialogProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<LinearIntegrationStatus | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [exportResult, setExportResult] = useState<{
    issuesCreated: number;
    issues: Array<{ identifier: string; url: string; title: string }>;
  } | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    const result = await getLinearIntegrationStatus();
    if (result.success) {
      setStatus(result.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      loadStatus();
      setExportResult(null);
    }
  }, [open, loadStatus]);

  // Auto-select default team or first team
  useEffect(() => {
    if (status?.connected && status.teams && status.teams.length > 0) {
      if (status.defaultTeamId) {
        setSelectedTeamId(status.defaultTeamId);
      } else {
        setSelectedTeamId(status.teams[0].id);
      }
    }
  }, [status]);

  const handleExport = async () => {
    if (!selectedTeamId) {
      toast.error("Please select a Linear team");
      return;
    }

    setExporting(true);
    const result = await exportToLinear({
      artifactId,
      teamId: selectedTeamId,
    });

    if (result.success) {
      setExportResult({
        issuesCreated: result.data.issuesCreated,
        issues: result.data.issues,
      });
      toast.success(
        `Successfully exported ${result.data.issuesCreated} issue${result.data.issuesCreated === 1 ? "" : "s"} to Linear`
      );
      router.refresh();
    } else {
      toast.error(result.error || "Failed to export to Linear");
    }
    setExporting(false);
  };

  if (loading) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export to Linear</DialogTitle>
            <DialogDescription>
              Checking Linear integration status...
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center py-8">
            <Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!status?.connected) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export to Linear</DialogTitle>
            <DialogDescription>
              Connect Linear to export implementation plans as issues.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-muted-foreground text-sm">
              Linear is not connected. Go to Settings to connect your Linear
              account.
            </p>
          </div>
          <DialogFooter>
            <Button asChild variant="outline">
              <Link href="/settings">
                <SettingsIcon className="mr-2 h-4 w-4" />
                Go to Settings
              </Link>
            </Button>
            <Button onClick={() => onOpenChange(false)} variant="ghost">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (exportResult) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircleIcon className="h-5 w-5 text-green-600" />
              Successfully Exported to Linear
            </DialogTitle>
            <DialogDescription>
              {exportResult.issuesCreated} issue
              {exportResult.issuesCreated === 1 ? "" : "s"} created in Linear
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] space-y-2 overflow-auto py-4">
            {exportResult.issues.map((issue) => (
              <div
                className="flex items-center justify-between rounded-md border p-3"
                key={issue.identifier}
              >
                <div className="flex-1">
                  <p className="font-mono text-sm">{issue.identifier}</p>
                  <p className="text-muted-foreground text-sm">{issue.title}</p>
                </div>
                <Button asChild size="sm" variant="ghost">
                  <a href={issue.url} rel="noopener noreferrer" target="_blank">
                    View
                    <ExternalLinkIcon className="ml-2 h-3 w-3" />
                  </a>
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export to Linear</DialogTitle>
          <DialogDescription>
            Select a Linear team to export this implementation plan as issues.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <div className="mb-2 block font-medium text-sm">Linear Team</div>
            <Select onValueChange={setSelectedTeamId} value={selectedTeamId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a team" />
              </SelectTrigger>
              <SelectContent>
                {status.teams?.map((team: LinearTeam) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name} ({team.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {status.organizationName ? (
              <p className="mt-2 text-muted-foreground text-sm">
                Organization: {status.organizationName}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!selectedTeamId || exporting}
            onClick={handleExport}
          >
            {exporting ? (
              <>
                <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                Exporting...
              </>
            ) : (
              "Export to Linear"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
