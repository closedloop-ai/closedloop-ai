import {
  SESSION_PR_ASSOCIATION_OPTIONS,
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  type SessionCostBucketId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import type { AutonomyTier } from "@repo/api/src/session-autonomy-tiers";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostAvailability } from "../../../lib/cost-availability";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "../../../lib/session-filter-adapter";
import {
  createSessionsListSurfaceV2PreviewRow,
  createSessionsListSurfaceV2PreviewUsage,
  SessionsListSurfaceV2Preview,
} from "../sessions-list-surface-v2-demo";
import { matchesSessionsPreviewFacets } from "../sessions-list-surface-v2-demo-facets";
import { SESSIONS_METRIC_CARD_LABEL } from "../sessions-summary-card-labels";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
  cleanup();
});

const WITH_PR = createSessionsListSurfaceV2PreviewRow({
  autonomy: 90,
  costValue: 0.5,
  harness: "claude",
  id: "ses-with-pr",
  model: "claude-opus",
  name: "Ship the grid migration",
  pullRequests: [
    {
      label: "#12",
      numberLabel: "#12",
      statusLabel: "Open",
      title: "Grid migration",
    },
  ],
  repo: "closedloop-ai/closedloop-ai",
  status: SESSION_STATUS.ACTIVE,
  user: { id: "user-ada", name: "Ada Lovelace" },
});
const WITHOUT_PR = createSessionsListSurfaceV2PreviewRow({
  autonomy: 10,
  costAvailability: CostAvailability.NoUsage,
  costValue: null,
  harness: "codex",
  id: "ses-without-pr",
  model: null,
  name: "Explore the trace view",
  pullRequests: [],
  repo: "closedloop-ai/infra",
  status: SESSION_STATUS.ERROR,
  user: { id: "user-grace", name: "Grace Hopper" },
});
const ROWS = [WITH_PR, WITHOUT_PR];

/** The usage fixture's own fixed count, which the card must not echo. */
const FIXTURE_TOTAL = 1047;
const HIGH_TIER: AutonomyTier = "high";
const UNDER_ONE_DOLLAR: SessionCostBucketId = "under_1";
const NO_PR_LABEL =
  SESSION_PR_ASSOCIATION_OPTIONS.find(
    (option) => option.id === SessionPrAssociationId.NoPr
  )?.label ?? SessionPrAssociationId.NoPr;

function facets(patch: Partial<SessionFacetFilters>): SessionFacetFilters {
  return { ...DEFAULT_SESSION_FACET_FILTERS, ...patch };
}

function matchingIds(
  patch: Partial<SessionFacetFilters>,
  changedIds: readonly string[] = []
): string[] {
  return ROWS.filter((row) =>
    matchesSessionsPreviewFacets(row, facets(patch), {
      changeCounts: (candidate: SessionTableRow) => ({
        linesAdded: changedIds.includes(candidate.id) ? 4 : 0,
      }),
      projectIds: (candidate: SessionTableRow) =>
        candidate.id === WITH_PR.id ? ["project-grid"] : [],
    })
  ).map((row) => row.id);
}

describe("matchesSessionsPreviewFacets", () => {
  it("narrows by every facet the server-driven menu offers", () => {
    expect(matchingIds({})).toEqual([WITH_PR.id, WITHOUT_PR.id]);
    expect(matchingIds({ statuses: [SESSION_STATUS.ERROR] })).toEqual([
      WITHOUT_PR.id,
    ]);
    expect(matchingIds({ userIds: ["user-ada"] })).toEqual([WITH_PR.id]);
    expect(matchingIds({ autonomyTiers: [HIGH_TIER] })).toEqual([WITH_PR.id]);
    expect(matchingIds({ harnesses: ["codex"] })).toEqual([WITHOUT_PR.id]);
    expect(matchingIds({ models: ["unknown"] })).toEqual([WITHOUT_PR.id]);
    expect(matchingIds({ repositories: ["closedloop-ai/infra"] })).toEqual([
      WITHOUT_PR.id,
    ]);
    expect(matchingIds({ projectIds: ["project-grid"] })).toEqual([WITH_PR.id]);
    expect(
      matchingIds({ prAssociation: [SessionPrAssociationId.NoPr] })
    ).toEqual([WITHOUT_PR.id]);
    expect(
      matchingIds({ changePresence: [SessionChangePresenceId.HasChanges] }, [
        WITHOUT_PR.id,
      ])
    ).toEqual([WITHOUT_PR.id]);
  });

  it("buckets a known cost numerically and an unknown cost only as Unknown", () => {
    expect(
      matchingIds({ costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] })
    ).toEqual([WITHOUT_PR.id]);
    expect(matchingIds({ costBuckets: [UNDER_ONE_DOLLAR] })).toEqual([
      WITH_PR.id,
    ]);
  });

  it("is OR within a facet and AND across facets", () => {
    expect(
      matchingIds({ statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ERROR] })
    ).toEqual([WITH_PR.id, WITHOUT_PR.id]);
    expect(
      matchingIds({
        prAssociation: [SessionPrAssociationId.HasPr],
        statuses: [SESSION_STATUS.ERROR],
      })
    ).toEqual([]);
  });
});

describe("SessionsListSurfaceV2Preview", () => {
  it("counts the rows the facets kept on the Sessions card", async () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const user = userEvent.setup();
    render(
      <SessionsListSurfaceV2Preview
        rows={ROWS}
        surfaceProps={{ className: "h-auto" }}
        totalRows={ROWS.length}
        usage={createSessionsListSurfaceV2PreviewUsage({
          totalSessions: FIXTURE_TOTAL,
        })}
      />
    );

    expect(within(sessionsCard()).getByText("2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(screen.getByRole("menuitem", { name: "Pull request" }));
    await user.click(await screen.findByText(NO_PR_LABEL));

    expect(within(sessionsCard()).getByText("1")).toBeInTheDocument();
    expect(screen.queryByText(WITH_PR.name)).toBeNull();
    expect(screen.getByText(WITHOUT_PR.name)).toBeInTheDocument();
  });
});

function sessionsCard(): HTMLElement {
  const card = screen
    .getByText(SESSIONS_METRIC_CARD_LABEL)
    .closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error("No Sessions metric card rendered");
  }
  return card;
}
