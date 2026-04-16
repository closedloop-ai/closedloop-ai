"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import { AlertCircleIcon, CheckCircleIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { useImportGoogleDocs } from "@/hooks/queries/use-google-integration";
import { useProjects } from "@/hooks/queries/use-projects";

type GoogleImportModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const FOLDER_ID_REGEX = /^[a-zA-Z0-9_-]{28,40}$/;

export function GoogleImportModal({
  open,
  onOpenChange,
}: GoogleImportModalProps) {
  const [folderId, setFolderId] = useState<string>("");
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [folderIdError, setFolderIdError] = useState<string>("");

  const importMutation = useImportGoogleDocs();
  const { data: projects, isLoading: projectsLoading } = useProjects();

  // Reset form when modal closes
  useEffect(() => {
    if (!open) {
      setFolderId("");
      setProjectId(undefined);
      setFolderIdError("");
    }
  }, [open]);

  // Validate folder ID on change
  const handleFolderIdChange = (value: string) => {
    setFolderId(value);
    if (value && !FOLDER_ID_REGEX.test(value)) {
      setFolderIdError("Invalid folder ID format");
    } else {
      setFolderIdError("");
    }
  };

  const handleImport = async () => {
    // Validate inputs
    if (!folderId) {
      setFolderIdError("Folder ID is required");
      return;
    }
    if (!FOLDER_ID_REGEX.test(folderId)) {
      setFolderIdError("Invalid folder ID format");
      return;
    }
    if (!projectId) {
      toast.error("Please select a target project");
      return;
    }

    try {
      const result = await importMutation.mutateAsync({
        folderId,
        projectId,
      });

      // Show success message
      if (result.importedCount === 0) {
        toast.warning("No Google Docs found in this folder");
      } else {
        toast.success(
          `Successfully imported ${result.importedCount} document${
            result.importedCount === 1 ? "" : "s"
          }`
        );
      }

      // Show failures if any
      if (result.failures.length > 0) {
        toast.error(
          `Failed to import ${result.failures.length} document${
            result.failures.length === 1 ? "" : "s"
          }`
        );
      }

      // Close modal on success
      if (result.importedCount > 0) {
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to import Google Docs"
      );
    }
  };

  const isValid =
    folderId && FOLDER_ID_REGEX.test(folderId) && projectId && !folderIdError;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Import from Google Drive</DialogTitle>
          <DialogDescription>
            Import Google Docs from a folder as PRD artifacts (max 100 documents
            per import).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Folder ID input */}
          <div className="space-y-2">
            <Label htmlFor="folder-id">
              Google Drive Folder ID
              <span className="text-destructive"> *</span>
            </Label>
            <Input
              id="folder-id"
              onChange={(e) => handleFolderIdChange(e.target.value)}
              placeholder="1A2B3C4D5E..."
              value={folderId}
            />
            {folderIdError ? (
              <p className="text-destructive text-sm">{folderIdError}</p>
            ) : (
              <p className="text-muted-foreground text-sm">
                Find this in the folder URL:{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  https://drive.google.com/drive/folders/[FOLDER_ID]
                </code>
              </p>
            )}
          </div>

          {/* Project selection */}
          <div className="space-y-2">
            <Label htmlFor="project">
              Target Project
              <span className="text-destructive"> *</span>
            </Label>
            {projectsLoading && (
              <div className="flex items-center gap-2 rounded-md border border-input-border bg-background px-3 py-2">
                <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground text-sm">
                  Loading projects...
                </span>
              </div>
            )}
            {!projectsLoading && projects && projects.length > 0 && (
              <Select onValueChange={setProjectId} value={projectId}>
                <SelectTrigger id="project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!projectsLoading && (!projects || projects.length === 0) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
                <p className="text-amber-900 text-sm dark:text-amber-200">
                  No projects found. Create a project first to import documents.
                </p>
              </div>
            )}
            <p className="text-muted-foreground text-sm">
              Imported documents will be created as PRD artifacts in this
              project.
            </p>
          </div>

          {/* Import result preview (shown after import) */}
          {importMutation.isSuccess && importMutation.data && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3">
              <div className="flex items-center gap-2">
                <CheckCircleIcon className="h-4 w-4 text-green-600" />
                <p className="font-medium text-sm">
                  Imported {importMutation.data.importedCount} document
                  {importMutation.data.importedCount === 1 ? "" : "s"}
                </p>
              </div>
              {importMutation.data.artifacts.length > 0 && (
                <ul className="ml-6 space-y-1 text-sm">
                  {importMutation.data.artifacts.map(
                    (doc: { id: string; slug: string; title: string }) => (
                      <li className="text-muted-foreground" key={doc.id}>
                        {doc.title}
                      </li>
                    )
                  )}
                </ul>
              )}
              {importMutation.data.failures.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="font-medium text-destructive text-sm">
                    Failed to import {importMutation.data.failures.length}{" "}
                    document
                    {importMutation.data.failures.length === 1 ? "" : "s"}:
                  </p>
                  <ul className="ml-6 space-y-1 text-sm">
                    {importMutation.data.failures.map((failure) => (
                      <li className="text-muted-foreground" key={failure.docId}>
                        {failure.docTitle}: {failure.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            disabled={importMutation.isPending}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={!isValid || importMutation.isPending}
            onClick={handleImport}
          >
            {importMutation.isPending ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                Importing...
              </>
            ) : (
              "Import"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
