import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import { sessionsRangeSentence } from "@repo/app/agents/lib/sessions-range-readout";
import { SESSION_COUNT_SITE } from "@repo/app/shared/counts/session-count-population-reconciliation";
import { SESSION_COUNT_SITE_DECLARING_MODULES } from "@repo/app/shared/counts/session-count-render-site";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSIONS_LIST_FOOTER_COUNT_SITE,
  SessionsListV2Host,
} from "@/components/agent-sessions/sessions-list-v2-host";

/**
 * ISS-10660: the render half of the session-count site guard, for the web host.
 *
 * `session-count-site-wiring.test.ts` proves this module NAMES its site; it
 * cannot see whether the module still DRAWS the count, because `apps/app` and
 * `apps/desktop` do not depend on each other and no single suite can mount
 * both shells' hosts. So each declaring host carries its own render guard, and
 * this is the web list footer's.
 *
 * It mounts the host on the REAL `SessionsListSurfaceV2` and observes the
 * footer sentence. The server total is deliberately larger than the rows on the
 * page, so the only way the sentence carries it is the host handing its `total`
 * through: a host that dropped it, or counted the page's rows instead, renders
 * a different sentence and reddens here. Nothing below names a JSX element or a
 * source symbol of the host, so a rename does not.
 *
 * The expected sentence comes from the shared formatter on purpose: the
 * wording is that formatter's business and is pinned beside it. What this file
 * pins is that THIS host's number reaches it.
 */

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [], isError: false, isPending: false }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));
vi.mock(
  "@repo/app/agents/components/sessions/use-sessions-registered-bulk-actions",
  () => ({
    useSessionsRegisteredBulkActions: () => ({
      actions: [],
      confirmationDialog: "TEST ONLY: Web confirmation slot",
    }),
  })
);

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const HOST_MODULE =
  "apps/app/components/agent-sessions/sessions-list-v2-host.tsx";
/** Rows the server matched across every page: more than one page's worth. */
const SERVER_TOTAL = 240;
const PAGE_SIZE = 25;
const WIDE_CONTAINER_PX = 1440;

const ITEMS: readonly AgentSessionListItem[] = [
  createAgentSessionListItemFixture({ id: "ses-1", name: "agent/one" }),
  createAgentSessionListItemFixture({ id: "ses-2", name: "agent/two" }),
];

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("ISS-10660: the web Sessions host draws the org list-footer count", () => {
  it("is the module the registry names for the site it declares", () => {
    expect(SESSIONS_LIST_FOOTER_COUNT_SITE).toBe(
      SESSION_COUNT_SITE.SessionsListFooterOrg
    );
    expect(
      SESSION_COUNT_SITE_DECLARING_MODULES[SESSIONS_LIST_FOOTER_COUNT_SITE]
    ).toContain(HOST_MODULE);
  });

  it("renders the server total it is handed, not the rows on the page", () => {
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    render(
      <SessionsListV2Host
        getSessionHref={(item) => `/acme/sessions/${item.id}`}
        hostView={{
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
        }}
        isListPending={false}
        items={ITEMS}
        listReadState={SessionsListReadState.Settled}
        onHostViewChange={vi.fn()}
        pageSize={PAGE_SIZE}
        summaryIsLoading={false}
        total={SERVER_TOTAL}
        usage={undefined}
      />,
      { wrapper: AppCoreStoryProviders }
    );

    expect(
      screen.getByText(
        sessionsRangeSentence({ from: 1, to: ITEMS.length }, SERVER_TOTAL)
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("TEST ONLY: Web confirmation slot")
    ).toBeInTheDocument();
  });
});
