import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { buildSettingsPanelRoute } from "@repo/api/src/types/settings-route-links";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import {
  ComputeTargetLinkBlockAlert,
  type ComputeTargetLinkBlockView,
  parseComputeTargetLinkBlock,
} from "../compute-target-link-block-alert";
import {
  COMPUTE_TARGET_LINK_BLOCK_ACTION_LABEL,
  COMPUTE_TARGET_LINK_BLOCK_TITLE,
} from "../compute-target-link-block-copy";

// ISS-11426: the recovery affordance for a compute target the cloud refuses as
// not owned by the signed-in account. Ungated per the operator ruling
// "ISS-11426 - this should not be behind a FF" (2026-10-05), so no case here
// installs a feature-flag adapter: the alert must render with none.

const BLOCK: ComputeTargetLinkBlockView = {
  refusedComputeTargetId: "target-1",
  refusedBatchCount: 5131,
  firstRefusedAt: "2026-09-26T17:00:00.000Z",
};

function renderAlert(block: ComputeTargetLinkBlockView | null): void {
  render(<ComputeTargetLinkBlockAlert block={block} />);
}

describe("ComputeTargetLinkBlockAlert", () => {
  it("tells the user what happened, with no feature flag resolved", () => {
    renderAlert(BLOCK);

    expect(screen.getByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeTruthy();
  });

  it("renders nothing when nothing is blocked", () => {
    renderAlert(null);

    expect(screen.queryByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeNull();
  });

  it("withholds the action rather than offering a link it cannot build", () => {
    // No auth provider and no resolved web origin, which is how this test
    // mounts: the org slug is unknown, so the destination cannot be built and
    // the alert must still say what happened without a link that would 404.
    renderAlert(BLOCK);

    expect(screen.getByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeTruthy();
    expect(
      screen.queryByRole("link", {
        name: COMPUTE_TARGET_LINK_BLOCK_ACTION_LABEL,
      })
    ).toBeNull();
  });
});

describe("ComputeTargetLinkBlockAlert destination", () => {
  const originalDesktopApi = Object.getOwnPropertyDescriptor(
    window,
    "desktopApi"
  );

  afterEach(() => {
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
      return;
    }
    Reflect.deleteProperty(window, "desktopApi");
  });

  it("builds the org-scoped Connected Devices PANEL link from the CONFIGURED origin", async () => {
    // The org slug comes from whichever cloud this desktop points at, so pairing
    // it with a hardcoded host would link to someone else's org.
    //
    // The destination is the `?panel=` deep link (ISS-12784 R6) and NOT
    // `/settings/compute-targets`, which is not a page at all, so the path this
    // alert first shipped would have fallen through to `[...unmatched]` and
    // `notFound()`, offering a recovery action that 404s (tamsinb).
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getSettings: vi.fn(async () => ({
          webAppOrigin: "https://app.example.test",
        })),
        getDesktopIdentity: vi.fn(async () => ({
          organizationSlug: "acme",
        })),
        getDesktopAuthState: vi.fn(async () => ({
          status: DesktopAuthStatus.Authenticated,
          userId: "user-1",
        })),
        onDesktopAuthStateChanged: vi.fn(() => () => undefined),
      },
    });
    render(
      <DesktopAuthProvider>
        <ComputeTargetLinkBlockAlert block={BLOCK} />
      </DesktopAuthProvider>
    );

    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: COMPUTE_TARGET_LINK_BLOCK_ACTION_LABEL })
          .getAttribute("href")
      ).toBe(
        `https://app.example.test/acme${buildSettingsPanelRoute({
          panel: SettingsPanelId.ConnectedDevices,
        })}`
      )
    );
  });
});

describe("parseComputeTargetLinkBlock", () => {
  it("reads a well-formed block", () => {
    expect(parseComputeTargetLinkBlock(BLOCK)).toEqual(BLOCK);
  });

  it("reads an absent block as not blocked", () => {
    expect(parseComputeTargetLinkBlock(null)).toBeNull();
    expect(parseComputeTargetLinkBlock(undefined)).toBeNull();
  });

  it("reads a shape this build cannot validate as not blocked", () => {
    // An older main process, or a payload that lost its fields: degrade to "not
    // blocked" rather than render an alert built from `undefined`.
    expect(parseComputeTargetLinkBlock({ refusedBatchCount: 3 })).toBeNull();
    expect(parseComputeTargetLinkBlock("blocked")).toBeNull();
  });
});
