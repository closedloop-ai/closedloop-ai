/**
 * tamsinb, ISS-12638: the summary strip's connect ask fires the same handoff
 * the stalled-load slot does, but that slot mounts only while the blocking read
 * has produced nothing — so on a LOADED list a refused sign-in, or a connect
 * that never opened, had nothing on screen to report it and the click looked
 * like it went nowhere.
 *
 * This pins the HOST half: that `BranchesView` supplies the band's
 * `githubConnectOutcome` and wires it to the live connect state. The slot's own
 * rendering is `branches-list-summary-band.test.tsx`; the wording is the copy
 * map's suite. The scaffold below mirrors `branches-view-stall-connect-outcome`
 * deliberately, so these assertions run under the environment those already
 * pass under.
 */

import {
  type BranchAnalytics,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectMessage,
} from "../../../shared-branches/desktop-github-connect-copy";
import { DesktopGitHubConnectState } from "../use-desktop-github-connect";
import { renderView, wireRow } from "./test-helpers";

const { openGitHubConnectMock, useDesktopAuthMock } = vi.hoisted(() => ({
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
// A settled DISCONNECTED status, so the host resolves a real connect action.
// Left to the inert API adapter it never lands, and an unread status resolves to
// no action at all — which is the production gate, not this file's subject.
vi.mock(
  "@repo/app/github/hooks/use-github-integration",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/github/hooks/use-github-integration")
    >()),
    useGitHubIntegrationStatus: () => ({ data: DISCONNECTED_STATUS }),
  })
);
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
// The band's own slot rendering is covered in `packages/app`; what this file
// needs from the surface is the pair of props the host hands it, with the
// trigger coming from the captured target so the leg under test is production's.
vi.mock("@repo/app/branches/components/branches-list-surface-v2", () => ({
  BranchesListSurfaceV2: ({
    githubConnect,
    githubConnectOutcome,
  }: {
    githubConnect?: GitHubConnectTarget;
    githubConnectOutcome?: ReactNode;
  }) => (
    <div>
      <button onClick={() => githubConnect?.onConnect?.()} type="button">
        {STRIP_CONNECT_TRIGGER_LABEL}
      </button>
      {githubConnectOutcome}
    </div>
  ),
}));

const DISCONNECTED_STATUS = {
  connected: false as const,
  githubDataConnection: {
    connected: false,
    sources: [],
    oauthRequiredReasons: [],
  },
};

const STRIP_CONNECT_TRIGGER_LABEL = "Strip connect";
/**
 * The POPULATED list surfaces' copy for a connect that could not be opened,
 * read from the one map the renderer uses. `list`, not `stalledList`: the band
 * draws beside rendered content, so it takes the variant that may speak about
 * retained data.
 */
const FAILED_OUTCOME =
  desktopGitHubConnectMessage(
    DesktopGitHubConnectState.Failed,
    DesktopGitHubConnectSurface.List
  )?.message ?? "";

const listMock = vi.fn();
const dataSource: BranchesDataSource = {
  scope: "local",
  list: listMock,
  detail: () => new Promise<never>(() => undefined),
  comments: () => new Promise<never>(() => undefined),
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  pageData: async (filters) => ({
    list: await listMock(filters),
    analytics: makeBranchAnalytics(),
  }),
};

let desktopApiDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({
    items: [wireRow],
    total: 1,
    viewerScope: BranchViewerScope.Self,
  });
  openGitHubConnectMock.mockResolvedValue({ ok: false, reason: "open_failed" });
  useDesktopAuthMock.mockReturnValue({
    state: {
      status: "authenticated",
      userId: "user-1",
      organizationId: "org-1",
    },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
  });
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
});

afterEach(() => {
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("BranchesView summary-strip connect outcome (ISS-12638)", () => {
  it("says nothing about a handoff the reader never made", async () => {
    renderView(dataSource);

    expect(
      await screen.findByRole("button", { name: STRIP_CONNECT_TRIGGER_LABEL })
    ).toBeDefined();
    expect(FAILED_OUTCOME.length).toBeGreaterThan(0);
    expect(screen.queryByText(FAILED_OUTCOME)).toBeNull();
  });

  it("reports a connect that could not be opened, on a list that drew", async () => {
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", { name: STRIP_CONNECT_TRIGGER_LABEL })
    );

    expect(await screen.findByText(FAILED_OUTCOME)).toBeDefined();
  });
});
