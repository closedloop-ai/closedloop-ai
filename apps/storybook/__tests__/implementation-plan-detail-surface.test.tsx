/**
 * Behavior tests for the Implementation Plan Detail Surface's own modules —
 * `stories/surfaces/implementation-plan-detail-header.tsx` and
 * `stories/surfaces/implementation-plan-detail-editor.tsx`.
 *
 * The header is prop-driven, so its state matrix (breadcrumbs, PR links)
 * is rendered directly under the app-core harness. The editor is
 * driven through the stories in `implementation-plan-detail.stories.tsx`:
 * those stories have no `play`, so the cases at the bottom compose a story
 * with seeded routes and drive its interactions for real.
 */
import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import {
  type DocumentDetail,
  DocumentType,
  type PullRequestInfo,
  PullRequestState,
} from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { composeStory } from "@storybook/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORG_SLUG } from "../stories/surfaces/app-shell";
import planDetailMeta, {
  Default as defaultStory,
  Draft as draftStory,
} from "../stories/surfaces/implementation-plan-detail.stories";
import { StoryPlanEditorHeader } from "../stories/surfaces/implementation-plan-detail-header";
import { PlanDetailHarness as Harness } from "./helpers/plan-detail-harness";

type AppCoreParams = {
  apiRoutes: FixtureRoute[];
  queryData: readonly (readonly unknown[])[];
  enabledFlags?: readonly string[];
};

const CASE_TIMEOUT_MS = 30_000;
const ACTIONS_LABEL = "Actions";
const MORE_OPTIONS_LABEL = "More options";
const TOGGLE_PANEL_LABEL = "Toggle chat panel";

const PR_2_EXACT = /^PR #2$/;
const PR_1 = /PR #1$/;
const ANY_PR = /PR #/;
const PR_2 = /PR #2$/;
const PR_3 = /PR #3$/;
const PR_7 = /PR #7$/;
const PR_8 = /PR #8$/;
// `useEditorChrome` persists the side-panel state under this key.
const PANEL_STATE_KEY = `panel:chat:${DocumentType.ImplementationPlan}`;
const PLAN_APPROVED = planDetailMeta.args.document;
const PLAN_DRAFT = draftStory.args?.document as DocumentDetail;
const DEFAULT_PARAMS = planDetailMeta.parameters.appCore as AppCoreParams;
const TEAM = requireTeam(PLAN_APPROVED);

function requireTeam(document: DocumentDetail) {
  const team = document.project?.teams?.[0];
  if (!team) {
    throw new Error(`${document.slug} fixture carries no team`);
  }
  return team;
}

function requireProject(document: DocumentDetail) {
  if (!document.project) {
    throw new Error(`${document.slug} fixture carries no project`);
  }
  return document.project;
}

function pullRequest(overrides: Partial<PullRequestInfo>): PullRequestInfo {
  return {
    id: "pr-1",
    number: 101,
    title: "Nightly backfill",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/101",
    state: PullRequestState.Open,
    isDraft: false,
    headBranch: "feat/nightly-backfill",
    baseBranch: "main",
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
    checksStatus: null,
    reviewDecision: null,
    externalLinkId: "branch-artifact-1",
    repoFullName: "closedloop-ai/closedloop-ai",
    productEligibility: BranchProductEligibility.Eligible,
    ...overrides,
  };
}

function headerHandlers() {
  return {
    onToggleMetadataPanel: vi.fn(),
    onCopyMarkdown: vi.fn(),
    onExportMarkdown: vi.fn(),
    onMove: vi.fn(),
    onDelete: vi.fn(),
  };
}

async function openMenu(name: string) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("menu");
}

function menuItem(name: string | RegExp) {
  return screen.getByRole("menuitem", { name });
}

function isDisabled(item: HTMLElement) {
  return (
    item.hasAttribute("data-disabled") ||
    item.getAttribute("aria-disabled") === "true"
  );
}

function composeWithParams(story: typeof defaultStory, params: AppCoreParams) {
  return composeStory(
    { ...story, parameters: { ...story.parameters, appCore: params } },
    planDetailMeta
  );
}

