import {
  DOCUMENT_STATUS_OPTIONS,
  type DocumentStatus,
} from "@repo/api/src/types/document";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { DocumentStatusIcon } from "./document-status-icon";

/** The ISS-9560 gate, ON, through the real provider seam the app uses. */
const withStatusLabelHonesty: Decorator = (Story) => (
  <FeatureFlagAdapterProvider
    adapter={createStaticFeatureFlagAdapter({
      enabledFlags: [ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY],
    })}
  >
    <Story />
  </FeatureFlagAdapterProvider>
);

/**
 * One glyph per Document lifecycle status (PRD/Implementation Plan/Template).
 * Documents progress through a filling ring, terminating in a filled ✕ for
 * Obsolete. Features use the separate `IssueStatusIcon`.
 */
const meta = {
  title: "Composites v1.0/Documents/Document Status Icon",
  component: DocumentStatusIcon,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    status: { control: "select", options: DOCUMENT_STATUS_OPTIONS },
    size: { control: "select", options: [16, 20] },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof DocumentStatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: DOCUMENT_STATUS_OPTIONS[0] },
};

/**
 * A status this build does not recognize — reachable, because `Artifact.status`
 * is a freeform column carrying two disjoint vocabularies and branch and session
 * rows enter shared tables with a status in neither.
 *
 * The MARK is the `blank-ring` this vocabulary never claims (ISS-9557), so it is
 * not mistakable for Draft's empty ring. The NAME is "Unknown" plus the sentence
 * saying the app cannot read the value — it used to be the literal word
 * "Status", which names the field and says nothing about it (ISS-9560).
 */
export const UnknownStatus: Story = {
  args: { status: "BRANCH_MERGED" as DocumentStatus },
  decorators: [withStatusLabelHonesty],
};

/** Every Document status at the default size. */
export const AllStatuses: Story = {
  tags: ["!manifest"],
  args: { status: DOCUMENT_STATUS_OPTIONS[0] },
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {DOCUMENT_STATUS_OPTIONS.map((status) => (
        <div
          key={status}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <DocumentStatusIcon status={status as DocumentStatus} />
          <span style={{ fontSize: 11 }}>
            {DOCUMENT_STATUS_LABELS[status as DocumentStatus]}
          </span>
        </div>
      ))}
    </div>
  ),
};
