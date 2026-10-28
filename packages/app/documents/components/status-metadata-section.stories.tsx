import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { StatusMetadataSection } from "./status-metadata-section";

const USERS: User[] = [
  { id: "user-1", name: "Marisol Ashgrove", email: "marisol@closedloop.ai" },
  { id: "user-2", name: "Annie Case", email: "annie@closedloop.ai" },
];

const meta = {
  title: "Composites v1.0/Documents/Status Metadata Section",
  component: StatusMetadataSection,
  tags: ["deprecated", "autodocs"],
  args: {
    artifactId: "document-1",
    assignee: USERS[0],
    documentType: DocumentType.Prd,
    onAssigneeChange: fn(),
    onStatusChange: fn(),
    status: DocumentStatus.Draft,
    teamMembers: USERS,
  },
} satisfies Meta<typeof StatusMetadataSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Current renderer retained byte-for-byte while the adoption gate is closed. */
export const Legacy: Story = {};

/** Canonical editor and labels after the universal adoption gate opens. */
export const UniversalArtifactStatus: Story = {
  parameters: {
    appCore: { enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY] },
  },
};
