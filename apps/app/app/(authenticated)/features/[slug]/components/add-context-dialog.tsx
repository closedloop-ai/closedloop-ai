"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import {
  AlertCircleIcon,
  FileTextIcon,
  Loader2Icon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { attachmentKeys } from "@/hooks/queries/use-attachments";
import {
  useCreateContextAttachment,
  useImportGDriveContext,
} from "@/hooks/queries/use-context-attachments";
import { useCreateEntityLink } from "@/hooks/queries/use-entity-links";
import {
  GDRIVE_FOLDER_ID_REGEX,
  useGDriveFolderFiles,
  useGoogleIntegrationStatus,
} from "@/hooks/queries/use-google-integration";
import { useQueryClient } from "@tanstack/react-query";
import { uploadToS3 } from "@/lib/s3-upload";
import { SelectArtifactDialog } from "./select-artifact-dialog";

const DEBOUNCE_MS = 300;

const ACCEPTED_FILE_TYPES =
  ".pdf,.jpg,.jpeg,.png,.gif,.webp,.json,.txt,.md,.doc,.docx,.xls,.xlsx,.mp4,.webm,.mov";

type AddContextDialogProps = {
  featureId: string;
  projectId: string | undefined;
  excludeArtifactIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AddContextDialog({
  featureId,
  projectId,
  excludeArtifactIds,
  open,
  onOpenChange,
}: Readonly<AddContextDialogProps>) {
  const [activeTab, setActiveTab] = useState("link");

  // Reset tab on close
  useEffect(() => {
    if (!open) {
      setActiveTab("link");
    }
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Context</DialogTitle>
        </DialogHeader>
        <Tabs onValueChange={setActiveTab} value={activeTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="link">Link Existing</TabsTrigger>
            <TabsTrigger value="upload">Upload File</TabsTrigger>
            <TabsTrigger value="gdrive">Import Google Docs</TabsTrigger>
          </TabsList>
          <TabsContent value="link">
            <LinkExistingTab
              excludeArtifactIds={excludeArtifactIds}
              featureId={featureId}
              onOpenChange={onOpenChange}
              open={open && activeTab === "link"}
              projectId={projectId}
            />
          </TabsContent>
          <TabsContent value="upload">
            <UploadFileTab
              featureId={featureId}
              onOpenChange={onOpenChange}
              projectId={projectId}
            />
          </TabsContent>
          <TabsContent value="gdrive">
            <ImportGoogleDocsTab
              featureId={featureId}
              onOpenChange={onOpenChange}
              projectId={projectId}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ─── Tab: Link Existing ────────────────────────────────────────────────────────

type LinkExistingTabProps = {
  featureId: string;
  projectId: string | undefined;
  excludeArtifactIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function LinkExistingTab({
  featureId,
  projectId,
  excludeArtifactIds,
  open,
  onOpenChange,
}: Readonly<LinkExistingTabProps>) {
  const [selectOpen, setSelectOpen] = useState(false);
  const createEntityLink = useCreateEntityLink();

  if (!projectId) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
        <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
        <p className="text-amber-900 text-sm dark:text-amber-200">
          This feature is not associated with a project. Assign a project to
          link existing PRDs as context.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 py-2">
      <p className="text-muted-foreground text-sm">
        Link an existing PRD to provide context for this feature.
      </p>
      <Button
        className="w-full"
        onClick={() => setSelectOpen(true)}
        variant="outline"
      >
        <FileTextIcon className="h-4 w-4" />
        Browse PRDs
      </Button>
      <SelectArtifactDialog
        artifactType={ArtifactType.Prd}
        description="Choose a PRD to link as context for this feature."
        emptyText="No PRDs found."
        excludeIds={excludeArtifactIds}
        icon={FileTextIcon}
        onOpenChange={(value) => {
          setSelectOpen(value);
          if (!value) {
            onOpenChange(open);
          }
        }}
        onSelect={(prd) => {
          createEntityLink.mutate(
            {
              sourceId: prd.id,
              sourceType: EntityType.Artifact,
              targetId: featureId,
              targetType: EntityType.Feature,
              linkType: LinkType.RelatesTo,
            },
            {
              onSuccess: () => {
                setSelectOpen(false);
                onOpenChange(false);
              },
            }
          );
        }}
        open={selectOpen}
        projectId={projectId}
        searchPlaceholder="Search PRDs..."
        title="Select PRD"
      />
    </div>
  );
}

// ─── Tab: Upload File ──────────────────────────────────────────────────────────

type UploadFileTabProps = {
  featureId: string;
  projectId: string | undefined;
  onOpenChange: (open: boolean) => void;
};

function UploadFileTab({
  featureId,
  projectId,
  onOpenChange,
}: Readonly<UploadFileTabProps>) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const createAttachment = useCreateContextAttachment(featureId);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setUploadError("");
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      return;
    }
    setUploadError("");

    try {
      const response = await createAttachment.mutateAsync({
        filename: selectedFile.name,
        mimeType: selectedFile.type,
        sizeBytes: selectedFile.size,
        projectId,
      });

      // TODO: If S3 upload fails, the artifact + attachment records remain orphaned in the DB.
      // Consider storing response.uploadUrl and response.attachmentId in state so a retry
      // reuses the same records instead of creating new ones via createAttachment.mutateAsync.
      try {
        await uploadToS3(response.uploadUrl, selectedFile, selectedFile.type);
      } catch (s3Error) {
        setUploadError(
          s3Error instanceof Error ? s3Error.message : "Failed to upload file"
        );
        return;
      }

      queryClient.invalidateQueries({ queryKey: attachmentKeys.issueList(featureId) });
      toast.success("File uploaded as context");
      onOpenChange(false);
    } catch {
      // createAttachment mutation errors are handled by the global QueryClient error handler
    }
  };

  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label htmlFor="context-file">File</Label>
        <Input
          accept={ACCEPTED_FILE_TYPES}
          id="context-file"
          onChange={handleFileChange}
          ref={fileInputRef}
          type="file"
        />
        <p className="text-muted-foreground text-sm">
          Supported: PDF, images, documents, spreadsheets, video
        </p>
      </div>
      {uploadError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
          <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
          <p className="text-destructive text-sm">{uploadError}</p>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={() => onOpenChange(false)} variant="outline">
          Cancel
        </Button>
        <Button
          disabled={!selectedFile || createAttachment.isPending}
          onClick={handleUpload}
        >
          {createAttachment.isPending ? (
            <>
              <Loader2Icon className="h-4 w-4 animate-spin" />
              Uploading...
            </>
          ) : (
            <>
              <UploadIcon className="h-4 w-4" />
              Upload
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ─── Tab: Import Google Docs ───────────────────────────────────────────────────

type ImportGoogleDocsTabProps = {
  featureId: string;
  projectId: string | undefined;
  onOpenChange: (open: boolean) => void;
};

function ImportGoogleDocsTab({
  featureId,
  projectId,
  onOpenChange,
}: Readonly<ImportGoogleDocsTabProps>) {
  const [folderId, setFolderId] = useState("");
  const [debouncedFolderId, setDebouncedFolderId] = useState("");
  const [folderIdError, setFolderIdError] = useState("");
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [importFailures, setImportFailures] = useState<
    Array<{ docId: string; error: string }>
  >([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any pending debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const { data: status } = useGoogleIntegrationStatus();
  const {
    data: folderFiles = [],
    isLoading: filesLoading,
    isError: filesError,
    error: filesQueryError,
  } = useGDriveFolderFiles(debouncedFolderId);
  const importMutation = useImportGDriveContext(featureId);

  const handleFolderIdChange = (value: string) => {
    setFolderId(value);
    setSelectedDocIds(new Set());

    if (value && !GDRIVE_FOLDER_ID_REGEX.test(value)) {
      setFolderIdError("Invalid folder ID format (28–40 alphanumeric chars)");
    } else {
      setFolderIdError("");
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedFolderId(value);
    }, DEBOUNCE_MS);
  };

  const toggleDoc = (docId: string) => {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (selectedDocIds.size === 0 || !projectId) {
      return;
    }

    setImportFailures([]);

    try {
      const result = await importMutation.mutateAsync({
        docIds: Array.from(selectedDocIds),
        projectId,
      });

      const failures = result.results.filter((r) => r.error != null);
      const successes = result.results.filter((r) => r.error == null);

      if (failures.length > 0) {
        setImportFailures(
          failures.map((f) => ({
            docId: f.docId,
            error: f.error ?? "Unknown error",
          }))
        );
      }

      if (successes.length > 0) {
        toast.success(
          `${successes.length} Google Doc${successes.length === 1 ? "" : "s"} imported as context`
        );
        if (failures.length === 0) {
          onOpenChange(false);
        }
      }
    } catch {
      // importMutation errors are handled by the global QueryClient error handler
    }
  };

  if (!status?.connected) {
    return (
      <div className="space-y-3 py-2">
        <p className="text-muted-foreground text-sm">
          Connect your Google account to import documents as context.
        </p>
        <Button asChild className="w-full" variant="outline">
          <a href="/settings?tab=integrations">Connect Google Drive</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label htmlFor="gdrive-folder-id">Google Drive Folder ID</Label>
        <Input
          id="gdrive-folder-id"
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
              drive.google.com/drive/folders/[FOLDER_ID]
            </code>
          </p>
        )}
      </div>

      {!projectId && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
          <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
          <p className="text-amber-900 text-sm dark:text-amber-200">
            This feature is not associated with a project. Assign a project to
            import documents.
          </p>
        </div>
      )}

      {GDRIVE_FOLDER_ID_REGEX.test(debouncedFolderId) && (
        <div className="space-y-2">
          <Label>Documents</Label>
          {filesLoading && (
            <div className="flex items-center gap-2 py-2">
              <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground text-sm">
                Loading files...
              </span>
            </div>
          )}
          {!filesLoading && filesError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
              <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <p className="text-destructive text-sm">
                {filesQueryError instanceof Error
                  ? filesQueryError.message
                  : "Failed to load files from this folder."}
              </p>
            </div>
          )}
          {!(filesLoading || filesError) && folderFiles.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No documents found in this folder.
            </p>
          )}
          {!filesLoading && folderFiles.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-md border border-border">
              {folderFiles.map((file) => (
                <label
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/50"
                  key={file.id}
                >
                  <input
                    checked={selectedDocIds.has(file.id)}
                    className="h-4 w-4"
                    onChange={() => toggleDoc(file.id)}
                    type="checkbox"
                  />
                  <span className="truncate text-sm">{file.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {importFailures.length > 0 && (
        <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-3">
          <p className="font-medium text-destructive text-sm">
            Failed to import {importFailures.length} document
            {importFailures.length === 1 ? "" : "s"}:
          </p>
          <ul className="ml-4 space-y-1 text-sm">
            {importFailures.map((failure) => (
              <li className="text-destructive/80" key={failure.docId}>
                {failure.docId}: {failure.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={() => onOpenChange(false)} variant="outline">
          Cancel
        </Button>
        <Button
          disabled={
            selectedDocIds.size === 0 || !projectId || importMutation.isPending
          }
          onClick={handleImport}
        >
          {importMutation.isPending ? (
            <>
              <Loader2Icon className="h-4 w-4 animate-spin" />
              Importing...
            </>
          ) : (
            "Import Selected"
          )}
        </Button>
      </div>
    </div>
  );
}
