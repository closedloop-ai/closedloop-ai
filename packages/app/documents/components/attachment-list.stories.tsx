import type { FileAttachment } from "@repo/api/src/types/attachment";
import { AttachmentList } from "@repo/app/documents/components/attachment-list";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

const defaultAttachments: FileAttachment[] = [
  {
    id: "attachment-1",
    artifactId: "artifact-1",
    filename: "implementation-plan.md",
    mimeType: "text/markdown",
    sizeBytes: 42_000,
    createdAt: "2026-05-29T16:15:00.000Z",
    createdById: "user-1",
  },
  {
    id: "attachment-2",
    artifactId: "artifact-1",
    filename: "wireframe.png",
    mimeType: "image/png",
    sizeBytes: 218_000,
    createdAt: "2026-05-29T16:22:00.000Z",
    createdById: "user-1",
    previewUrl: "https://placehold.co/96x96/png",
  },
  {
    id: "attachment-3",
    artifactId: "artifact-1",
    filename: "metrics-export.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_650_000,
    createdAt: "2026-05-29T16:28:00.000Z",
    createdById: "user-2",
  },
];

function InteractiveAttachmentList({
  initialAttachments,
  actionVisibility = "always",
}: {
  initialAttachments: FileAttachment[];
  actionVisibility?: "hover" | "always";
}) {
  const [attachments, setAttachments] =
    useState<FileAttachment[]>(initialAttachments);
  const [downloadedIds, setDownloadedIds] = useState<string[]>([]);

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <AttachmentList
        actionVisibility={actionVisibility}
        attachments={attachments}
        emptyState={
          <div className="text-muted-foreground text-sm">
            No files are attached to this artifact yet.
          </div>
        }
        onDelete={(attachment) => {
          setAttachments((current) =>
            current.filter((candidate) => candidate.id !== attachment.id)
          );
        }}
        onDownload={(attachment) => {
          setDownloadedIds((current) => [...current, attachment.id]);
        }}
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">
          Downloads triggered: {downloadedIds.length}
        </span>
        <Button
          onClick={() => {
            setAttachments(initialAttachments);
            setDownloadedIds([]);
          }}
          size="sm"
          variant="outline"
        >
          Reset attachments
        </Button>
      </div>
    </div>
  );
}

const meta = {
  title: "App Core/Documents/Attachment List",
  component: AttachmentList,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    attachments: defaultAttachments,
  },
} satisfies Meta<typeof AttachmentList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  render: () => (
    <InteractiveAttachmentList initialAttachments={defaultAttachments} />
  ),
};

export const HoverActions: Story = {
  args: {
    actionVisibility: "hover",
    attachments: defaultAttachments,
    onDelete: fn(),
    onDownload: fn(),
  },
};

export const ReadOnly: Story = {
  args: {
    attachments: defaultAttachments,
  },
};

export const Empty: Story = {
  args: {
    attachments: [],
    emptyState: (
      <div className="text-muted-foreground text-sm">
        No files are attached to this artifact yet.
      </div>
    ),
  },
};
