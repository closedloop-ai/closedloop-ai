/**
 * ISS-9544 — the WEB half of the Sessions both-host contract.
 *
 * The states live once in
 * `@repo/app/agents/components/sessions/__tests__/sessions-both-host-contract`;
 * `apps/desktop/src/renderer/components/sessions/__tests__/sessions-both-host-contract.test.tsx`
 * runs the identical cases over the identical fixture against the Electron
 * shell. This file owns only the web adapter — the host, its providers, and the
 * favorites read the desktop shell has no artifact record for.
 */

import {
  SESSIONS_BOTH_HOST_CONTRACT,
  type SessionsBothHostFixture,
} from "@repo/app/agents/components/sessions/__tests__/sessions-both-host-contract";
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
import { render } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { SessionsListV2Host } from "@/components/agent-sessions/sessions-list-v2-host";

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [], isError: false, isPending: false }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/** Wide enough that the toolbar mounts its expanded cluster, not the fold. */
const WIDE_CONTAINER_PX = 1440;

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

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

runBothHostContract<SessionsBothHostFixture>({
  contract: SESSIONS_BOTH_HOST_CONTRACT,
  host: WEB_HOST,
  mount: (fixture) => {
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    render(
      <SessionsListV2Host
        getSessionHref={(item) => `/acme/sessions/${item.id}`}
        hostView={{
          ...HOST_VIEW,
          facets: fixture.statusFilter
            ? { ...HOST_VIEW.facets, statuses: [fixture.statusFilter] }
            : HOST_VIEW.facets,
        }}
        isListPending={false}
        items={[...fixture.items]}
        listReadState={SessionsListReadState.Settled}
        onHostViewChange={vi.fn()}
        onResetView={vi.fn()}
        pageSize={25}
        summaryIsLoading={false}
        total={fixture.total ?? fixture.items.length}
        usage={undefined}
      />,
      { wrapper: AppCoreStoryProviders }
    );
  },
});
