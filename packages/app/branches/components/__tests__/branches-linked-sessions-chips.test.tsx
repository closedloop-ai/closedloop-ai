import {
  PROVENANCE_RELATIONSHIP_KIND_LABELS,
  ProvenanceRelationshipKind,
} from "@repo/api/src/types/provenance-relationship";
import { RELATED_SESSIONS_DISPLAY_CAP } from "@repo/api/src/types/related-session";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { UNKNOWN_OWNER_LABEL } from "@repo/app/agents/lib/session-timeline-stacks";
import { BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchRow, BranchRowSession } from "../../lib/branch-row";
import { BranchRowStatus } from "../../lib/branch-row";
import { renderApprovedBranchCell } from "../approved-branches-grid-adapter";
import { ApprovedBranchesTable } from "../approved-branches-table";

const VIEWER_TIME_ZONE = "America/Chicago";
const ORIGINAL_TIME_ZONE = process.env.TZ;
const SESSION_HREF = "/org/sessions/SES-101";
const BRANCH_SESSIONS_HREF = "/branches/feature/sessions";
const LINKED_SESSION_COUNT_NAME = /linked session/i;
const CONTRIBUTED_LABEL =
  PROVENANCE_RELATIONSHIP_KIND_LABELS[ProvenanceRelationshipKind.Contribution];
const SESSION_CHIP_NAME = new RegExp(
  `SES-101 · Avery Example · Active · ${CONTRIBUTED_LABEL}`
);
const CHAMPION_SESSION_CHIP_NAME = new RegExp(
  `SES-101 · Avery Example · Running · ${CONTRIBUTED_LABEL}`
);
const UNAVAILABLE_OWNER_CHIP_NAME = new RegExp(
  `SES-104 · ${UNKNOWN_OWNER_LABEL} · Inactive`
);
const MOST_RECENT_INTERACTION = /Most recent interaction/;

const SESSION_A: BranchRowSession = {
  id: "session-a",
  navigableRef: "SES-101",
  occurredAt: "2026-08-14T18:30:00.000Z",
  ownerName: "Avery Example",
  relationshipLabel: CONTRIBUTED_LABEL,
  rawStatus: SESSION_STATUS.ACTIVE,
  slug: "SES-101",
  status: DISPLAYED_SESSION_STATUS.ACTIVE,
};

const SESSION_UNAVAILABLE_OWNER: BranchRowSession = {
  id: "session-d",
  navigableRef: "SES-104",
  occurredAt: "2026-08-11T18:30:00.000Z",
  ownerName: null,
  ownerUnavailable: true,
  relationshipLabel: CONTRIBUTED_LABEL,
  slug: "SES-104",
  status: DISPLAYED_SESSION_STATUS.INACTIVE,
};

const BASE_ROW: BranchRow = {
  additions: 10,
  ahead: 2,
  artifactId: "artifact-a",
  baseBranch: "main",
  behind: 1,
  branchName: "feature/full",
  checksPassed: 1,
  checksStatus: null,
  checksTotal: 1,
  collaborators: [],
  commentCount: null,
  deletions: 5,
  id: "owner%2Fweb::feature/full",
  lastActivityLabel: "Today",
  owner: "Avery Example",
  prNumber: 42,
  prState: null,
  prTitle: "Add feature",
  prUrl: "https://example.test/pull/42",
  repo: "owner/web",
  sessionCount: 1,
  sessions: [SESSION_A],
  status: BranchRowStatus.Open,
};

class NoopResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

