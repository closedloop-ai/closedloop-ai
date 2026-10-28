import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { AgentSessionBulkAssignField } from "@repo/api/src/types/agent-session-bulk-assign";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import {
  ArtifactTagAvailability,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import type { SessionsHostViewState } from "@repo/app/agents/lib/sessions-list-view-adapter";
import {
  ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY,
  ARTIFACT_TAGS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import {
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_LABEL,
} from "@repo/app/tags/lib/bulk-tag-labels";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsListV2Host } from "@/components/agent-sessions/sessions-list-v2-host";

/**
 * ISS-8335 (codex review cid 3880961552) — the host driving the REAL
 * `SessionsListSurfaceV2`.
 *
 * The sibling `sessions-list-v2-host-view-axes.test.tsx` replaces the surface
 * with a null-returning probe. That is the right shape for the seam it pins —
 * what the host reports in, it must hand back out, asserted per axis — but it
 * is structurally incapable of catching a defect that only exists once real
 * controls are on screen: a reset that leaves the host's own axes behind, or a
 * control still rendering after the surface retired it. A probe that renders
 * nothing has no menu to reset from and no toolbar to be missing a control.
 *
 * So this file mounts the whole thing and drives the controls a reader touches:
 * the Options menu's Reset view and the row star. Every assertion runs in the
 * test body after the production interaction.
 */

const RESET_ITEM_NAME = "Reset view";
const OPTIONS_MENU_NAME = "Options";
const ROW_LAYOUT_NAME = "Row layout";
const FAVORITE_CONTROL_PATTERN = /favorites$/;
// Wide enough that the toolbar mounts its expanded cluster rather than the
// folded `TableCompactViewMenu`, which is a different control set.
const WIDE_CONTAINER_PX = 1440;

const favoritesQueryResult: {
  data: readonly { id: string }[] | undefined;
  isError: boolean;
  isPending: boolean;
} = { data: [], isError: false, isPending: false };

const FAVORITE_HEADER_NAME = "Favorite";

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => favoritesQueryResult,
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const ITEMS: readonly AgentSessionListItem[] = [
  createAgentSessionListItemFixture({ id: "ses-1", name: "agent/one" }),
  createAgentSessionListItemFixture({ id: "ses-2", name: "agent/two" }),
];
const RECONCILIATION_ITEMS: readonly AgentSessionListItem[] = [
  createAgentSessionListItemFixture({
    id: "ses-active",
    name: "agent/active",
    status: SESSION_STATUS.ACTIVE,
  }),
  createAgentSessionListItemFixture({
    id: "ses-inactive",
    name: "agent/inactive",
    status: SESSION_STATUS.INACTIVE,
  }),
];
const ACTIVE_STATUS_PATTERN = new RegExp(
  SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
);
const ERROR_STATUS_PATTERN = new RegExp(
  SESSION_STATUS_LABELS[SESSION_STATUS.ERROR]
);

const HOST_VIEW: SessionsHostViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  groupBy: SessionGroupBy.None,
  page: 0,
  scopeUserId: null,
  search: "",
  secondarySorts: [],
  sortDir: "asc",
  sortKey: null,
  visibleColumns: new Set(["status"]),
};

/**
 * The page's half of the contract, as `sessions/page.tsx` implements it: it
 * stores what the host reports, feeds it back, and its "Reset view" restores
 * ONLY what it persists. That last part is the whole point — a reset handler
 * that also cleared the host's local axes would hide the defect.
 */
function HostUnderTest({
  items = ITEMS,
}: {
  items?: readonly AgentSessionListItem[];
} = {}) {
  const [hostView, setHostView] = useState(HOST_VIEW);
  const resetView = useCallback(() => setHostView(HOST_VIEW), []);
  const displayedItems = items.filter(
    (item) =>
      (hostView.search.length === 0 ||
        item.name?.toLowerCase().includes(hostView.search.toLowerCase()) ===
          true) &&
      (hostView.facets.statuses.length === 0 ||
        hostView.facets.statuses.includes(item.status))
  );
  return (
    <SessionsListV2Host
      getSessionHref={(item) => `/acme/sessions/${item.id}`}
      hostView={hostView}
      isListPending={false}
      items={displayedItems}
      listReadState={SessionsListReadState.Settled}
      onHostViewChange={setHostView}
      onResetView={resetView}
      pageSize={25}
      summaryIsLoading={false}
      total={displayedItems.length}
      usage={undefined}
    />
  );
}

