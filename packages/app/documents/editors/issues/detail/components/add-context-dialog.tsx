"use client";

import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { SelectDocumentDialog } from "@repo/app/documents/editors/issues/detail/components/select-document-dialog";
import { useCreateArtifactLink } from "@repo/app/documents/hooks/use-artifact-links";
import { attachmentKeys } from "@repo/app/documents/hooks/use-attachments";
import { useCreateContextAttachment } from "@repo/app/documents/hooks/use-context-attachments";
import { uploadToS3 } from "@repo/app/shared/lib/s3-upload";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
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
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  FileIcon,
  FileTextIcon,
  Loader2Icon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="link">Link Existing</TabsTrigger>
            <TabsTrigger value="upload">Upload File</TabsTrigger>
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
  const [prdSelectOpen, setPrdSelectOpen] = useState(false);
  const [docSelectOpen, setDocSelectOpen] = useState(false);
  const createArtifactLink = useCreateArtifactLink();

  const linkAsContext = (sourceId: string, linkType: LinkType) => {
    createArtifactLink.mutate(
      { sourceId, targetId: featureId, linkType },
      {
        onSuccess: () => {
          setPrdSelectOpen(false);
          setDocSelectOpen(false);
          onOpenChange(false);
        },
      }
    );
  };

  return (
    <div className="space-y-3 py-2">
      <p className="text-muted-foreground text-sm">
        Link an existing document to provide context for this feature.
      </p>
      {projectId ? (
        <Button
          className="w-full"
          onClick={() => setPrdSelectOpen(true)}
          variant="outline"
        >
          <FileIcon className="h-4 w-4" />
          Browse PRDs
        </Button>
      ) : (
        <Alert variant="warning">
          <AlertCircleIcon />
          <AlertDescription>
            This feature is not associated with a project. Assign a project to
            link existing PRDs as context.
          </AlertDescription>
        </Alert>
      )}
      <Button
        className="w-full"
        onClick={() => setDocSelectOpen(true)}
        variant="outline"
      >
        <FileTextIcon className="h-4 w-4" />
        Browse Documents
      </Button>
      {projectId && (
        <SelectDocumentDialog
          description="Choose a PRD to link as context for this feature."
          documentType={DocumentType.Prd}
          emptyText="No PRDs found."
          excludeIds={excludeArtifactIds}
          icon={FileIcon}
          onOpenChange={(value) => {
            setPrdSelectOpen(value);
            if (!value) {
              onOpenChange(open);
            }
          }}
          onSelect={(prd) => linkAsContext(prd.id, LinkType.Produces)}
          open={prdSelectOpen}
          projectId={projectId}
          searchPlaceholder="Search PRDs..."
          title="Select PRD"
        />
      )}
      <SelectDocumentDialog
        description="Choose an evergreen Document to reference as long-term context for this feature."
        documentType={DocumentType.Doc}
        emptyText="No Documents found."
        excludeIds={excludeArtifactIds}
        icon={FileTextIcon}
        onOpenChange={(value) => {
          setDocSelectOpen(value);
          if (!value) {
            onOpenChange(open);
          }
        }}
        onSelect={(doc) => linkAsContext(doc.id, LinkType.RelatesTo)}
        open={docSelectOpen}
        orgWide
        projectId={projectId}
        searchPlaceholder="Search Documents..."
        title="Select Document"
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

      try {
        await uploadToS3(response.uploadUrl, selectedFile, selectedFile.type);
      } catch (s3Error) {
        setUploadError(
          s3Error instanceof Error ? s3Error.message : "Failed to upload file"
        );
        return;
      }

      queryClient.invalidateQueries({
        queryKey: attachmentKeys.list(featureId),
      });
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
        <Alert variant="error">
          <AlertCircleIcon />
          <AlertDescription>{uploadError}</AlertDescription>
        </Alert>
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