/** The story's params with its (empty) pull-request seed replaced. */
function withPullRequests(
  params: AppCoreParams,
  document: DocumentDetail,
  pullRequests: PullRequestInfo[],
  extraRoutes: FixtureRoute[] = []
): AppCoreParams {
  const prKey = [...documentKeys.detail(document.id), "pull-request"];
  return {
    ...params,
    apiRoutes: [...params.apiRoutes, ...extraRoutes],
    queryData: params.queryData.map((entry) =>
      JSON.stringify(entry[0]) === JSON.stringify(prKey)
        ? [entry[0], pullRequests]
        : entry
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StoryPlanEditorHeader", () => {
  it("plan in a team project: links team/project crumbs, no Actions menu", () => {
    const handlers = headerHandlers();
    render(
      <Harness>
        <StoryPlanEditorHeader plan={PLAN_DRAFT} {...handlers} />
      </Harness>
    );

    const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(
      within(crumbs).getByRole("link", { name: TEAM.name })
    ).toHaveAttribute("href", `/${ORG_SLUG}/teams/${TEAM.id}/projects`);
    expect(
      within(crumbs).getByRole("link", {
        name: requireProject(PLAN_DRAFT).name,
      })
    ).toHaveAttribute(
      "href",
      `/${ORG_SLUG}/teams/${TEAM.id}/projects/${requireProject(PLAN_DRAFT).id}`
    );
    expect(
      screen.getByRole("button", { name: TOGGLE_PANEL_LABEL })
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: ACTIONS_LABEL })).toBeNull();
  });

  it("approved plan without a team: Plans crumb, no Actions menu, restore offered, panel toggle shown", async () => {
    const handlers = headerHandlers();
    const onRestoreVersion = vi.fn();
    const orphan: DocumentDetail = {
      ...PLAN_APPROVED,
      project: { id: "proj-x", name: "Orphan", teams: [] },
    };
    render(
      <Harness>
        <StoryPlanEditorHeader
          onRestoreVersion={onRestoreVersion}
          plan={orphan}
          showRestore
          {...handlers}
        />
      </Harness>
    );

    const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Plans" })).toHaveAttribute(
      "href",
      `/${ORG_SLUG}/implementation-plans`
    );
    expect(
      screen.getByRole("button", { name: TOGGLE_PANEL_LABEL })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ACTIONS_LABEL })).toBeNull();

    await openMenu(MORE_OPTIONS_LABEL);
    await userEvent.click(menuItem("Restore Version"));
    expect(onRestoreVersion).toHaveBeenCalledTimes(1);
  });

  it("overflow menu: each plain action fires its handler; the toggle button fires its own", async () => {
    const handlers = headerHandlers();
    render(
      <Harness>
        <StoryPlanEditorHeader plan={PLAN_APPROVED} {...handlers} />
      </Harness>
    );
    const clickOverflow = async (name: string) => {
      await openMenu(MORE_OPTIONS_LABEL);
      await userEvent.click(menuItem(name));
    };

    await clickOverflow("Export Markdown");
    await clickOverflow("Copy Markdown");
    await clickOverflow("Move...");
    await clickOverflow("Delete Plan");
    await userEvent.click(
      screen.getByRole("button", { name: TOGGLE_PANEL_LABEL })
    );

    expect(handlers.onExportMarkdown).toHaveBeenCalledTimes(1);
    expect(handlers.onCopyMarkdown).toHaveBeenCalledTimes(1);
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleMetadataPanel).toHaveBeenCalledTimes(1);
    await openMenu(MORE_OPTIONS_LABEL);
    expect(
      screen.queryByRole("menuitem", { name: "Restore Version" })
    ).toBeNull();
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });

  it("lists pull requests in the overflow menu, linking only the ones the rollout can route", async () => {
    const pullRequests = [
      pullRequest({ id: "pr-eligible", number: 1 }),
      pullRequest({
        id: "pr-fallback",
        number: 2,
        externalLinkId: "branch-fallback",
        hasCompatibilityProviderFallback: true,
        repoFullName: null,
      }),
      pullRequest({ id: "pr-unlinked", number: 3, externalLinkId: null }),
    ];
    const { unmount } = render(
      <Harness>
        <StoryPlanEditorHeader
          plan={PLAN_APPROVED}
          pullRequests={pullRequests}
          {...headerHandlers()}
        />
      </Harness>
    );

    await openMenu(MORE_OPTIONS_LABEL);
    // Rollout flag off: only the compatibility fallback routes, to /build.
    expect(isDisabled(menuItem(PR_1))).toBe(true);
    expect(within(menuItem(PR_2)).queryByRole("link")).toBeNull();
    expect(menuItem(PR_2)).toHaveAttribute(
      "href",
      `/${ORG_SLUG}/build/branch-fallback`
    );
    expect(menuItem(PR_2)).toHaveTextContent(PR_2_EXACT);
    expect(menuItem(PR_1)).toHaveTextContent(
      "closedloop-ai/closedloop-ai PR #1"
    );
    expect(isDisabled(menuItem(PR_3))).toBe(true);
    await userEvent.keyboard("{Escape}");
    unmount();

    render(
      <Harness enabledFlags={[ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY]}>
        <StoryPlanEditorHeader
          plan={PLAN_APPROVED}
          pullRequests={pullRequests}
          {...headerHandlers()}
        />
      </Harness>
    );
    await openMenu(MORE_OPTIONS_LABEL);
    // Rollout flag on: every linked PR routes to /branches.
    expect(menuItem(PR_1)).toHaveAttribute(
      "href",
      `/${ORG_SLUG}/branches/branch-artifact-1`
    );
    expect(menuItem(PR_2)).toHaveAttribute(
      "href",
      `/${ORG_SLUG}/branches/branch-fallback`
    );
    expect(isDisabled(menuItem(PR_3))).toBe(true);
  });
});

