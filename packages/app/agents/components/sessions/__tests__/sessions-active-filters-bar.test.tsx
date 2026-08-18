import { SESSION_CHANGE_PRESENCE_OPTIONS } from "@repo/api/src/agent-session-filters";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "../../../lib/session-filter-adapter";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsActiveFiltersBar } from "../sessions-active-filters-bar";

const OWNER_USER_ID = "user-ada";
const STATUS_CHIP_TEXT = /Status:/;
const OWNER_CHIP_TEXT = /Owner:/;
// ISS-4586 retired `completed` from the Status facet vocabulary; seed a status
// that the facet still offers so the chip resolves a human label from the option
// list (rather than falling back to the raw wire value).
const STATUS_CHIP_LABEL = `Status: ${SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE]}`;
// ISS-4728: the `?userId` scope borrows the Owner facet's label vocabulary, so
// its chip reads exactly like an Owner facet chip for the same person.
const SCOPE_OWNER_CHIP_LABEL = "Owner: Ada Lovelace";
// The fallback an unresolvable scoped user gets — the SAME raw-id treatment
// `deriveSessionFilterChips` gives an out-of-range Owner facet value, so one row
// never shows two different answers for "we don't know this name" (review cid
// 3701359140). Matched under the `Owner: ` prefix so the assertion pins the
// rendered chip, not a stray substring elsewhere in the row.
const UNRESOLVED_SCOPE_USER_ID_TEXT = /^Owner: user-not-in-usage$/;
// The placeholder the scope chip used to fall back to, now retired — pinned so a
// reintroduction re-splits the two fallbacks this test exists to keep aligned.
const RETIRED_SCOPE_PLACEHOLDER_TEXT = /Selected user/;
// ISS-5355: the Project facet the project-detail strip links into.
const PROJECT_ID = "019f8008-1969-74f9-b056-99c13cca9a07";
const PROJECT_NAME = "Symphony Alpha";
const PROJECT_CHIP_LABEL = `Project: ${PROJECT_NAME}`;
const PROJECT_CHIP_TEXT = /Project:/;

function usageWithOwner() {
  return createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Self, {
    byUser: [
      {
        userId: OWNER_USER_ID,
        userName: "Ada Lovelace",
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

describe("SessionsActiveFiltersBar", () => {
  it("renders nothing when no facet is active", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onFiltersChange={vi.fn()}
        />
      </AppCoreStoryProviders>
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders one labeled chip per active facet value using the facet label map", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            statuses: [SESSION_STATUS.INACTIVE],
            userIds: [OWNER_USER_ID],
          }}
          onFiltersChange={vi.fn()}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    // Status label comes from SESSION_STATUS_FILTER_OPTIONS; Owner from usage.
    expect(screen.getByText(STATUS_CHIP_LABEL)).toBeVisible();
    expect(screen.getByText("Owner: Ada Lovelace")).toBeVisible();
  });

  it("renders a removable chip for a flag-gated Changes selection even when the flag is off", async () => {
    // ISS-4605 (codex P1 + stage review): `sessions-change-pr-filters` is OFF in
    // the story providers (default), so the Filter popover omits the Changes /
    // Pull request facets. A `changes=` selection can still arrive from a shared
    // list URL, and the chip row must surface EVERY active filter — otherwise it
    // silently narrows the list with no chip to name or remove it, and Clear all
    // would wipe a facet the row never showed.
    const user = userEvent.setup();
    const changeOptionLabel = SESSION_CHANGE_PRESENCE_OPTIONS[0].label;
    render(
      <AppCoreStoryProviders>
        <ActiveFiltersHarness
          initial={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            changePresence: [SESSION_CHANGE_PRESENCE_OPTIONS[0].id],
          }}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(`Changes: ${changeOptionLabel}`)).toBeVisible();

    // And Clear all removes it (the chip row owns it, so nothing is left behind).
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(
      screen.queryByText(`Changes: ${changeOptionLabel}`)
    ).not.toBeInTheDocument();
  });

  it("removing a chip clears just that facet value", async () => {
    const user = userEvent.setup();
    render(
      <AppCoreStoryProviders>
        <ActiveFiltersHarness
          initial={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            statuses: [SESSION_STATUS.INACTIVE],
            userIds: [OWNER_USER_ID],
          }}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    await user.click(
      screen.getByRole("button", { name: "Remove Owner: Ada Lovelace filter" })
    );

    expect(screen.queryByText("Owner: Ada Lovelace")).not.toBeInTheDocument();
    // The untouched Status chip stays.
    expect(screen.getByText(STATUS_CHIP_LABEL)).toBeVisible();
  });

  it("clear-all resets every facet", async () => {
    const user = userEvent.setup();
    render(
      <AppCoreStoryProviders>
        <ActiveFiltersHarness
          initial={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            statuses: [SESSION_STATUS.INACTIVE],
            userIds: [OWNER_USER_ID],
          }}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    await user.click(screen.getByRole("button", { name: "Clear all" }));

    expect(screen.queryByText(STATUS_CHIP_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(OWNER_CHIP_TEXT)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear all" })
    ).not.toBeInTheDocument();
  });

  it("delegates Clear all to onClearAll (the host's total clear) when provided", async () => {
    // stage review: when the host owns a total clear (facets + date window +
    // search + user scope), Clear all must call it, NOT the facet-only reset —
    // otherwise "Clear all" leaves the list narrowed and reads as stuck.
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            statuses: [SESSION_STATUS.INACTIVE],
          }}
          onClearAll={onClearAll}
          onFiltersChange={onFiltersChange}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    await user.click(screen.getByRole("button", { name: "Clear all" }));

    expect(onClearAll).toHaveBeenCalledTimes(1);
    // The facet-only reset is NOT used when the host owns the total clear.
    expect(onFiltersChange).not.toHaveBeenCalled();
  });
});

