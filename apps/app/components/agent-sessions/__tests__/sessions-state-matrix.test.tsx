/**
 * ISS-9532 — the WEB half of the Sessions state matrix.
 *
 * The cases (unknown status, partial enrichment, finished-and-old, permission,
 * narrow, page two, Tags flag on/off) live once in
 * `@repo/app/agents/components/sessions/__tests__/sessions-state-matrix-contract`;
 * the Desktop half runs the identical cases over the identical fixtures. This
 * file owns only the web adapter: `SessionsListV2Host`, its providers and the
 * controlled view the page would persist.
 *
 * OFFLINE is a Desktop-only capability. The web host has no connectivity-driven
 * source swap, so the last case below records the gap by asserting the write
 * affordances (star and tags editor) stay offered while the browser reports itself offline. The day
 * the web host grows an offline mode, that case reddens instead of the gap
 * going unrecorded.
 */

import {
  editTagsName,
  favoriteControlName,
  SESSIONS_STATE_MATRIX_CONTRACT,
  type StateMatrixFixture,
  WRITABLE_TAGGED_FIXTURE,
} from "@repo/app/agents/components/sessions/__tests__/sessions-state-matrix-contract";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import type { SessionsHostViewState } from "@repo/app/agents/lib/sessions-list-view-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import {
  runBothHostContract,
  WEB_HOST,
} from "@repo/app/shared/testing/both-host-render-contract";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { stubResponsiveNarrowViewport } from "@repo/app/test/mocks/responsive-narrow-viewport";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionsListV2Host } from "@/components/agent-sessions/sessions-list-v2-host";

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [], isError: false, isPending: false }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const WIDE_CONTAINER_PX = 1440;
const NARROW_CONTAINER_PX = 390;
const DEFAULT_PAGE_SIZE = 25;

const restorers: Array<() => void> = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) {
    restore();
  }
});

function mountMatrixFixture(fixture: StateMatrixFixture) {
  const narrow = fixture.narrow === true;
  restorers.push(
    stubContainerWidthPx(narrow ? NARROW_CONTAINER_PX : WIDE_CONTAINER_PX)
  );
  if (narrow) {
    restorers.push(stubResponsiveNarrowViewport(true).restore);
  }
  const hostView: SessionsHostViewState = {
    dateRange: DEFAULT_DATE_RANGE,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    groupBy: SessionGroupBy.None,
    page: fixture.pageIndex ?? 0,
    scopeUserId: null,
    search: "",
    secondarySorts: [],
    sortDir: "asc",
    sortKey: null,
    visibleColumns: new Set(fixture.visibleColumns),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders enabledFlags={fixture.enabledFlags}>
      {children}
    </AppCoreStoryProviders>
  );
  render(
    <SessionsListV2Host
      getSessionHref={(item) => `/acme/sessions/${item.id}`}
      hostView={hostView}
      isListPending={false}
      items={[...fixture.items]}
      listReadState={SessionsListReadState.Settled}
      onHostViewChange={vi.fn()}
      onResetView={vi.fn()}
      pageSize={fixture.pageSize ?? DEFAULT_PAGE_SIZE}
      summaryIsLoading={false}
      total={fixture.total ?? fixture.items.length}
      usage={undefined}
    />,
    { wrapper }
  );
}

runBothHostContract<StateMatrixFixture>({
  contract: SESSIONS_STATE_MATRIX_CONTRACT,
  host: WEB_HOST,
  mount: mountMatrixFixture,
});

describe("web host has no offline mode (Desktop-only capability)", () => {
  it("keeps the favorite control and tags editor offered while the browser reports offline", async () => {
    const onlineDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "onLine"
    );
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    restorers.push(() => {
      if (onlineDescriptor) {
        Object.defineProperty(window.navigator, "onLine", onlineDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "onLine");
      }
    });
    const [item] = WRITABLE_TAGGED_FIXTURE.items;
    if (!item) {
      throw new Error("the writable fixture carries no row");
    }

    mountMatrixFixture(WRITABLE_TAGGED_FIXTURE);

    expect(
      await screen.findByRole("button", { name: favoriteControlName(item) })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: editTagsName(item) })
    ).toBeTruthy();
  });
});
