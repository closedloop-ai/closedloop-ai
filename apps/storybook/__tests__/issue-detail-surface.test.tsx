/**
 * Behavior tests for the Issue Detail Surface's own modules —
 * `stories/surfaces/issue-detail-editor.tsx` and
 * `stories/surfaces/issue-detail-header.tsx` — driven through the stories in
 * `issue-detail.stories.tsx`. Those stories have no `play`, so the all-stories
 * sweep returns before the fixture GET settles and the editor never mounts;
 * every case here composes a story, waits for the real
 * `VersionedDocumentEditorContainer` to hand the document to
 * `StoryIssueEditor`, then reads the header and drives the plan section.
 *
 * Per-case fixture variants are composed by overriding the story's own
 * `parameters.appCore` (the same channel the preview decorator reads), never
 * by mounting a second harness.
 */

import {
  type DocumentDetail,
  DocumentType,
} from "@repo/api/src/types/document";
import {
  ARTIFACT_DETAIL_TAB_LABELS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { composeStory } from "@storybook/react";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { describe, expect, it } from "vitest";
import { ORG_SLUG } from "../stories/surfaces/app-shell";
import issueDetailMeta, {
  Default as defaultStory,
  NoPlanYet as noPlanYetStory,
} from "../stories/surfaces/issue-detail.stories";

type AppCoreParams = {
  apiRoutes: FixtureRoute[];
  queryData: ReadonlyArray<readonly [readonly unknown[], unknown]>;
  enabledFlags?: readonly string[];
};

type StoryLike = typeof defaultStory;

const PLAN_SECTION_HEADING = /^Plan$/;
const CASE_TIMEOUT_MS = 30_000;
const ACTIONS_LABEL = "Actions";
const MORE_OPTIONS_LABEL = "More options";
const GENERATE_PLAN = "Generate Plan";
const NO_PLAN_SENTENCE = "A plan hasn't been generated for this issue yet";
const SELECT_PLAN_TITLE = "Select Existing Plan";

const ISSUE_DEFAULT = issueDetailMeta.args.document;

const ISSUE_NO_PLAN = noPlanYetStory.args?.document as DocumentDetail;
const DEFAULT_PARAMS = issueDetailMeta.parameters.appCore as AppCoreParams;
const NO_PLAN_PARAMS = noPlanYetStory.parameters?.appCore as AppCoreParams;

/** Composes a story with its `appCore` params replaced by `params`. */
function composeWithParams(story: StoryLike, params: AppCoreParams) {
  return composeStory(
    { ...story, parameters: { ...story.parameters, appCore: params } },
    issueDetailMeta
  );
}

/** The story's by-slug route re-pointed at a modified copy of its issue. */
function servingDocument(
  params: AppCoreParams,
  document: DocumentDetail,
  extraRoutes: FixtureRoute[] = []
): AppCoreParams {
  const bySlug = `/documents/by-slug/${document.slug}`;
  return {
    ...params,
    apiRoutes: [
      ...params.apiRoutes.map((route) =>
        route.method === "GET" && route.path === bySlug
          ? { ...route, respond: () => document }
          : route
      ),
      ...extraRoutes,
    ],
  };
}

/** The implementation plan the default story seeds as the issue's linked plan. */
function seededPlan(): DocumentDetail {
  const entry = DEFAULT_PARAMS.queryData.find(
    ([, data]) =>
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === DocumentType.ImplementationPlan
  );
  if (!entry) {
    throw new Error("default issue story seeds no linked plan document");
  }
  return entry[1] as DocumentDetail;
}

/** The plan section lives on the Details tab of the four-tab detail shell. */
async function openDetailsTab() {
  await userEvent.click(
    screen.getByRole("tab", {
      name: ARTIFACT_DETAIL_TAB_LABELS[ArtifactDetailTab.Details],
    })
  );
}

/** Mounts the story and waits for the editor header to render. */
async function mountEditor(story: ReturnType<typeof composeStory>) {
  await story.run();
  await screen.findByRole(
    "button",
    { name: MORE_OPTIONS_LABEL },
    { timeout: 15_000 }
  );
}

describe("Issue Detail header", () => {
  it(
    "renders team and project breadcrumbs as links under the story org, with no Actions menu",
    async () => {
      const story = composeStory(defaultStory, issueDetailMeta);
      await mountEditor(story);

      const project = ISSUE_DEFAULT.project;
      const team = project?.teams?.[0];
      if (!(project && team)) {
        throw new Error("default issue fixture carries no team");
      }
      const header = screen.getByRole("banner");
      expect(
        within(header).getByRole("link", { name: team.name })
      ).toHaveAttribute("href", `/${ORG_SLUG}/teams/${team.id}/projects`);
      expect(
        within(header).getByRole("link", { name: project.name })
      ).toHaveAttribute(
        "href",
        `/${ORG_SLUG}/teams/${team.id}/projects/${project.id}`
      );
      expect(
        within(header).queryByRole("button", { name: ACTIONS_LABEL })
      ).toBeNull();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "without a project: only the title crumb renders and the section still mounts",
    async () => {
      const orphan: DocumentDetail = {
        ...ISSUE_NO_PLAN,
        projectId: null,
        project: null,
      };
      const story = composeWithParams(
        noPlanYetStory,
        servingDocument(NO_PLAN_PARAMS, orphan)
      );
      await mountEditor(story);

      const crumbs = within(screen.getByRole("banner")).getByRole(
        "navigation",
        { name: "breadcrumb" }
      );
      expect(within(crumbs).queryAllByRole("link")).toHaveLength(0);
      expect(within(crumbs).getByText(orphan.title)).toBeVisible();
    },
    CASE_TIMEOUT_MS
  );
});

describe("Issue Detail plan section", () => {
  it(
    "with a linked plan: lists the plan row, no readiness badge, and collapses on toggle",
    async () => {
      const story = composeStory(defaultStory, issueDetailMeta);
      await mountEditor(story);
      await openDetailsTab();
      const plan = seededPlan();
      const planHeading = await screen.findByRole("button", {
        name: PLAN_SECTION_HEADING,
      });
      expect(await screen.findByText(plan.title)).toBeVisible();
      expect(screen.queryByText("Ready")).toBeNull();
      expect(screen.queryByText("Need description")).toBeNull();
      expect(screen.queryByRole("button", { name: GENERATE_PLAN })).toBeNull();

      await userEvent.click(planHeading);
      await waitFor(() => expect(screen.queryByText(plan.title)).toBeNull());

      await userEvent.click(planHeading);
      expect(await screen.findByText(plan.title)).toBeVisible();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "without a plan: the empty sentence and Select Existing Plan, which opens the dialog",
    async () => {
      // The dialog lists the project's plans through `GET /documents`, which
      // the story never registers because it never opens the dialog.
      const story = composeWithParams(noPlanYetStory, {
        ...NO_PLAN_PARAMS,
        apiRoutes: [
          ...NO_PLAN_PARAMS.apiRoutes,
          { method: "GET", path: "/documents", respond: () => [] },
        ],
      });
      await mountEditor(story);
      await openDetailsTab();

      expect(await screen.findByText(NO_PLAN_SENTENCE)).toBeVisible();
      expect(screen.queryByText("Ready")).toBeNull();
      expect(screen.queryByRole("button", { name: GENERATE_PLAN })).toBeNull();

      await userEvent.click(
        screen.getByRole("button", { name: SELECT_PLAN_TITLE })
      );

      expect(
        await screen.findByRole("heading", { name: SELECT_PLAN_TITLE })
      ).toBeVisible();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "without a description: the same empty sentence, with no readiness copy",
    async () => {
      const blank: DocumentDetail = {
        ...ISSUE_NO_PLAN,
        version: { ...ISSUE_NO_PLAN.version, content: "   " },
      };
      const story = composeWithParams(
        noPlanYetStory,
        servingDocument(NO_PLAN_PARAMS, blank)
      );
      await mountEditor(story);
      await openDetailsTab();

      expect(await screen.findByText(NO_PLAN_SENTENCE)).toBeVisible();
      expect(screen.queryByText("Need description")).toBeNull();
    },
    CASE_TIMEOUT_MS
  );
});