describe("Branches canonical Linked Sessions chips", () => {
  beforeEach(() => {
    process.env.TZ = VIEWER_TIME_ZONE;
    Reflect.set(globalThis, "ResizeObserver", NoopResizeObserver);
  });

  afterEach(() => {
    restoreTimeZone(ORIGINAL_TIME_ZONE);
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  it("renders the canonical Wrote membership identity when the gate is on", () => {
    renderSessionsCell(BASE_ROW, {
      enabledFlags: [BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY],
    });

    expect(
      screen.getByRole("link", { name: SESSION_CHIP_NAME })
    ).toHaveAttribute("href", SESSION_HREF);
  });

  it("uses the uncapped canonical count for overflow beyond described members", () => {
    renderSessionsCell({ ...BASE_ROW, sessionCount: 51 });

    expect(screen.getByText("+51")).toBeInTheDocument();
  });

  it("caps mounted chip descriptions while retaining the canonical total", () => {
    const sessions = Array.from(
      { length: RELATED_SESSIONS_DISPLAY_CAP + 2 },
      (_unused, index): BranchRowSession => ({
        ...SESSION_A,
        id: `session-${index}`,
        navigableRef: `SES-${index}`,
        slug: `SES-${index}`,
      })
    );
    renderSessionsCell({
      ...BASE_ROW,
      sessionCount: sessions.length,
      sessions,
    });

    expect(screen.getAllByTitle(MOST_RECENT_INTERACTION)).toHaveLength(
      RELATED_SESSIONS_DISPLAY_CAP
    );
  });

  it("keeps the count chip while the gate is off", () => {
    renderSessionsCell({ ...BASE_ROW, sessionCount: 3 }, { enabledFlags: [] });

    expect(
      screen.getByRole("link", { name: LINKED_SESSION_COUNT_NAME })
    ).toHaveTextContent("3");
    expect(screen.queryByRole("link", { name: SESSION_CHIP_NAME })).toBeNull();
  });

  it.each([
    {
      name: "chip flag on",
      enabledFlags: [BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY],
    },
    { name: "chip flag off", enabledFlags: [] },
  ])("keeps the canonical empty value with $name", ({ enabledFlags }) => {
    renderSessionsCell(
      { ...BASE_ROW, sessionCount: 0, sessions: undefined },
      { enabledFlags }
    );

    expect(screen.getByText("—")).toHaveAttribute(
      "data-slot",
      "grid-empty-value"
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps the legacy table on its count chip even when the gate is on", () => {
    withProviders(
      <ApprovedBranchesTable
        getSessionsHref={() => BRANCH_SESSIONS_HREF}
        items={[{ ...BASE_ROW, sessionCount: 3 }]}
      />,
      [BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY]
    );

    expect(
      screen.getByRole("link", { name: LINKED_SESSION_COUNT_NAME })
    ).toHaveTextContent("3");
  });

  it("preserves owner-unavailable instead of claiming the Session is unowned", () => {
    renderSessionsCell(
      {
        ...BASE_ROW,
        sessions: [SESSION_UNAVAILABLE_OWNER],
      },
      { enabledFlags: [BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY] }
    );

    expect(
      screen.getByRole("link", { name: UNAVAILABLE_OWNER_CHIP_NAME })
    ).toBeInTheDocument();
  });

  it("labels the same canonical member from raw lifecycle evidence", () => {
    renderSessionsCell(BASE_ROW, {
      enabledFlags: [
        BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY,
        UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY,
      ],
    });

    expect(
      screen.getByRole("link", { name: CHAMPION_SESSION_CHIP_NAME })
    ).toBeInTheDocument();
  });
});

function renderSessionsCell(
  row: BranchRow,
  {
    enabledFlags = [BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY],
  }: {
    enabledFlags?: readonly string[];
  } = {}
) {
  return withProviders(
    renderApprovedBranchCell(
      "sessions",
      row,
      new Map<string, string>(),
      () => BRANCH_SESSIONS_HREF,
      false,
      {
        chipsSupportedBySurface: true,
        getSessionHref: (session) => `/org/sessions/${session.navigableRef}`,
      }
    ),
    enabledFlags
  );
}

function withProviders(ui: ReactNode, enabledFlags: readonly string[]) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <TooltipProvider>{ui}</TooltipProvider>
    </AppCoreStoryProviders>
  );
}
