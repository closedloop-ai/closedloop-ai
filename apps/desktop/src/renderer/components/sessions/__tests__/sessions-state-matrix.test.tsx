/**
 * ISS-9532 — the DESKTOP half of the Sessions state matrix.
 *
 * The cases live once in
 * `@repo/app/agents/components/sessions/__tests__/sessions-state-matrix-contract`;
 * `apps/app/components/agent-sessions/__tests__/sessions-state-matrix.test.tsx`
 * runs the identical cases over the identical fixtures against the web host.
 * This file owns only the Electron adapter: `SessionsView` in Cloud mode (the
 * signed-in, online baseline, where tags and favorites are wired), its mocked
 * read hooks, and the URL it reads page and page size from.
 *
 * The last block is the capability that exists on Desktop only: when the
 * renderer is offline it reads the local store, where a session id is not an
 * artifact id, and the write affordances are withheld.
 */

import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  editTagsName,
  favoriteControlName,
  SESSIONS_STATE_MATRIX_CONTRACT,
  type StateMatrixFixture,
  WRITABLE_TAGGED_FIXTURE,
} from "@repo/app/agents/components/sessions/__tests__/sessions-state-matrix-contract";
import {
  SESSIONS_PAGE_PARAM,
  SESSIONS_PAGE_SIZE_PARAM,
} from "@repo/app/agents/lib/session-pagination";
import {
  DESKTOP_HOST,
  runBothHostContract,
} from "@repo/app/shared/testing/both-host-render-contract";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { stubResponsiveNarrowViewport } from "@repo/app/test/mocks/responsive-narrow-viewport";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  DesktopAppCoreMode,
  resolveDesktopAppCoreMode,
} from "../../../shared-agent-sessions/desktop-app-core-mode";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

/**
 * Registered here, ahead of every import, because the shared contract module
 * pulls the surface graph in before the render fixture's own flag mock is
 * registered; a module loaded in that window would otherwise bind the real,
 * provider-less hook and answer every gate closed.
 */
const flagState = vi.hoisted(() => ({ enabled: new Set<string>() }));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => flagState.enabled.has(key),
  useFeatureFlagEnabledOptional: (key: string) => flagState.enabled.has(key),
  useFeatureFlagGate: (key: string) => ({
    enabled: flagState.enabled.has(key),
    isReady: true,
  }),
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: flagState.enabled.has(key),
    isReady: true,
  }),
}));

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [], isError: false, isPending: false }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@closedloop-ai/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const WIDE_CONTAINER_PX = 1440;
const NARROW_CONTAINER_PX = 390;

const restorers: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  applyDefaultSessionsViewHooks();
  installDesktopApiStub({
    getLocalSessionSourceStatus: vi.fn().mockResolvedValue({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    }),
    onDbChanged: () => () => undefined,
  });
});

afterEach(() => {
  for (const restore of restorers.splice(0)) {
    restore();
  }
  restoreDesktopApi();
});

function enableFlags(enabledFlags: readonly string[]) {
  flagState.enabled = new Set(enabledFlags);
}

async function mountMatrixFixture(
  fixture: StateMatrixFixture,
  mode: DesktopAppCoreMode = DesktopAppCoreMode.Cloud
) {
  const hooks = sessionsViewHookMocks();
  const narrow = fixture.narrow === true;
  restorers.push(
    stubContainerWidthPx(narrow ? NARROW_CONTAINER_PX : WIDE_CONTAINER_PX)
  );
  if (narrow) {
    restorers.push(stubResponsiveNarrowViewport(true).restore);
  }
  enableFlags(fixture.enabledFlags);
  hooks.useDesktopAppCoreMode.mockReturnValue(mode);
  hooks.useSessionsViewState.mockReturnValue({
    columnOrder: undefined,
    groupBy: "none",
    hiddenSummaryCards: new Set<string>(),
    isViewReady: true,
    resetView: vi.fn(),
    secondarySorts: [],
    setColumnOrder: vi.fn(),
    setGroupBy: vi.fn(),
    setSecondarySorts: vi.fn(),
    setSort: vi.fn(),
    sortDir: "desc",
    sortKey: null,
    toggleColumn: vi.fn(),
    toggleSummaryCard: vi.fn(),
    visibleColumns: new Set<string>(fixture.visibleColumns),
  });
  const params = new URLSearchParams();
  if (fixture.pageIndex) {
    params.set(SESSIONS_PAGE_PARAM, String(fixture.pageIndex + 1));
  }
  if (fixture.pageSize) {
    params.set(SESSIONS_PAGE_SIZE_PARAM, String(fixture.pageSize));
  }
  hooks.useSearchParamsValue.mockReturnValue(params);
  hooks.useAgentSessionsPageData.mockReturnValue({
    data: {
      list: {
        items: [...fixture.items],
        readSource: "cloud",
        total: fixture.total ?? fixture.items.length,
        viewerScope: AgentSessionViewerScope.Self,
      },
    },
    isError: false,
    isFetching: false,
    isLoading: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });
  await renderSessionsView();
}

runBothHostContract<StateMatrixFixture>({
  contract: SESSIONS_STATE_MATRIX_CONTRACT,
  host: DESKTOP_HOST,
  mount: (fixture) => mountMatrixFixture(fixture),
});

describe("offline withholds the writes only a workspace read can complete (Desktop-only)", () => {
  it.each([
    { isOnline: true, offersWrites: true },
    { isOnline: false, offersWrites: false },
  ])(
    "isOnline=$isOnline: lists the row and offers the star and tags editor = $offersWrites",
    async ({ isOnline, offersWrites }) => {
      const onlineDescriptor = Object.getOwnPropertyDescriptor(
        window.navigator,
        "onLine"
      );
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        get: () => isOnline,
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

      // The mode is derived from the connectivity signal, not chosen: an
      // authenticated renderer that is offline reads the local store.
      await mountMatrixFixture(
        WRITABLE_TAGGED_FIXTURE,
        resolveDesktopAppCoreMode({
          isOnline,
          status: DesktopAuthStatus.Authenticated,
        })
      );

      expect(await screen.findByText(item.name ?? "")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: favoriteControlName(item) }) !==
          null
      ).toBe(offersWrites);
      expect(
        screen.queryByRole("button", { name: editTagsName(item) }) !== null
      ).toBe(offersWrites);
    }
  );
});
