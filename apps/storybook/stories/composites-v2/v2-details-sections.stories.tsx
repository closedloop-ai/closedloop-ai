import {
  DETAILS_RELATIONSHIP_LABELS,
  type DetailsTabConfig,
  DetailsTabFieldId,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { DetailsTabFrame, detailsTabFixtureConfig } from "./v2-details-tab";

// ISS-12252: the parts of the Details tab, one at a time, so each can be
// reviewed on its own. The whole tab is Details Tab beside this.
//
// Controls are disabled: each story is a slice of a type's fixture.

const meta = {
  title: "Composites/Shared/Artifact Detail/Details Sections",
  tags: ["stable"],
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Only the rows `ids` names, and the links when asked, and nothing else. */
function onlyRows(
  config: DetailsTabConfig,
  ids: readonly string[],
  linked: DetailsTabConfig["base"]["linked"] = []
): DetailsTabConfig {
  return {
    ...config,
    base: {
      ...config.base,
      core: config.base.core.filter((field) => ids.includes(field.id)),
      customFields: [],
      linked,
    },
  };
}

const F = DetailsTabFieldId;
const EDIT_OWNER = /^Edit owner/;
const EDIT_CREATED_BY = /^Edit created by/;

/**
 * The common fields every artifact has (ISS-12197), as the first group: the
 * Document's, where most of them are editable.
 */
export const CommonFields: Story = {
  render: () => {
    const config = detailsTabFixtureConfig("document");
    return (
      <DetailsTabFrame
        config={onlyRows(
          config,
          config.base.core
            .map((field) => field.id)
            .filter((id) => id !== F.CurrentVersion)
        )}
      />
    );
  },
};

/**
 * Editable and read-only side by side. Hover the Owner value: its background
 * is the only cue, with no pencil. Created by is read-only, so it has none,
 * and its reason is a tooltip.
 */
export const Editability: Story = {
  render: () => (
    <DetailsTabFrame
      config={onlyRows(detailsTabFixtureConfig("document"), [
        F.Owner,
        F.DueDate,
        F.Tags,
        F.CreatedBy,
        F.CreatedAt,
      ])}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: EDIT_OWNER })
    ).toBeVisible();
    await expect(canvasElement.querySelector(".lucide-pencil")).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: EDIT_CREATED_BY })
    ).toBeNull();
  },
};

/**
 * A Session's own fields, in Session details: ISS-12197's list, plus the rows
 * the Properties panel shows today (Kerensa's reconciliation, 2026-10-07). Usage
 * and Repository have no sub-header (ISS-12403); Branches, Pull requests and
 * Lines changed are not Details rows.
 */
export const SessionFields: Story = {
  render: () => {
    const config = detailsTabFixtureConfig("session");
    return (
      <DetailsTabFrame
        config={onlyRows(config, [
          F.SessionId,
          F.Autonomy,
          F.Harness,
          F.Model,
          F.Thread,
          F.AgentRole,
          F.FirstSkill,
          F.PromptSource,
          F.Sync,
          F.Started,
          F.LastActive,
          F.Duration,
          F.Repository,
          F.OtherRepositories,
          F.InputTokens,
          F.OutputTokens,
          F.CacheReadTokens,
          F.CacheWriteTokens,
          F.CacheWriteTtl,
          F.Cost,
          F.LocPerDollar,
          F.TurnCount,
          F.SubagentCount,
          F.ToolUseCount,
          F.SteerCount,
          F.ErrorCount,
        ])}
      />
    );
  },
};

/**
 * A Branch's own fields, in Branch details: ISS-12197's list, plus the
 * candidates already on the branch-detail payload (Kerensa's reconciliation).
 * Its sessions are in Associated artifacts, not a row (ISS-12403).
 */
export const BranchFields: Story = {
  render: () => {
    const config = detailsTabFixtureConfig("branch");
    return (
      <DetailsTabFrame
        config={onlyRows(config, [
          F.Repository,
          F.BaseBranch,
          F.HeadSha,
          F.Origin,
          F.Changes,
          F.FilesChanged,
          F.CommitCount,
          F.PullRequests,
          F.ReviewDecision,
          F.Reviewers,
          F.ChecksStatus,
          F.PrOpenedAt,
          F.Cost,
          F.LocPerDollar,
          F.InputTokens,
          F.OutputTokens,
          F.CacheReadTokens,
          F.CacheWriteTokens,
          F.LeadTime,
          F.IdleTime,
        ])}
      />
    );
  },
};

/** Custom fields come from the artifact's project; the heading names it. */
export const CustomFields: Story = {
  render: () => {
    const config = detailsTabFixtureConfig("document");
    return (
      <DetailsTabFrame
        config={{
          ...onlyRows(config, []),
          base: { ...config.base, core: [] },
        }}
      />
    );
  },
};

/**
 * Associated artifacts: a read-only list of direct links, one section per type
 * (ISS-12403), parents first within each. Every relationship a link can have
 * appears in the Document's list.
 */
export const AssociatedArtifacts: Story = {
  render: () => {
    const config = detailsTabFixtureConfig("document");
    return (
      <DetailsTabFrame config={onlyRows(config, [], config.base.linked)} />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // One section per type, then every relationship, parents first in each.
    await expect(
      canvas
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["Documents", "Issues"]);
    const labels = new Set(Object.values(DETAILS_RELATIONSHIP_LABELS));
    const shown = Array.from(
      canvasElement.querySelectorAll('[data-details-group="associated"] span')
    )
      .map((cell) => cell.textContent ?? "")
      .filter((text) => labels.has(text));
    await expect(shown).toEqual([
      "Parent",
      "Child",
      "Related",
      "Child",
      "Child",
      "Blocked by",
      "Blocking",
    ]);
  },
};

/**
 * A Session's list: two parents, its branch and pull requests, blocked work
 * and related peers.
 */
export const AssociatedMultipleParents: Story = {
  render: () => {
    const config = detailsTabFixtureConfig("session");
    return (
      <DetailsTabFrame
        config={onlyRows(config, [F.Parent], config.base.linked)}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Parent")).toHaveLength(2);
    await expect(canvas.getByText("Blocking")).toBeVisible();
  },
};
