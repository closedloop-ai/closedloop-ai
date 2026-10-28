import {
  emptyAgentsAgentSessionDetailFixture,
  longContentAgentSessionDetailFixture,
  truncatedEventsAgentSessionDetailFixture,
  unknownStateAgentSessionDetailFixture,
} from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import {
  SESSION_DESIGN_ARTIFACT,
  SESSION_DESIGN_DETAILS_INPUT,
} from "@repo/app/agents/components/detail/detail-design/session-detail-design-fixtures";
import {
  type SessionDesignTab,
  SessionDetailDesignPreview,
} from "@repo/app/agents/components/detail/detail-design/session-detail-design-preview";
import { SessionStatusBadge } from "@repo/app/agents/components/session-status-badges";
import { ACTIVITY_QUERY_DATA } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import SessionDetailPage from "@/app/(authenticated)/[orgSlug]/sessions/[id]/page";
import { SessionDetailPageHeader } from "../composites-v2/v2-artifact-detail-page-header";
import {
  runningSessionDetailFixture,
  SESSION_DETAIL_ID,
  sessionDetailApiRoutes,
  sessionDetailFixture,
  sessionDetailRoutes,
} from "./fixtures/session-detail-fixtures";
import { LivePage } from "./live-page";
import {
  expectActiveNavItem,
  LIVE_ORG_SLUG,
  withLiveRoute,
} from "./live-route";

// ISS-11361 Target sidebar, entry 3 of 62: Session Detail (Four-tab artifact detail).
// The page is the PRD-751 Session detail (ISS-10798): Patterns's
// artifact detail shell with the Session tab set (Session / Details /
// Activity, ISS-12167 — a Session hides the generic Artifact tab), filled with the Composites sections and fixture data, in the
// app frame. ISS-12412 builds its Details tab into the production page and
// ISS-12171 copies this pattern to the remaining artifact types; live
// Activity data is ISS-11004.
//
// The `Live` stories are the page the live app ships today
// (`apps/app/.../sessions/[id]/page.tsx` over `AgentSessionDetailView`), one
// per state it reaches from its reads (`/agent-sessions/:id` and its trace
// comments).

const meta = {
  title: "Surfaces/Artifacts/Sessions/Session Detail",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <SessionDesignPage tab={ArtifactDetailTab.Sessions} />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: {
      path: `/${LIVE_ORG_SLUG}/sessions/${SESSION_DETAIL_ID}`,
      params: { id: SESSION_DETAIL_ID },
    },
    appCore: { apiRoutes: sessionDetailApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const COMMENTS_TOGGLE_RE = /comments rail$/;

/** The people and projects the PRD-751 page's Activity rows name. */
const design = {
  parameters: { appCore: { queryData: ACTIVITY_QUERY_DATA } },
} as const;

/**
 * The PRD-751 page, opened on `tab`, in the app frame.
 */
function SessionDesignPage({
  tab,
  pageHeader = SessionDetailPageHeader,
}: {
  tab: SessionDesignTab;
  pageHeader?: typeof SessionDetailPageHeader;
}) {
  return (
    <LivePage activePath="/sessions">
      <SessionDetailDesignPreview initialTab={tab} pageHeader={pageHeader} />
    </LivePage>
  );
}

/**
 * The Activity Tab story's header: the Session example timeline ends with the
 * session going to Failed, so this story's header says Failed too. Local to
 * this story; the shared design fixture (and every other story) keeps its
 * own status.
 */
function FailedSessionPageHeader(
  parts: Parameters<typeof SessionDetailPageHeader>[0]
) {
  return SessionDetailPageHeader({
    ...parts,
    status: (
      <SessionStatusBadge
        artifactId={SESSION_DESIGN_ARTIFACT.id}
        status="error"
      />
    ),
  });
}

/**
 * The page on Session, the canvas tab. Tab movement, by keyboard and by
 * pointer, with the header actions present on every tab.
 */
export const Default: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <SessionDesignPage tab={ArtifactDetailTab.Sessions} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tablist = canvas.getByRole("tablist", {
      name: "Artifact detail sections",
    });
    await expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(["Session", "Details", "Activity"]);

    const artifact = canvas.getByRole("tab", { name: "Session" });
    await expect(artifact).toHaveAttribute("aria-selected", "true");

    await userEvent.click(artifact);
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(
      canvas.getByRole("button", { name: "Refresh" })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "More session actions" })
    ).toBeInTheDocument();

    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(canvas.getByRole("list", { name: "Activity" })).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Refresh" })
    ).toBeInTheDocument();

    await userEvent.click(artifact);
    await expect(artifact).toHaveAttribute("aria-selected", "true");
    await expectActiveNavItem(canvasElement, "Sessions");
    // The page header row: the breadcrumbs, with the comments toggle at its end.
    const pageHeader = canvas
      .getByRole("button", { name: COMMENTS_TOGGLE_RE })
      .closest("header");
    await expect(pageHeader).not.toBeNull();
    await expect(
      within(pageHeader as HTMLElement).getByRole("link", { name: "Sessions" })
    ).toBeInTheDocument();
    // The tab row ends with the collaborators.
    // ISS-12273: the shared widget makes ONE accessibility statement — the
    // wrapper names every collaborator — so each name is asserted inside that
    // single label rather than on an avatar of its own.
    for (const name of SESSION_DESIGN_ARTIFACT.collaborators) {
      await expect(
        canvas.getAllByRole("img", { name: new RegExp(name) }).length
      ).toBeGreaterThan(0);
    }
  },
};

