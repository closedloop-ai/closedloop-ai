/**
 * ISS-11274 — the desktop Branches list carries no standalone connect ask, and
 * the stalled-load slot (ISS-10645) is the one that reports its handoff's
 * outcome. So the outcome of that handoff has to travel with it: a
 * refused sign-in or a connect that never opened settles in this renderer, and
 * nothing else on Branches would show it.
 *
 * This pins the HOST half — that `BranchesView` supplies `stallCta.connectOutcome`
 * and wires it to the live connect state — by capturing the one prop the host
 * passes and driving the real `useDesktopGitHubConnect` leg through it. Drop the
 * `connectOutcome` wiring and the second case goes green-to-red on the copy.
 */

import {
  type BranchAnalytics,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesStallCta } from "@repo/app/branches/components/branches-stall-cta";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSurfacePageNounsNamedIn } from "../../../shared-branches/__tests__/connect-status-page-noun-fixture";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectMessage,
} from "../../../shared-branches/desktop-github-connect-copy";
import { DesktopGitHubConnectState } from "../use-desktop-github-connect";
import { renderView, wireRow } from "./test-helpers";

const { openGitHubConnectMock, useDesktopAuthMock, stallCtaMock } = vi.hoisted(
  () => ({
    openGitHubConnectMock: vi.fn(),
    useDesktopAuthMock: vi.fn(),
    stallCtaMock: vi.fn(),
  })
);

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
// The stalled slot only mounts at a hard stall phase, which is not what this
// covers. Capturing the host's `stallCta` and rendering its outcome directly is
// the same wiring without the elapsed-time setup — and the trigger comes from
// the captured `githubConnect`, so the leg under test is the production one.
vi.mock("@repo/app/branches/components/branches-list-surface-v2", () => ({
  BranchesListSurfaceV2: ({ stallCta }: { stallCta?: BranchesStallCta }) => {
    stallCtaMock(stallCta);
    return (
      <div>
        <button
          onClick={() => stallCta?.githubConnect?.onConnect?.()}
          type="button"
        >
          {STALL_CONNECT_TRIGGER_LABEL}
        </button>
        {stallCta?.connectOutcome}
      </div>
    );
  },
}));

const STALL_CONNECT_TRIGGER_LABEL = "Stall connect";
/**
 * The canonical list-surface copy for a connect that could not be opened, read
 * from the one map the renderer uses rather than spelled here.
 */
const FAILED_OUTCOME =
  desktopGitHubConnectMessage(
    DesktopGitHubConnectState.Failed,
    DesktopGitHubConnectSurface.StalledList
  )?.message ?? "";
/**
 * ISS-11326: what the POPULATED list surfaces say on the same state. This slot
 * renders only while the blocking read has produced nothing, so it must not
 * borrow their retained-data line — the case below asserts this string is absent
 * from the screen, which is the half a shared-variant regression would break.
 */
const POPULATED_LIST_FAILED_OUTCOME =
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

describe("BranchesView stalled-load connect outcome (ISS-11274)", () => {
  it("says nothing about a handoff the reader never made", async () => {
    renderView(dataSource);

    expect(
      await screen.findByRole("button", { name: STALL_CONNECT_TRIGGER_LABEL })
    ).toBeDefined();
    expect(screen.queryByText(FAILED_OUTCOME)).toBeNull();
  });

  it("reports a connect that could not be opened", async () => {
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", { name: STALL_CONNECT_TRIGGER_LABEL })
    );

    expect(await screen.findByText(FAILED_OUTCOME)).toBeDefined();
  });

  /**
   * ISS-11326: this slot's sentence may not name Branches either — a Branches
   * banner saying "Branches" earns nothing and comes back wrong the moment a
   * second list stalls. What this pins is which VARIANT the view passes: the
   * stalled wording is on screen and the populated surfaces' retained-data line,
   * which this screen cannot back, is not. The wording itself is the copy map's
   * own suite; `DesktopStatusBanner` renders the message as its div's only child,
   * so the node's text cannot differ from the constant that located it.
   */
  it("reports it without naming a page, Branches included, and without claiming data is on screen", async () => {
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", { name: STALL_CONNECT_TRIGGER_LABEL })
    );

    const rendered =
      (await screen.findByText(FAILED_OUTCOME)).textContent ?? "";

    expect(rendered.trim().length).toBeGreaterThan(0);
    expect(listSurfacePageNounsNamedIn(rendered)).toEqual([]);
    // The two strings differ, so this is a real exclusion rather than a
    // tautology: the populated surfaces' retained-data line must not reach a
    // screen where the blocking read has produced nothing (ISS-11326).
    expect(POPULATED_LIST_FAILED_OUTCOME).not.toBe(FAILED_OUTCOME);
    expect(screen.queryByText(POPULATED_LIST_FAILED_OUTCOME)).toBeNull();
  });
});