describe("SessionsActiveFiltersBar selected-user scope (ISS-4728)", () => {
  it("names the `?userId` scope as an Owner chip using the Owner facet's own label", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onFiltersChange={vi.fn()}
          onRemoveScopeUser={vi.fn()}
          scopeUserId={OWNER_USER_ID}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    // The scope alone makes the row render: before ISS-4728 no facet was active,
    // so the row was empty and the only thing naming the narrowing was a badge
    // elsewhere on the page with no way to remove it.
    expect(screen.getByText(SCOPE_OWNER_CHIP_LABEL)).toBeInTheDocument();
  });

  it("removes ONLY the scope — the host's URL-param strip, not a facet toggle", async () => {
    const user = userEvent.setup();
    const onRemoveScopeUser = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onFiltersChange={onFiltersChange}
          onRemoveScopeUser={onRemoveScopeUser}
          scopeUserId={OWNER_USER_ID}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    await user.click(
      screen.getByRole("button", {
        name: `Remove ${SCOPE_OWNER_CHIP_LABEL} filter`,
      })
    );

    // ONE write, carrying the facets to re-assert alongside the param strip.
    // Unchanged here, because this user was never a selected facet value.
    expect(onRemoveScopeUser).toHaveBeenCalledTimes(1);
    expect(onRemoveScopeUser).toHaveBeenCalledWith(
      DEFAULT_SESSION_FACET_FILTERS
    );
    // The two narrowers reach the query independently; toggling the Owner facet
    // would leave `?userId` narrowing the list with nothing left to say so.
    expect(onFiltersChange).not.toHaveBeenCalled();
  });

  it("collapses into ONE chip when the same user is also a selected Owner facet, and removing it undoes both", async () => {
    const user = userEvent.setup();
    const onRemoveScopeUser = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            userIds: [OWNER_USER_ID],
          }}
          onFiltersChange={onFiltersChange}
          onRemoveScopeUser={onRemoveScopeUser}
          scopeUserId={OWNER_USER_ID}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    // Two chips reading `Owner: Ada Lovelace`, one of which only half-unnarrows
    // the list, is the confusion this row exists to end.
    expect(screen.getAllByText(SCOPE_OWNER_CHIP_LABEL)).toHaveLength(1);

    await user.click(
      screen.getByRole("button", {
        name: `Remove ${SCOPE_OWNER_CHIP_LABEL} filter`,
      })
    );

    // REGRESSION GUARD (review cid 3701353686 / 3701348653 / 3701359129): the
    // merged chip must undo both narrowers in ONE write. It used to chain the
    // scope's remove and the facet's `onToggle`; both derive their replacement
    // URL from the same pre-click search-params snapshot, React batches them
    // inside this single click with no re-render between, so the second replace
    // won and put `?userId` straight back — the chip re-rendered over a list
    // that was still narrowed. Asserting "both callbacks fired" is exactly what
    // let that ship, so this asserts the shape instead: ONE call, carrying the
    // reduced facets, and NO separate facet write.
    expect(onRemoveScopeUser).toHaveBeenCalledTimes(1);
    expect(onRemoveScopeUser).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: [] })
    );
    expect(onFiltersChange).not.toHaveBeenCalled();
  });

  it("keeps every OTHER facet selection when the merged chip is removed", async () => {
    const user = userEvent.setup();
    const onRemoveScopeUser = vi.fn();
    render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            statuses: ["completed"],
            userIds: [OWNER_USER_ID],
          }}
          onFiltersChange={vi.fn()}
          onRemoveScopeUser={onRemoveScopeUser}
          scopeUserId={OWNER_USER_ID}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    await user.click(
      screen.getByRole("button", {
        name: `Remove ${SCOPE_OWNER_CHIP_LABEL} filter`,
      })
    );

    // The single write re-asserts the whole facet set, so a facet the reader
    // never touched must survive it — dropping `statuses` here would silently
    // widen the list past what the one chip claimed to control.
    expect(onRemoveScopeUser).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["completed"], userIds: [] })
    );
  });

  it("falls back to the raw user id, the same treatment a dropped-out-of-range Owner facet value gets", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onFiltersChange={vi.fn()}
          onRemoveScopeUser={vi.fn()}
          scopeUserId="user-not-in-usage"
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    // Review cid 3701359140: one row must not answer "we don't know this user's
    // name" two different ways. `deriveSessionFilterChips` already falls back to
    // the raw id for a facet-selected Owner who dropped out of the date window,
    // so the scope chip does too — an opaque id beside a "Selected user"
    // placeholder, both labelled `Owner`, is the drift this guards.
    expect(screen.getByText(UNRESOLVED_SCOPE_USER_ID_TEXT)).toBeInTheDocument();
    expect(
      screen.queryByText(RETIRED_SCOPE_PLACEHOLDER_TEXT)
    ).not.toBeInTheDocument();
  });

  it("stays inert for a surface with no such scope (desktop passes neither prop)", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onFiltersChange={vi.fn()}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders no chip when the scope has no way to be removed", () => {
    // A chip that names a filter it cannot clear is the badge ISS-4728 retired.
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionsActiveFiltersBar
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onFiltersChange={vi.fn()}
          scopeUserId={OWNER_USER_ID}
          usage={usageWithOwner()}
        />
      </AppCoreStoryProviders>
    );

    expect(container).toBeEmptyDOMElement();
  });

  // ISS-5355: the project-detail strip links here with `?project=`, so a Project
  // selection MUST arrive with a chip that names and clears it. A filter the row
  // does not surface narrows the list invisibly and Clear all wipes it silently.
  it("renders a Project chip for a selection arriving from the project-detail link", () => {
    render(
      <AppCoreStoryProviders>
        <ActiveFiltersHarness
          includeProjectFilter={true}
          initial={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            projectIds: [PROJECT_ID],
          }}
          usage={usageWithProject()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(PROJECT_CHIP_LABEL)).toBeVisible();
  });

  it("clearing the Project chip restores the unfiltered set", async () => {
    const user = userEvent.setup();
    render(
      <AppCoreStoryProviders>
        <ActiveFiltersHarness
          includeProjectFilter={true}
          initial={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            projectIds: [PROJECT_ID],
            statuses: [SESSION_STATUS.INACTIVE],
          }}
          usage={usageWithProject()}
        />
      </AppCoreStoryProviders>
    );

    await user.click(
      screen.getByRole("button", {
        name: `Remove ${PROJECT_CHIP_LABEL} filter`,
      })
    );

    expect(screen.queryByText(PROJECT_CHIP_LABEL)).not.toBeInTheDocument();
    // Only the Project narrowing went away; the co-active Status chip stays.
    expect(screen.getByText(STATUS_CHIP_LABEL)).toBeVisible();
  });

  it("renders no Project chip on a surface that does not offer the facet", () => {
    // The desktop cannot resolve cloud projects, so it never applies the filter.
    // A chip there would name a narrowing that never ran.
    render(
      <AppCoreStoryProviders>
        <ActiveFiltersHarness
          initial={{
            ...DEFAULT_SESSION_FACET_FILTERS,
            projectIds: [PROJECT_ID],
            statuses: [SESSION_STATUS.INACTIVE],
          }}
          usage={usageWithProject()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.queryByText(PROJECT_CHIP_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText(STATUS_CHIP_LABEL)).toBeVisible();
  });
});

function ActiveFiltersHarness({
  initial,
  usage,
  includeProjectFilter,
}: {
  initial: SessionFacetFilters;
  usage: ReturnType<typeof usageWithOwner>;
  includeProjectFilter?: boolean;
}) {
  const [filters, setFilters] = useState<SessionFacetFilters>(initial);
  return (
    <SessionsActiveFiltersBar
      filters={filters}
      includeProjectFilter={includeProjectFilter}
      onFiltersChange={setFilters}
      usage={usage}
    />
  );
}

function usageWithProject() {
  return createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Self, {
    byProject: [
      {
        projectId: PROJECT_ID,
        projectName: PROJECT_NAME,
        sessionCount: 9,
      },
    ],
  });
}
