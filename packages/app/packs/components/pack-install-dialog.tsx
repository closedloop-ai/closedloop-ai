"use client";

import type { Pack, PackInstallRun } from "@repo/app/agents/lib/session-types";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import { CodeBlock } from "@repo/design-system/components/ui/primitives/code-block";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";

type PackInstallDialogProps = {
  open: boolean;
  pack: Pack;
  run: PackInstallRun;
  onOpenChange?: (open: boolean) => void;
  onSelectProject?: (project: string) => void;
  onClose?: () => void;
  onRunCommand?: () => void;
  onCopyCommand?: () => void;
};

export function PackInstallDialog({
  open,
  pack,
  run,
  onOpenChange,
  onSelectProject,
  onClose,
  onRunCommand,
  onCopyCommand,
}: PackInstallDialogProps) {
  const isComplete = run.state === "complete";
  const projectAwareCommand =
    run.projectScoped && run.selectedProject
      ? `cd '${run.selectedProject.replace(/'/g, "'\\''")}' && ${run.command}`
      : run.command;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {run.action === "install" ? "Install" : "Uninstall"}{" "}
            {pack.displayName}
          </DialogTitle>
          <DialogDescription>
            harness: {run.harness}
            {run.commandIsAutoDetect ? " · auto-detect enabled" : ""}
            {isComplete && typeof run.exitCode === "number"
              ? ` · exit ${run.exitCode}${run.reason ? ` (${run.reason})` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {run.projectScoped && run.projectOptions?.length ? (
            <div className="space-y-2">
              <Label htmlFor="pack-project">Project</Label>
              <Select
                onValueChange={(value) => onSelectProject?.(value)}
                value={run.selectedProject ?? ""}
              >
                <SelectTrigger id="pack-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {run.projectOptions.map((project) => (
                    <SelectItem key={project} value={project}>
                      {project}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="font-medium text-sm">Command preview</div>
            <CodeBlock>{projectAwareCommand}</CodeBlock>
          </div>

          {run.lines?.length ? (
            <div className="space-y-2">
              <div className="font-medium text-sm">Run output</div>
              <CodeBlock>{run.lines.join("\n")}</CodeBlock>
            </div>
          ) : null}

          {run.postInstall ? (
            <div className="rounded-xl border border-border bg-muted/35 p-4">
              <div className="font-medium text-sm">{run.postInstall.title}</div>
              <p className="mt-2 text-muted-foreground text-sm">
                {run.postInstall.body}
              </p>
              {run.postInstall.copyCommand ? (
                <div className="mt-3">
                  <CodeBlock>{run.postInstall.copyCommand}</CodeBlock>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button disabled={!onClose} onClick={onClose} variant="outline">
            Close
          </Button>
          <Button
            disabled={run.projectScoped ? !onCopyCommand : !onRunCommand}
            onClick={run.projectScoped ? onCopyCommand : onRunCommand}
          >
            {run.projectScoped ? "Copy command" : "Run command"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
