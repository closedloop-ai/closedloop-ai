/**
 * ISS-11426 — the MOUNT, which the alert's own suite stays green without.
 *
 * `compute-target-link-block-alert.test.tsx` renders the component directly, so
 * deleting the element from Settings → Relay / Gateway leaves it passing while
 * the surface shows nothing and the user is never offered the relink. This
 * drives the real block, through its shipped panel, against a runtime-status
 * payload carrying the refusal, with no feature-flag adapter installed: the
 * alert is ungated per the operator ruling "ISS-11426 - this should not be
 * behind a FF" (2026-10-05).
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetRuntimeStatusPollForTests } from "../../../hooks/use-runtime-status-poll";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { COMPUTE_TARGET_LINK_BLOCK_TITLE } from "../compute-target-link-block-copy";
import { desktopAppPanelMountReads } from "./desktop-app-panel-mount-reads";

const BLOCK = {
  refusedComputeTargetId: "target-1",
  refusedBatchCount: 5131,
  firstRefusedAt: "2026-09-26T17:00:00.000Z",
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  __resetRuntimeStatusPollForTests();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

function installDesktopApi(
  readLinkBlock: () => unknown,
  firstPollGate?: Promise<void>
): void {
  const getRuntimeStatus = vi.fn(async () => ({
    computeTargetLinkBlock: readLinkBlock(),
  }));
  if (firstPollGate) {
    getRuntimeStatus.mockImplementationOnce(async () => {
      await firstPollGate;
      return { computeTargetLinkBlock: readLinkBlock() };
    });
  }
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { ...desktopAppPanelMountReads(), getRuntimeStatus },
  });
}

function renderRelayGatewayTab(): void {
  render(
    <DesktopAuthProvider>
      <DesktopAppPanel />
    </DesktopAuthProvider>
  );
}

describe("Settings → Relay / Gateway compute-target link block", () => {
  it("mounts the alert when the runtime status reports a block", async () => {
    installDesktopApi(() => BLOCK);

    renderRelayGatewayTab();

    await waitFor(() =>
      expect(screen.getByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeTruthy()
    );
  });

  it("shows nothing when the runtime status reports no block", async () => {
    let releaseFirstPoll = (): void => undefined;
    const firstPollGate = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve;
    });
    installDesktopApi(() => null, firstPollGate);

    renderRelayGatewayTab();

    // The tab is subscribed and its own payload is still held. Red here means
    // the shared poll replayed an earlier case's status into this mount.
    await waitFor(() =>
      expect(window.desktopApi.getRuntimeStatus).toHaveBeenCalled()
    );
    expect(screen.queryByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeNull();

    // Await this case's own payload, not just the call, so the assertion is
    // about the null block rather than about render timing.
    await act(async () => {
      releaseFirstPoll();
      await vi.mocked(window.desktopApi.getRuntimeStatus).mock.results[0]
        ?.value;
    });
    expect(screen.queryByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeNull();
  });

  it("RAISES the alert on a block that latches while the panel is already open", async () => {
    // The mount-time `runtime` snapshot this replaced could not: the block
    // latches at sync time, so a tab opened before the first refusal would
    // never show one (codex review). The payload starts clean and turns
    // blocked, with no remount.
    let linkBlock: unknown = null;
    installDesktopApi(() => linkBlock);

    renderRelayGatewayTab();
    await waitFor(() =>
      expect(window.desktopApi.getRuntimeStatus).toHaveBeenCalled()
    );
    expect(screen.queryByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeNull();

    linkBlock = BLOCK;

    await waitFor(
      () =>
        expect(screen.getByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeTruthy(),
      {
        timeout: 5000,
      }
    );
  });

  it("DROPS the alert once the block clears, without waiting for a remount", async () => {
    // The other half of the same defect: a user who relinks must stop being told
    // they have not. A stale alert here is the UI lying about state on the one
    // surface whose job is to report it.
    let linkBlock: unknown = BLOCK;
    installDesktopApi(() => linkBlock);

    renderRelayGatewayTab();
    await waitFor(() =>
      expect(screen.getByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeTruthy()
    );

    linkBlock = null;

    await waitFor(
      () =>
        expect(screen.queryByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeNull(),
      {
        timeout: 5000,
      }
    );
  });
});
