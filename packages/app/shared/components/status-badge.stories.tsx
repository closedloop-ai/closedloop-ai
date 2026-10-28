import type {
  DocumentStatus,
  IssueStatus,
} from "@closedloop-ai/loops-api/document";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import {
  DocumentStatusBadge,
  IssuePriorityBadge,
  IssueStatusBadge,
} from "@repo/app/shared/components/status-badge";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  mockDocumentStatusOptions,
  mockIssuePriorityOptions,
  mockIssueStatusOptions,
} from "@repo/app/shared/lib/domain-mock-data";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

// Reachable, not contrived: `Artifact.status` is a freeform column carrying two
// disjoint vocabularies, so a branch or session row arrives with a status in
// neither.
const UNRECOGNIZED_STATUS = "BRANCH_MERGED";

const BadgeGallery = () => (
  <div className="grid gap-6 md:grid-cols-2">
    <BadgeSection
      items={mockDocumentStatusOptions.map((value) => ({
        label: value,
        badge: <DocumentStatusBadge status={value} />,
      }))}
      title="Document statuses"
    />
    <BadgeSection
      items={mockIssueStatusOptions.map((value) => ({
        label: value,
        badge: <IssueStatusBadge status={value} />,
      }))}
      title="Issue statuses"
    />
    <BadgeSection
      items={mockIssuePriorityOptions.map((value) => ({
        label: value,
        badge: <IssuePriorityBadge priority={value} />,
      }))}
      title="Issue priorities"
    />
  </div>
);

function BadgeSection({
  title,
  items,
}: Readonly<{
  title: string;
  items: { label: string; badge: ReactNode }[];
}>) {
  return (
    <section className="space-y-3">
      <h3 className="font-medium text-sm uppercase tracking-wide">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <div
            className="flex items-center gap-2 rounded-md border px-3 py-2"
            key={item.label}
          >
            {item.badge}
            <span className="text-sm">{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const meta = {
  title: "Composites v1.0/App Shell/Status Badge",
  component: BadgeGallery,
  // Both Default and UnknownStatus below are kitchen-sink comparisons across
  // every status/priority/command value at once, not one concept per story —
  // kept out of the AI manifest for that reason.
  tags: ["deprecated", "autodocs", "!manifest"],
} satisfies Meta<typeof BadgeGallery>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The production badge hosts after the universal status adoption gate opens. */
export const UniversalArtifactStatus: Story = {
  render: () => (
    <div className="grid gap-6 md:grid-cols-2">
      <BadgeSection
        items={mockDocumentStatusOptions.map((value) => ({
          badge: (
            <DocumentStatusBadge
              artifactId={`document-${value}`}
              status={value}
            />
          ),
          label: value,
        }))}
        title="Document statuses"
      />
      <BadgeSection
        items={mockIssueStatusOptions.map((value) => ({
          badge: (
            <IssueStatusBadge artifactId={`issue-${value}`} status={value} />
          ),
          label: value,
        }))}
        title="Issue statuses"
      />
    </div>
  ),
  parameters: {
    appCore: { enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY] },
  },
};

/**
 * ISS-9560 — what a status badge says about a status this build does not
 * recognize, with the gate ON. Both vocabularies answer with the same honest
 * word rather than printing the raw wire token, which is what a reader saw
 * before and could not act on.
 */
export const UnknownStatus: Story = {
  render: () => (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY],
      })}
    >
      <BadgeSection
        items={[
          {
            label: "Document badge",
            badge: (
              <DocumentStatusBadge
                status={UNRECOGNIZED_STATUS as DocumentStatus}
              />
            ),
          },
          {
            label: "Issue badge",
            badge: (
              <IssueStatusBadge status={UNRECOGNIZED_STATUS as IssueStatus} />
            ),
          },
        ]}
        title={`Unrecognized status (${UNRECOGNIZED_STATUS})`}
      />
    </FeatureFlagAdapterProvider>
  ),
};