/**
 * Opened on Details (ISS-12252, ISS-12403): Artifact details, Session
 * details and Associated artifacts (this session is in no project, so it has
 * no custom fields), for the session the header names, with Refresh and the
 * session actions still in the header.
 */
export const DetailsTab: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <SessionDesignPage tab={ArtifactDetailTab.Details} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Details", selected: true })
    ).toBeInTheDocument();
    // The tab names the session the page header names.
    const name = canvas.getByRole("group", { name: "Name" });
    await expect(name).toHaveTextContent(SESSION_DESIGN_DETAILS_INPUT.name);
    await expect(
      canvas.getAllByText(SESSION_DESIGN_DETAILS_INPUT.name).length
    ).toBeGreaterThanOrEqual(2);
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Session details" })
    ).toBeVisible();
    // The session is in no project, so it has no custom fields.
    await expect(
      canvas.queryByRole("heading", { level: 2, name: "Custom fields" })
    ).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Refresh" })
    ).toBeInTheDocument();
  },
};

/** The Details tab in the dark theme. */
export const DetailsTabDark: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <SessionDesignPage tab={ArtifactDetailTab.Details} />,
  globals: { theme: "dark" },
};

/**
 * Opened on Activity: the Session feed, newest first, from desktop sync and
 * System status writes, people, and an API-key agent. The header agrees with
 * the newest row (Failed).
 */
export const ActivityTab: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => (
    <SessionDesignPage
      pageHeader={FailedSessionPageHeader}
      tab={ArtifactDetailTab.Activity}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Activity", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.getByRole("list", { name: "Activity" })).toBeVisible();
    // Session statuses read in the Session words, never the stored value.
    await expect(
      within(canvas.getByRole("list", { name: "Activity" })).getAllByText(
        "Inactive"
      ).length
    ).toBeGreaterThan(0);
  },
};

/** The page in the dark theme. */
export const Dark: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <SessionDesignPage tab={ArtifactDetailTab.Sessions} />,
  globals: { theme: "dark" },
};

/** The page the live app ships today, in the same frame. */
const live = {
  render: () => (
    <LivePage activePath="/sessions">
      <SessionDetailPage />
    </LivePage>
  ),
} satisfies Partial<Story>;

/** `sessionDetailApiRoutes` with the session read answered differently. */
function sessionRead(respond: FixtureRoute["respond"], status?: number) {
  return {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_DETAIL_ID}`,
          respond,
          status,
        },
        ...sessionDetailApiRoutes,
      ] satisfies FixtureRoute[],
    },
  };
}

/** The page the live app ships today. */
export const Live: Story = {
  ...live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        "heading",
        { level: 1, name: sessionDetailFixture.name ?? "" },
        { timeout: 10_000 }
      )
    ).toBeVisible();
    await expectActiveNavItem(canvasElement, "Sessions");
  },
};

/** The session read is still in flight. */
export const LiveLoading: Story = {
  ...live,
  parameters: sessionRead(() => new Promise(() => undefined)),
};

/** The session read failed. */
export const LiveErrorState: Story = {
  ...live,
  name: "Live Error",
  parameters: sessionRead(() => null, 500),
};

/** The id names no session in this workspace. */
export const LiveNotFound: Story = {
  ...live,
  parameters: sessionRead(() => null, 404),
};

/** A run still going on its compute target. */
export const LiveRunning: Story = {
  ...live,
  parameters: {
    appCore: { apiRoutes: sessionDetailRoutes(runningSessionDetailFixture) },
  },
};

/** A synced session with no agents, events or turns. */
export const LiveEmptyAgents: Story = {
  ...live,
  parameters: sessionRead(() => ({
    ...emptyAgentsAgentSessionDetailFixture,
    id: SESSION_DETAIL_ID,
  })),
};

/** The detail read hit its event ceiling, so the trace is a prefix. */
export const LiveEventsTruncated: Story = {
  ...live,
  parameters: sessionRead(() => ({
    ...truncatedEventsAgentSessionDetailFixture,
    id: SESSION_DETAIL_ID,
  })),
};

/** A status this build does not recognize. */
export const LiveUnrecognizedState: Story = {
  ...live,
  parameters: sessionRead(() => ({
    ...unknownStateAgentSessionDetailFixture,
    id: SESSION_DETAIL_ID,
  })),
};

/** Long title and paths, wrapping without overlapping the header controls. */
export const LiveLongContent: Story = {
  ...live,
  parameters: sessionRead(() => ({
    ...longContentAgentSessionDetailFixture,
    id: SESSION_DETAIL_ID,
  })),
};
