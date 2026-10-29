import { sessionsRangeSentence } from "@repo/app/agents/lib/sessions-range-readout";
import { SESSION_COUNT_SITE } from "@repo/app/shared/counts/session-count-population-reconciliation";
import { SESSION_COUNT_SITE_DECLARING_MODULES } from "@repo/app/shared/counts/session-count-render-site";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

vi.mock(
  "@repo/app/agents/components/sessions/use-sessions-registered-bulk-actions",
  () => ({
    useSessionsRegisteredBulkActions: () => ({
      actions: [],
      confirmationDialog: "TEST ONLY: Desktop confirmation slot",
    }),
  })
);

/**
 * ISS-10660: the render half of the session-count site guard, for the desktop
 * Sessions host (`sessions-v2-view.tsx`, the this-device list footer).
 *
 * `packages/app/shared/counts/__tests__/session-count-site-wiring.test.ts`
 * proves the host NAMES its site; only a mount can show it still DRAWS the
 * count. This mounts `SessionsView` through the shared fixture, which leaves
 * the v2 surface REAL, hands it a local read whose total exceeds the rows on the
 * page, and observes the footer sentence. A host that stopped handing its
 * `total` through — or counted the page's rows instead — renders a different
 * sentence and reddens here, with no JSX element or host symbol named.
 *
 * The host's exported site constant is deliberately NOT imported: the fixture
 * registers its `vi.mock`s when IT is evaluated, so importing the host module
 * ahead of it could load the host's dependencies unmocked. The registry row is
 * asserted instead, by module path.
 */

const HOST_MODULE =
  "apps/desktop/src/renderer/components/sessions/sessions-v2-view.tsx";
/** Rows this machine's store matched across every page. */
const STORE_TOTAL = 240;
const WIDE_CONTAINER_PX = 1440;
const ROWS = [{ id: "ses-1" }, { id: "ses-2" }];

let restoreContainerWidth: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  applyDefaultSessionsViewHooks();
  sessionsViewHookMocks().useFeatureFlagEnabled.mockImplementation(() => false);
  installDesktopApiStub({
    getLocalSessionSourceStatus: vi.fn().mockResolvedValue({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    }),
    onDbChanged: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  restoreDesktopApi();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("ISS-10660: the desktop Sessions host draws the this-device list-footer count", () => {
  it("is the module the registry names for the this-device footer", () => {
    expect(
      SESSION_COUNT_SITE_DECLARING_MODULES[
        SESSION_COUNT_SITE.SessionsListFooterThisDevice
      ]
    ).toContain(HOST_MODULE);
  });

  it("renders the store total it is handed, not the rows on the page", async () => {
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: { list: { ...listWith(ROWS), total: STORE_TOTAL } },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });

    await renderSessionsView();

    expect(
      screen.getByText(
        sessionsRangeSentence({ from: 1, to: ROWS.length }, STORE_TOTAL)
      )
    ).toBeTruthy();
    expect(
      screen.getByText("TEST ONLY: Desktop confirmation slot")
    ).toBeTruthy();
  });
});