describe("StoryPlanEditor through the stories", () => {
  it(
    "with seeded pull requests: the overflow menu lists each one",
    async () => {
      const story = composeWithParams(
        defaultStory,
        withPullRequests(DEFAULT_PARAMS, PLAN_APPROVED, [
          pullRequest({
            id: "pr-other",
            number: 7,
            repoFullName: "closedloop-ai/other",
          }),
          pullRequest({ id: "pr-primary", number: 8 }),
        ])
      );
      await story.run();
      await userEvent.click(
        await screen.findByRole(
          "button",
          { name: MORE_OPTIONS_LABEL },
          { timeout: 15_000 }
        )
      );
      await screen.findByRole("menu");
      expect(screen.getByRole("menuitem", { name: PR_7 })).toBeVisible();
      expect(screen.getByRole("menuitem", { name: PR_8 })).toBeVisible();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "with the pull-request read unseeded: no PR entries",
    async () => {
      const prKey = [...documentKeys.detail(PLAN_APPROVED.id), "pull-request"];
      const story = composeWithParams(defaultStory, {
        ...DEFAULT_PARAMS,
        queryData: DEFAULT_PARAMS.queryData.filter(
          (entry) => JSON.stringify(entry[0]) !== JSON.stringify(prKey)
        ),
        apiRoutes: [
          ...DEFAULT_PARAMS.apiRoutes,
          {
            method: "GET",
            path: `/documents/${PLAN_APPROVED.id}/pull-request`,
            respond: () => [],
          },
        ],
      });
      await story.run();
      await userEvent.click(
        await screen.findByRole(
          "button",
          { name: MORE_OPTIONS_LABEL },
          { timeout: 15_000 }
        )
      );
      await screen.findByRole("menu");
      expect(screen.queryByRole("menuitem", { name: ANY_PR })).toBeNull();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "offers the chat-panel toggle with no flags set, and each click flips the persisted panel state",
    async () => {
      await composeStory(defaultStory, planDetailMeta).run();
      const toggles = await screen.findAllByRole(
        "button",
        { name: TOGGLE_PANEL_LABEL },
        { timeout: 15_000 }
      );
      expect(toggles).toHaveLength(1);
      const [toggle] = toggles;
      if (!toggle) {
        throw new Error("expected exactly one chat-panel toggle");
      }
      // The story is room-less, so the feed rail stays disabled and the only
      // observable effect of the toggle is the scaffold's persisted panel
      // state (`useEditorChrome`, keyed per document type).
      expect(globalThis.localStorage.getItem(PANEL_STATE_KEY)).toBeNull();
      await userEvent.click(toggle);
      await waitFor(() =>
        expect(globalThis.localStorage.getItem(PANEL_STATE_KEY)).toBe("false")
      );
      await userEvent.click(toggle);
      await waitFor(() =>
        expect(globalThis.localStorage.getItem(PANEL_STATE_KEY)).toBe("true")
      );
    },
    CASE_TIMEOUT_MS
  );
  it(
    "viewing a historical version: Restore Version posts that version's content back as a new version",
    async () => {
      const historical: DocumentDetail = { ...PLAN_APPROVED, latestVersion: 2 };
      const versionsPath = `/documents/${historical.id}/versions`;
      const bySlug = `/documents/by-slug/${historical.slug}`;
      const original = DEFAULT_PARAMS.apiRoutes.find(
        (route) => route.method === "POST" && route.path === versionsPath
      );
      if (!original) {
        throw new Error("story registers no versions route");
      }
      const posted = vi.fn(original.respond);
      const story = composeStory(
        {
          ...defaultStory,
          args: { ...defaultStory.args, document: historical, version: 1 },
          parameters: {
            ...defaultStory.parameters,
            appCore: {
              ...DEFAULT_PARAMS,
              apiRoutes: [
                ...DEFAULT_PARAMS.apiRoutes.map((route) => {
                  if (route === original) {
                    return { ...route, respond: posted };
                  }
                  if (route.method === "GET" && route.path === bySlug) {
                    return { ...route, respond: () => historical };
                  }
                  return route;
                }),
                // The new version invalidates the document's queries, so the
                // seeded pull-request list is re-read.
                {
                  method: "GET",
                  path: `/documents/${historical.id}/pull-request`,
                  respond: () => [],
                },
              ],
            },
          },
        },
        planDetailMeta
      );
      await story.run();
      await screen.findByRole(
        "button",
        { name: MORE_OPTIONS_LABEL },
        { timeout: 15_000 }
      );
      await openMenu(MORE_OPTIONS_LABEL);

      await userEvent.click(menuItem("Restore Version"));

      await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
      expect(posted.mock.calls[0]?.[0]).toMatchObject({
        body: { content: historical.version.content },
      });
    },
    CASE_TIMEOUT_MS
  );
});
