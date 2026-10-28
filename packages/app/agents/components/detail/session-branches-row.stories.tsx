import type { SessionBranch } from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionBranchesRow } from "./session-branches-row";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

// A synthetic org slug so the story's hrefs match the production shape
// (`/{orgSlug}/branches/{id}`) rather than a machine-specific value.
const FIXTURE_ORG_SLUG = "acme" as const;

function branchHref(branchArtifactId: string): string {
  return `/${FIXTURE_ORG_SLUG}/branches/${branchArtifactId}`;
}

function branches(names: readonly string[]): SessionBranch[] {
  return names.map((name) => ({ name, branchArtifactId: `artifact-${name}` }));
}

// The reported session (ISS-8427): six eligible branches, five of which the
// single-branch row discarded.
const REPORTED = branches([
  "worktree-pln-1775-m3-m5",
  "worktree-iss-5517-facet-counts",
  "worktree-iss-5551-cost-rollup",
  "worktree-iss-5705-status-fold",
  "worktree-iss-5871-timeline-bands",
  "worktree-iss-bundled-pr-page-size",
]);

// The count nobody has decided the treatment for. This story is the artifact to
// look at before that decision is made — see the ISS-8427 escalation.
const MANY = branches(
  Array.from(
    { length: 20 },
    (_unused, index) =>
      `worktree-iss-${8400 + index}-long-synthetic-branch-name`
  )
);

const meta = {
  title: "Primitives v1.0/Data Display/Session Branches Row",
  component: SessionBranchesRow,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <SessionPropertiesFrame>
        <Story />
      </SessionPropertiesFrame>
    ),
  ],
} satisfies Meta<typeof SessionBranchesRow>;

export default meta;

type Story = StoryObj<typeof meta>;

/** One branch. The plural row must still read well at the count it replaced. */
export const Single: Story = {
  args: {
    branches: branches(["feat/nav-seams"]),
    getBranchHref: branchHref,
  },
};

/** The reported record: the wrap and label-alignment question. */
export const Several: Story = {
  args: { branches: REPORTED, getBranchHref: branchHref },
};

/**
 * Twenty long names, uncapped and honest. The row does not rank or truncate,
 * because which branches matter is a product decision nobody has taken; this is
 * the evidence for whoever takes it.
 */
export const Many: Story = {
  args: { branches: MANY, getBranchHref: branchHref },
};

/**
 * No href builder — the desktop withholds one whenever its Sessions and Branches
 * readers disagree about cloud-vs-local. Every pill is muted and inert, so
 * "link-colored means clickable" still holds.
 */
export const NotLinkable: Story = {
  args: { branches: REPORTED, getBranchHref: undefined },
};

/** A session that touched no branch: the computed empty answer. */
export const None: Story = {
  args: { branches: [], getBranchHref: branchHref },
};
