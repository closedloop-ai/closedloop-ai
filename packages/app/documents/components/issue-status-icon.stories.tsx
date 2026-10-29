import {
  ISSUE_STATUS_OPTIONS,
  type IssueStatus,
} from "@repo/api/src/types/document";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ISSUE_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { IssueStatusIcon } from "./issue-status-icon";

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
 * One glyph per Issue delivery-lifecycle status. Issues follow a delivery
 * lifecycle (triage → backlog → todo → in progress → in review → done) distinct
 * from the Document authoring lifecycle. Documents use `DocumentStatusIcon`.
 */
const meta = {
  title: "Composites v1.0/Documents/Issue Status Icon",
  component: IssueStatusIcon,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    status: { control: "select", options: ISSUE_STATUS_OPTIONS },
    size: { control: "select", options: [16, 20] },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof IssueStatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: ISSUE_STATUS_OPTIONS[0] },
};

/**
 * A status this build does not recognize, for the reason and with the treatment
 * `DocumentStatusIcon`'s own Unknown story gives (ISS-9557 for the mark,
 * ISS-9560 for the name).
 */
export const UnknownStatus: Story = {
  args: { status: "BRANCH_MERGED" as IssueStatus },
  decorators: [withStatusLabelHonesty],
};

/** Every Issue status at the default size. */
export const AllStatuses: Story = {
  tags: ["!manifest"],
  args: { status: ISSUE_STATUS_OPTIONS[0] },
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {ISSUE_STATUS_OPTIONS.map((status) => (
        <div
          key={status}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <IssueStatusIcon status={status as IssueStatus} />
          <span style={{ fontSize: 11 }}>
            {ISSUE_STATUS_LABELS[status as IssueStatus]}
          </span>
        </div>
      ))}
    </div>
  ),
};
