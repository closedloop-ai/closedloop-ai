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

/**
 * A wrapping row of small file chips for anything attached to an artifact:
 * an image shows as a thumbnail you can click to open full-size, while other
 * files, like PDFs or text documents, show a file icon and a clickable
 * filename that downloads them. Use it anywhere you need to show a handful
 * of attached files inline rather than in a separate list or table. Download
 * and delete buttons are hidden until you hover a chip by default, though a
 * surface built for touch can keep them visible all the time.
 */
const meta = {
  title: "Composites/Documents/Attachment List",
  component: AttachmentList,
  tags: ["autodocs"],
  argTypes: {
    attachments: { control: "object" },
    actionVisibility: {
      control: { type: "radio" },
      options: ["hover", "always"],
    },
    emptyState: { control: false },
    onDelete: { control: false, table: { category: "Events" } },
    onDownload: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    attachments: defaultAttachments,
    actionVisibility: "hover",
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