let restoreContainerWidth: (() => void) | null = null;

function renderHost(items: readonly AgentSessionListItem[] = ITEMS) {
  restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
  return render(<HostUnderTest items={items} />, {
    wrapper: AppCoreStoryProviders,
  });
}

/** Radix dropdowns open on `pointerdown`, not `click`. */
function openOptionsMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: OPTIONS_MENU_NAME }),
    { button: 0, ctrlKey: false }
  );
}

beforeEach(() => {
  favoritesQueryResult.data = [];
  favoritesQueryResult.isError = false;
  favoritesQueryResult.isPending = false;
});

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListV2Host on the real surface", () => {
  it.each([
    { label: BULK_TAG_ACTION_LABEL, route: "/entity-tags/batch/v2" },
    {
      label: BULK_REMOVE_TAG_ACTION_LABEL,
      route: "/entity-tags/batch-remove/v2",
    },
  ])("retains refused rows after flagged $label", async ({ label, route }) => {
    const tag = {
      id: "tag-backend",
      name: "backend",
      color: TagColor.Blue,
      organizationId: "org_test",
      createdById: "user_test",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
    const rows = ITEMS.map((item) => ({
      ...item,
      tags: [tag],
      tagAvailability: ArtifactTagAvailability.Available,
      tagPermissions: { canApply: true, canRemove: true },
    }));
    const writes: unknown[] = [];
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    const { container } = render(
      <AppCoreStoryProviders
        apiRoutes={[
          { method: "GET", path: "/projects", respond: () => [] },
          { method: "GET", path: "/users", respond: () => [] },
          { method: "GET", path: "/tags", respond: () => [tag] },
          {
            method: "POST",
            path: route,
            respond: ({ body }) => {
              writes.push(body);
              return {
                results: [
                  batchItemApplied(rows[0]!.id),
                  batchItemFailed(
                    rows[1]!.id,
                    BatchItemFailureCode.ArtifactsNotFound
                  ),
                ],
              };
            },
          },
        ]}
        enabledFlags={[
          ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY,
          SESSIONS_ARTIFACT_TAGS_FLAG_KEY,
        ]}
      >
        <HostUnderTest items={rows} />
      </AppCoreStoryProviders>
    );
    const first = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${rows[0]!.id}"]`
    );
    const second = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${rows[1]!.id}"]`
    );
    if (!(first && second)) {
      throw new Error("Missing tagged Session rows");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: label }));
    await user.click(await screen.findByRole("button", { name: tag.name }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(second).toHaveAttribute("aria-selected", "true");
  });
  it.each([
    {
      label: "Move to project",
      option: "Platform",
      field: AgentSessionBulkAssignField.Project,
      value: "project-1",
    },
    {
      label: "Assign owner",
      option: "ada@example.com",
      field: AgentSessionBulkAssignField.Owner,
      value: "user-1",
    },
  ])(
    "retains only refused Session rows after $label",
    async ({ label, option, field, value }) => {
      const writes: unknown[] = [];
      restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
      const { container } = render(
        <AppCoreStoryProviders
          apiRoutes={[
            {
              method: "GET",
              path: "/projects",
              respond: () => [{ id: "project-1", name: "Platform" }],
            },
            {
              method: "GET",
              path: "/users",
              respond: () => [{ id: "user-1", email: "ada@example.com" }],
            },
            {
              method: "POST",
              path: `${BatchMutationRoute.AgentSessionsAssign}/v2`,
              respond: ({ body }) => {
                writes.push(body);
                return {
                  results: [
                    batchItemApplied(ITEMS[0]!.id),
                    batchItemFailed(
                      ITEMS[1]!.id,
                      BatchItemFailureCode.ArtifactsNotFound
                    ),
                  ],
                };
              },
            },
          ]}
          enabledFlags={[ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY]}
        >
          <HostUnderTest />
        </AppCoreStoryProviders>
      );
      const first = container.querySelector<HTMLElement>(
        `[data-grid-row-id="${ITEMS[0]!.id}"]`
      );
      const second = container.querySelector<HTMLElement>(
        `[data-grid-row-id="${ITEMS[1]!.id}"]`
      );
      if (!(first && second)) {
        throw new Error("Missing selected Session rows");
      }
      fireEvent.click(first);
      fireEvent.click(second, { ctrlKey: true });
      const user = userEvent.setup({ delay: null });
      await user.click(await screen.findByRole("button", { name: label }));
      await user.click(await screen.findByRole("button", { name: option }));
      await waitFor(() =>
        expect(writes).toEqual([
          { sessionIds: ITEMS.map((item) => item.id), field, value },
        ])
      );
      await waitFor(() => {
        expect(first).toHaveAttribute("aria-selected", "false");
        expect(second).toHaveAttribute("aria-selected", "true");
      });
    }
  );
  it("uses the flagged registry once and stars a mixed selection to one state", async () => {
    favoritesQueryResult.data = [{ id: ITEMS[0]!.id }];
    const favoriteWrites: unknown[] = [];
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    const { container } = render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/projects",
            respond: () => [{ id: "project-1", name: "Platform" }],
          },
          {
            method: "GET",
            path: "/users",
            respond: () => [{ id: "user-1", email: "ada@example.com" }],
          },
          {
            method: "POST",
            path: BatchMutationRoute.ArtifactsFavorites,
            respond: ({ body }) => {
              favoriteWrites.push(body);
              return {
                results: [
                  batchItemApplied(ITEMS[0]!.id),
                  batchItemFailed(
                    ITEMS[1]!.id,
                    BatchItemFailureCode.ArtifactsNotFound
                  ),
                ],
              };
            },
          },
        ]}
        enabledFlags={[ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY]}
      >
        <HostUnderTest />
      </AppCoreStoryProviders>
    );
    const first = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${ITEMS[0]!.id}"]`
    );
    const second = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${ITEMS[1]!.id}"]`
    );
    if (!(first && second)) {
      throw new Error("Missing selected Session rows");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    await screen.findByRole("button", { name: "Move to project" });
    expect(screen.getByRole("button", { name: "Assign owner" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Change status" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Favorite sessions" })
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Favorite sessions" }));
    await waitFor(() =>
      expect(favoriteWrites).toEqual([
        { artifactIds: ITEMS.map((item) => item.id), favorite: true },
      ])
    );
    await waitFor(() => {
      expect(first).toHaveAttribute("aria-selected", "false");
      expect(second).toHaveAttribute("aria-selected", "true");
    });
  });
  it("returns a grouped table to ungrouped when the reader resets the view", async () => {
    const user = userEvent.setup();
    renderHost();

    await user.click(
      screen.getByRole("button", { name: "Status column options" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Group" }));
    expect(screen.getByRole("button", { name: "Groups: 1" })).toBeVisible();

    openOptionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: RESET_ITEM_NAME }));

    // ISS-8633: the end-to-end path the Board-layout case used to walk — a real
    // header menu groups the table, the real Options menu resets it, and the
    // surface comes back ungrouped. It pins the WIRING, not the host's local
    // clear: the page's `groupBy` moves here, so `reconcileSessionsGrouping`
    // would ungroup the table on its own (cr-33230). The local clear is pinned
    // where the primary dimension holds still, in the sibling view-axes suite.
    expect(screen.getByRole("button", { name: "Group" })).toBeVisible();
  });

  it("mounts the selection announcer, so the web host can state a count at all", () => {
    // ISS-9574, the host half (davetho, PR #7320). The surface renders the
    // announcer only where a selection model exists, so a host that stopped
    // supplying one would take the region with it and every assertion in
    // `sessions-list-surface-v2-selection-announcement.test.tsx` would stay
    // green about a component this page no longer reaches that way.
    renderHost();

    // ISS-9610 adds a separately owned list-update region. This assertion
    // remains scoped to the selection announcer's output contract.
    const regions = Array.from(
      document.querySelectorAll<HTMLElement>("output[aria-live]")
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toBe("No sessions selected");
  });

  it("reconciles group collapse and filter-empty through the real web host", async () => {
    const user = userEvent.setup();
    renderHost(RECONCILIATION_ITEMS);

    await user.click(
      screen.getByRole("button", { name: "Status column options" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Group" }));
    fireEvent.click(sessionRow("ses-active"));
    fireEvent.click(sessionRow("ses-inactive"), { ctrlKey: true });

    const activeToggle = groupToggle(ACTIVE_STATUS_PATTERN);
    await user.click(activeToggle);
    await user.click(activeToggle);
    expect(sessionRow("ses-active")).toHaveAttribute("aria-selected", "false");
    expect(sessionRow("ses-inactive")).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.hover(screen.getByRole("menuitem", { name: "Status" }));
    await user.click(
      await screen.findByRole("menuitem", { name: ERROR_STATUS_PATTERN })
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-grid-row-id="ses-inactive"]')
      ).toBeNull()
    );
    expect(
      screen.getByRole("status", { name: "No sessions selected" })
    ).toBeInTheDocument();
  });

  it("offers the star on a healthy mount, and no layout toggle", () => {
    renderHost();

    // The positive sibling for the absences below and in the favorites cases:
    // this mount really does render its controls, so a `queryBy...` returning
    // null is the branch under test rather than a surface that failed to mount.
    expect(
      screen.getAllByRole("button", { name: FAVORITE_CONTROL_PATTERN }).length
    ).toBeGreaterThan(0);
    // ISS-8633: the Board layout and its toggle are gone on this host too.
    expect(
      screen.queryByRole("radiogroup", { name: ROW_LAYOUT_NAME })
    ).not.toBeInTheDocument();
  });

  it("renders no favorite control when the favorites read failed, but keeps its column", () => {
    favoritesQueryResult.data = undefined;
    favoritesQueryResult.isError = true;
    renderHost();

    // Not "unstarred": ABSENT. A star rendered off a failed read states that
    // these sessions are not favorited, which is a claim the host cannot make,
    // and clicking it would submit the add path against that claim.
    expect(
      screen.queryByRole("button", { name: FAVORITE_CONTROL_PATTERN })
    ).toBeNull();
    // The COLUMN stays (Pascoe review). Dropping the track shifts every column,
    // and neither error nor pending is terminal — a refetch clears both — so
    // withholding the controller outright would move the table under the reader
    // mid-session.
    expect(
      screen.getByRole("columnheader", { name: FAVORITE_HEADER_NAME })
    ).toBeInTheDocument();
  });

  it("renders no favorite control while the favorites read is still pending", () => {
    favoritesQueryResult.data = undefined;
    favoritesQueryResult.isPending = true;
    renderHost();

    // The same lie over a shorter interval: a click in the cold-load window
    // submits the add path for a session that may already be favorited.
    expect(
      screen.queryByRole("button", { name: FAVORITE_CONTROL_PATTERN })
    ).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: FAVORITE_HEADER_NAME })
    ).toBeInTheDocument();
  });

  it("routes bulk tag selection through the real web host to canonical artifacts", async () => {
    const rows = ITEMS.map((item) => ({
      ...item,
      tags: [],
      tagAvailability: ArtifactTagAvailability.Available,
      tagPermissions: { canApply: true, canRemove: false },
    }));
    const tag = {
      id: "tag-backend",
      name: "backend",
      color: TagColor.Blue,
      organizationId: "org_test",
      createdById: "user_test",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
    const writes: unknown[] = [];
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    const { container } = render(
      <AppCoreStoryProviders
        apiRoutes={[
          { method: "GET", path: "/tags", respond: () => [tag] },
          {
            method: "POST",
            path: "/entity-tags/batch/v2",
            respond: ({ body }) => {
              writes.push(body);
              return { results: rows.map((row) => batchItemApplied(row.id)) };
            },
          },
        ]}
        enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
      >
        <HostUnderTest items={rows} />
      </AppCoreStoryProviders>
    );
    const first = container.querySelector<HTMLElement>(
      '[data-grid-row-id="ses-1"]'
    );
    const second = container.querySelector<HTMLElement>(
      '[data-grid-row-id="ses-2"]'
    );
    if (!(first && second)) {
      throw new Error("Missing writable Session rows");
    }
    expect(screen.getByRole("grid")).toHaveAttribute(
      "aria-multiselectable",
      "true"
    );
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    const user = userEvent.setup({ delay: null });
    await user.click(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    await user.click(await screen.findByRole("button", { name: tag.name }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          tagId: tag.id,
          entityType: TagEntityType.Artifact,
          entityIds: ["ses-1", "ses-2"],
        },
      ])
    );
    // The picker closes and the selection stays (operator ruling on the
    // ISS-12305 review, Asana precedent).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: tag.name })).toBeNull()
    );
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
  });

  it("keeps denied rows selectable while refusing a mixed web bulk write", () => {
    const rows = ITEMS.map((item, index) => ({
      ...item,
      tags: [],
      tagAvailability: ArtifactTagAvailability.Available,
      tagPermissions:
        index === 0
          ? { canApply: true, canRemove: false }
          : { canApply: false, canRemove: false },
    }));
    const writes: unknown[] = [];
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    const { container } = render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch/v2",
            respond: ({ body }) => {
              writes.push(body);
              return { results: rows.map((row) => batchItemApplied(row.id)) };
            },
          },
        ]}
        enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
      >
        <HostUnderTest items={rows} />
      </AppCoreStoryProviders>
    );
    const first = container.querySelector<HTMLElement>(
      '[data-grid-row-id="ses-1"]'
    );
    const second = container.querySelector<HTMLElement>(
      '[data-grid-row-id="ses-2"]'
    );
    if (!(first && second)) {
      throw new Error("Missing mixed-permission Session rows");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("button", { name: "Session actions" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).toBeNull();
    expect(writes).toEqual([]);
  });

  it.each([
    { state: "absent", flags: undefined },
    { state: "off", flags: [] },
    { state: "wrong key", flags: [ARTIFACT_TAGS_FEATURE_FLAG_KEY] },
  ])(
    "does not offer or dispatch bulk tags when the exact web flag is $state (DT-G01)",
    ({ flags }) => {
      const writes: unknown[] = [];
      const rows = ITEMS.map((item) => ({
        ...item,
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
      }));
      restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
      const { container } = render(
        <AppCoreStoryProviders
          apiRoutes={[
            {
              method: "POST",
              path: "/entity-tags/batch/v2",
              respond: ({ body }) => {
                writes.push(body);
                return { results: rows.map((row) => batchItemApplied(row.id)) };
              },
            },
          ]}
          enabledFlags={flags}
        >
          <HostUnderTest items={rows} />
        </AppCoreStoryProviders>
      );
      const first = container.querySelector<HTMLElement>(
        '[data-grid-row-id="ses-1"]'
      );
      const second = container.querySelector<HTMLElement>(
        '[data-grid-row-id="ses-2"]'
      );
      if (!(first && second)) {
        throw new Error("Missing writable Session rows");
      }
      fireEvent.click(first);
      fireEvent.click(second, { ctrlKey: true });
      expect(
        screen.queryByRole("button", { name: BULK_TAG_ACTION_LABEL })
      ).toBeNull();
      expect(writes).toEqual([]);
    }
  );
});

function sessionRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-grid-row-id="${id}"]`);
  if (!row) {
    throw new Error(`Expected Session row ${id}`);
  }
  return row;
}

function groupToggle(name: RegExp): HTMLElement {
  const toggle = screen
    .getAllByRole("button", { name })
    .find((candidate) => candidate.hasAttribute("aria-expanded"));
  if (!toggle) {
    throw new Error(`Expected Session group toggle ${name.source}`);
  }
  return toggle;
}
