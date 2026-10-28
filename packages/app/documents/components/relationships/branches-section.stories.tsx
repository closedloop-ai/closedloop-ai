/**
 * The Build section's zero-branch empty state, which needs the link query
 * seeded empty to reach deterministically.
 */

import { LinkDirection, LinkQueryMode } from "@repo/api/src/types/artifact";
import { artifactLinkKeys } from "@repo/app/documents/hooks/use-artifact-links";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchesSection } from "./branches-section";

const DOCUMENT_ID = "iss-5508-story-document";
const PROJECT_ID = "iss-5508-story-project";
const PLAN_ID = "iss-5508-story-plan";

/**
 * Seeded rather than left to the harness transport so the section renders its
 * zero-branch empty state deterministically. Spelled through `artifactLinkKeys` with
 * the same argument shape `BranchesSection` passes to `useResolvedArtifactLinks`,
 * so a change to either drifts loudly instead of quietly missing the cache and
 * falling back to a fixture response.
 */
const NO_BRANCH_LINKS = [
  artifactLinkKeys.list({
    artifactId: DOCUMENT_ID,
    direction: LinkDirection.Target,
    linkType: undefined,
    maxDepth: undefined,
    mode: LinkQueryMode.Tree,
    resolved: true,
  }),
  [],
] as const;

const meta = {
  title: "Composites v1.0/Documents/Branches Section",
  component: BranchesSection,
  tags: ["deprecated", "autodocs"],
  args: {
    documentId: DOCUMENT_ID,
    planId: PLAN_ID,
    projectId: PROJECT_ID,
  },
  parameters: {
    appCore: { queryData: [NO_BRANCH_LINKS] },
    layout: "padded",
  },
} satisfies Meta<typeof BranchesSection>;

export default meta;

type Story = StoryObj<typeof meta>;

/** No branches yet. */
export const EmptyState: Story = {};
