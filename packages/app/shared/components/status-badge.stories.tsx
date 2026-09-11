import {
  DocumentStatusBadge,
  IssuePriorityBadge,
  IssueStatusBadge,
  LoopCommandBadge,
} from "@repo/app/shared/components/status-badge";
import {
  mockDocumentStatusOptions,
  mockIssuePriorityOptions,
  mockIssueStatusOptions,
  mockLoopCommandOptions,
} from "@repo/app/shared/lib/domain-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

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
    <BadgeSection
      items={mockLoopCommandOptions.map((value) => ({
        label: value,
        badge: <LoopCommandBadge command={value} />,
      }))}
      title="Loop commands"
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

/**
 * A gallery of the badges labeling a document's status, an issue's status or
 * priority, and a Loop command, so the same status keeps the same color
 * everywhere.
 */
const meta = {
  title: "Composites/Feedback & Status/Status Badges",
  component: BadgeGallery,
  tags: ["autodocs"],
} satisfies Meta<typeof BadgeGallery>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
