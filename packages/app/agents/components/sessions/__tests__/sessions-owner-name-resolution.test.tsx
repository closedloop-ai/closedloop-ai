import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "../../../lib/session-filter-adapter";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsActiveFiltersBar } from "../sessions-active-filters-bar";

/**
 * ISS-4974 — an Owner chip for a user the ACTIVE DATE WINDOW cannot name.
 *
 * Owner labels come from the usage `byUser` breakdown, which is window-scoped.
 * An owner whose sessions all fall outside the window has no usage row, so
 * before this the chip rendered an opaque raw user id. The org member list is
 * the one non-window-scoped source, so it closes the gap — but it must only ever
 * ADD a name it genuinely knows.
 *
 * Every case asserts BOTH sides of the gate, and the "never fabricate" and
 * "never fetch reflexively" rules are asserted as first-class behaviour rather
 * than left to the implementation's good intentions.
 */

const { useOrganizationUsersMock } = vi.hoisted(() => ({
  useOrganizationUsersMock: vi.fn(),
}));

vi.mock("../../../../users/hooks/use-users", () => ({
  useOrganizationUsers: useOrganizationUsersMock,
}));

/** In the usage breakdown — i.e. this person has sessions inside the window. */
const IN_WINDOW_USER_ID = "user-ada";
const IN_WINDOW_USER_NAME = "Ada Lovelace";
/** An org member with NO usage row in the window: the case this ticket exists for. */
const OUT_OF_WINDOW_USER_ID = "user-grace";
const OUT_OF_WINDOW_USER_NAME = "Grace Hopper";
/** Not an org member at all — the raw id must survive as the last resort. */
const STRANGER_USER_ID = "user-not-in-this-org";
/** An org member record carrying neither a name nor an email. */
const NAMELESS_MEMBER_ID = "user-nameless";
const UNKNOWN_USER_PLACEHOLDER = /Unknown user/;

function orgUser(
  overrides: Partial<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  }>
) {
  return {
    id: "user-x",
    clerkId: "clerk-x",
    organizationId: "org-1",
    email: "",
    firstName: null,
    lastName: null,
    avatarUrl: null,
    ...overrides,
  };
}

const ORG_ROSTER = [
  orgUser({
    id: OUT_OF_WINDOW_USER_ID,
    firstName: "Grace",
    lastName: "Hopper",
    email: "grace@closedloop.ai",
  }),
  orgUser({ id: NAMELESS_MEMBER_ID }),
];

function usageWithInWindowOwner() {
  return createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Self, {
    byUser: [
      {
        userId: IN_WINDOW_USER_ID,
        userName: IN_WINDOW_USER_NAME,
        userEmail: "ada@closedloop.ai",
        userAvatarUrl: null,
        sessionCount: 3,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
  });
}

function renderBar({
  filters = DEFAULT_SESSION_FACET_FILTERS,
  scopeUserId,
}: {
  filters?: SessionFacetFilters;
  scopeUserId?: string;
} = {}) {
  // `AppCoreStoryProviders` is still required: this bar reaches the auth adapter
  // (via `useSessionProjectNameResolver` → `useProjects` → `useApiClient`), so a
  // bare render throws. Only the `enabledFlags` seed went away with the gate.
  return render(
    <AppCoreStoryProviders>
      <SessionsActiveFiltersBar
        filters={filters}
        onFiltersChange={vi.fn()}
        onRemoveScopeUser={scopeUserId ? vi.fn() : undefined}
        scopeUserId={scopeUserId}
        usage={usageWithInWindowOwner()}
      />
    </AppCoreStoryProviders>
  );
}

/** Whether the roster read was enabled on ANY render pass. */
function rosterWasFetched(): boolean {
  return useOrganizationUsersMock.mock.calls.some(
    ([options]) => options?.enabled === true
  );
}

beforeEach(() => {
  useOrganizationUsersMock.mockReset();
  useOrganizationUsersMock.mockReturnValue({ data: ORG_ROSTER });
});

describe("Sessions Owner name resolution (ISS-4974)", () => {
  it("names an out-of-window owner from the org roster", () => {
    renderBar({
      filters: {
        ...DEFAULT_SESSION_FACET_FILTERS,
        userIds: [OUT_OF_WINDOW_USER_ID],
      },
    });

    expect(
      screen.getByText(`Owner: ${OUT_OF_WINDOW_USER_NAME}`)
    ).toBeInTheDocument();
    expect(screen.queryByText(`Owner: ${OUT_OF_WINDOW_USER_ID}`)).toBeNull();
  });

  it("resolves the ?userId= scope chip through the SAME rule as the facet chip", () => {
    // The invariant #4276 established: two chips in one row, same facet, must not
    // answer "we don't know this name" two different ways.
    renderBar({ scopeUserId: OUT_OF_WINDOW_USER_ID });

    expect(
      screen.getByText(`Owner: ${OUT_OF_WINDOW_USER_NAME}`)
    ).toBeInTheDocument();
  });

  it("falls back to the raw id for an id belonging to no org member", () => {
    // Never fabricate: an unresolvable owner degrades to the value that is
    // actually narrowing the list, not to a guess and not to a placeholder.
    renderBar({
      filters: {
        ...DEFAULT_SESSION_FACET_FILTERS,
        userIds: [STRANGER_USER_ID],
      },
    });

    expect(screen.getByText(`Owner: ${STRANGER_USER_ID}`)).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_USER_PLACEHOLDER)).toBeNull();
  });

  it("falls back to the raw id for an org member with no name and no email", () => {
    // `getUserDisplayName` would supply "Unknown user" here. A chip reading
    // `Owner: Unknown user` is strictly less useful than the id it replaced — it
    // cannot even be pasted into a search — so the resolver declines it.
    renderBar({
      filters: {
        ...DEFAULT_SESSION_FACET_FILTERS,
        userIds: [NAMELESS_MEMBER_ID],
      },
    });

    expect(
      screen.getByText(`Owner: ${NAMELESS_MEMBER_ID}`)
    ).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_USER_PLACEHOLDER)).toBeNull();
  });

  it("keeps the in-window label authoritative and never fetches the roster for it", () => {
    // The window's own `byUser` name ships beside a session count the reader can
    // check, so it outranks the roster — and an owner it can already name is not
    // a reason to pull the org member list at all.
    renderBar({
      filters: {
        ...DEFAULT_SESSION_FACET_FILTERS,
        userIds: [IN_WINDOW_USER_ID],
      },
    });

    expect(
      screen.getByText(`Owner: ${IN_WINDOW_USER_NAME}`)
    ).toBeInTheDocument();
    expect(rosterWasFetched()).toBe(false);
  });

  it("does not fetch the roster on the default unfiltered view", () => {
    renderBar();

    expect(rosterWasFetched()).toBe(false);
  });

  it("degrades to the raw id while the roster is unavailable", () => {
    // Signed-out desktop, an in-flight read, or a failed one: the chip must stay
    // honest rather than blank or invent a name.
    useOrganizationUsersMock.mockReturnValue({ data: undefined });
    renderBar({
      filters: {
        ...DEFAULT_SESSION_FACET_FILTERS,
        userIds: [OUT_OF_WINDOW_USER_ID],
      },
    });

    expect(
      screen.getByText(`Owner: ${OUT_OF_WINDOW_USER_ID}`)
    ).toBeInTheDocument();
  });
});
