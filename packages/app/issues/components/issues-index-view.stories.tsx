import {
  CollaboratorArtifactType,
  DirectCollaboratorSource,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { Priority } from "@repo/api/src/types/common";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { DOCUMENT_METRIC_TREND_DAYS } from "@repo/api/src/types/document-list-summary";
import { TagColor } from "@repo/api/src/types/tag";
import { ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  getByRoleInOwnParent,
  queryByRoleInOwnParent,
} from "@repo/app/shared/storybook/scoped-role-query";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { METRIC_CARD_LABEL_TEXT_SLOT } from "@repo/design-system/components/ui/primitives/metric-card";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, screen, userEvent } from "storybook/test";
import { IssuesIndexView } from "./issues-index-view";

const PROJECT_MENU_PATTERN = /^Project/;
const TAGS_MENU_PATTERN = /^Tags/;
const issues = [
  createMockDocument({
    id: "00000000-0000-4000-8000-000000000001",
    projectId: "project-1",
    project: { id: "project-1", name: "Delivery" },
    tags: [{ id: "tag-1", name: "Review", color: TagColor.Blue }],
    slug: "ISS-1",
    type: DocumentType.Feature,
    title: "Session history",
    status: IssueStatus.Backlog,
    priority: Priority.High,
  }),
  createMockDocument({
    id: "00000000-0000-4000-8000-000000000002",
    projectId: "project-2",
    project: { id: "project-2", name: "Platform" },
    tags: [],
    slug: "ISS-2",
    type: DocumentType.Feature,
    title: "Branch activity",
    status: IssueStatus.InProgress,
    priority: Priority.Medium,
  }),
];
const series = Array.from({ length: DOCUMENT_METRIC_TREND_DAYS }, (_, index) =>
  index === DOCUMENT_METRIC_TREND_DAYS - 1 ? 1 : 0
);
const meta = {
  title: "Surfaces v1.0/Issues/Listing",
  tags: ["deprecated"],
  component: IssuesIndexView,
  // No controls: this story exercises the real production host and API adapters.
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: {
      apiRoutes: [
        { method: "GET", path: "/documents", respond: () => issues },
        {
          method: "GET",
          path: "/artifacts/collaborators",
          respond: () => ({
            results: issues.map((issue) => ({
              artifactId: issue.id,
              artifactType: CollaboratorArtifactType.Document,
              commentCount: 2,
              collaborators: {
                availability: BranchIdentityAvailability.Complete,
                people: [
                  {
                    provider: BranchPersonProvider.ClosedLoop,
                    id: "user-1",
                    displayName: "Ada Lovelace",
                  },
                ],
                sources: Object.fromEntries(
                  Object.values(DirectCollaboratorSource).map((source) => [
                    source,
                    BranchIdentityAvailability.Complete,
                  ])
                ),
              },
            })),
          }),
        },
        {
          method: "GET",
          path: "/documents/summary",
          respond: ({ searchParams }) => issueSummaryFixture(searchParams),
        },
        {
          method: "POST",
          path: "/documents/costs",
          respond: () => ({
            artifacts: [],
            totalEstimatedCost: 1.25,
            medianEstimatedCost: 0.625,
            trendlines: {
              startDate: "2026-09-26T00:00:00.000Z",
              endDate: "2026-10-09T18:00:00.000Z",
              totalEstimatedCost: series.map((value) => value * 1.25),
              medianEstimatedCost: series.map((value) => value * 0.625),
            },
          }),
        },
        { method: "GET", path: "/custom-fields", respond: () => [] },
        { method: "GET", path: "/tags", respond: () => [] },
        { method: "GET", path: "/artifacts/favorites", respond: () => [] },
        {
          method: "POST",
          path: "/artifacts/related-sessions",
          respond: () => ({ results: {} }),
        },
        {
          method: "GET",
          path: "/me",
          respond: () => ({
            id: "user-1",
            firstName: "Ada",
            lastName: "Lovelace",
          }),
        },
      ] satisfies FixtureRoute[],
      enabledFlags: [ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY],
    },
  },
  decorators: [
    (Story) => (
      <div className="flex h-screen min-h-0 flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IssuesIndexView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText("Session history")).toBeVisible();
    await expect(canvas.getByText("Produced by sessions")).toBeVisible();
    await expect(canvas.getByText("Updated this week")).toBeVisible();
    await expect(
      Array.from(
        canvasElement.querySelectorAll(
          `[data-slot="${METRIC_CARD_LABEL_TEXT_SLOT}"]`
        ),
        (element) => element.textContent
      )
    ).toEqual([
      "Issues",
      "Est. Total",
      "Median token cost",
      "Produced by sessions",
      "Updated this week",
    ]);
    await userEvent.click(
      getByRoleInOwnParent(canvasElement, "button", "Add issue")
    );
    await expect(
      await screen.findByRole("dialog", { hidden: true })
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(
      queryByRoleInOwnParent(canvasElement, "button", "More actions")
    ).not.toBeInTheDocument();
    await userEvent.click(
      getByRoleInOwnParent(canvasElement, "button", "Add New Issue")
    );
    await expect(
      await screen.findByRole("dialog", { hidden: true })
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      getByRoleInOwnParent(canvasElement, "button", "Filters")
    );
    await expect(
      await screen.findByRole("menuitem", {
        name: PROJECT_MENU_PATTERN,
        hidden: true,
      })
    ).toBeVisible();
    await expect(
      screen.getByRole("menuitem", { name: TAGS_MENU_PATTERN, hidden: true })
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      getByRoleInOwnParent(canvasElement, "button", "Group")
    );
    await userEvent.click(
      await screen.findByRole("combobox", {
        name: "Primary grouping field",
        hidden: true,
      })
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Project", hidden: true })
    );
    await userEvent.keyboard("{Escape}");
    await expect(await canvas.findByText("Delivery")).toBeVisible();
    await expect(canvas.getByText("Platform")).toBeVisible();
    await userEvent.click(
      getByRoleInOwnParent(canvasElement, "button", "Clear groups")
    );
  },
};

function issueSummaryFixture(searchParams: URLSearchParams) {
  const artifactIds = searchParams.has("artifactIds")
    ? searchParams.getAll("artifactIds").filter(Boolean)
    : undefined;
  const cohort = artifactIds
    ? issues.filter((issue) => artifactIds.includes(issue.id))
    : issues;
  const produced = cohort.some((issue) => issue.id === issues[0].id) ? 1 : 0;
  return {
    ...(artifactIds === undefined ? {} : { appliedArtifactIds: artifactIds }),
    total: cohort.length,
    producedByAgentSessions: produced,
    updatedInWindow: cohort.length,
    neverEdited: 0,
    windowDays: 7,
    trendlines: {
      startDate: "2026-09-26T00:00:00.000Z",
      endDate: "2026-10-09T18:00:00.000Z",
      total: series.map((value) => value * cohort.length),
      producedByAgentSessions: series.map((value) => value * produced),
      updatedInWindow: series.map((value) => value * cohort.length),
    },
  };
}
