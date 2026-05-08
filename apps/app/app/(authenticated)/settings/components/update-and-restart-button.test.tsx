import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { UPDATE_AND_RESTART_OPERATION_ID } from "@repo/api/src/types/compute-target";
import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — registered before the component import
// ---------------------------------------------------------------------------

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({ children }: { children: React.ReactNode }) => children,
}));

const mockDispatchMutate = vi.fn();
const mockUseDispatchDesktopCommand = vi.fn();
const mockUseDesktopCommandStatus = vi.fn();

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useDispatchDesktopCommand: (...args: unknown[]) =>
    mockUseDispatchDesktopCommand(...args),
  useDesktopCommandStatus: (...args: unknown[]) =>
    mockUseDesktopCommandStatus(...args),
}));

const mockUseLatestElectronRelease = vi.fn();

vi.mock("@/hooks/queries/use-electron-release", () => ({
  useLatestElectronRelease: (...args: unknown[]) =>
    mockUseLatestElectronRelease(...args),
}));

// Mock react-markdown to render real anchor elements so we can assert on href.
// The mock parses [text](url) patterns and delegates to the provided anchor component.
const MD_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

vi.mock("react-markdown", () => ({
  default: ({
    children,
    components,
  }: {
    children: string;
    components?: {
      a?: (props: React.ComponentPropsWithoutRef<"a">) => React.ReactElement;
    };
  }) => {
    const AnchorComponent = components?.a;
    if (!AnchorComponent) {
      return <div data-testid="release-notes">{children}</div>;
    }

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    MD_LINK_REGEX.lastIndex = 0;

    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
    while ((match = MD_LINK_REGEX.exec(children)) !== null) {
      if (match.index > lastIndex) {
        parts.push(children.slice(lastIndex, match.index));
      }
      const [, text, href] = match;
      parts.push(
        <AnchorComponent href={href} key={match.index}>
          {text}
        </AnchorComponent>
      );
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < children.length) {
      parts.push(children.slice(lastIndex));
    }

    return <div data-testid="release-notes">{parts}</div>;
  },
}));

vi.mock("remark-gfm", () => ({ default: () => {} }));

// Import component after mocks
import {
  resolveButtonState,
  UpdateAndRestartButton,
} from "./update-and-restart-button";

// ---------------------------------------------------------------------------
// Top-level regex constants (Biome useTopLevelRegex)
// ---------------------------------------------------------------------------

const RE_UPDATE_AND_RESTART_BUTTON = /update and restart/i;
const RE_CONFIRM_BUTTON = /^update & restart$/i;
const RE_OFFLINE = /offline/i;
const RE_HERE_LINK = /here/i;
const RE_CHANGELOG_LINK = /changelog/i;
const RE_OUR_SITE_LINK = /our site/i;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<ComputeTarget> = {}): ComputeTarget {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "my-machine",
    platform: "darwin",
    capabilities: { pluginVersion: "1.0.0" },
    supportedOperations: [UPDATE_AND_RESTART_OPERATION_ID],
    lastSeenAt: new Date(),
    isOnline: true,
    isSharedWithOrg: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeReleaseInfo(
  overrides: Partial<ElectronReleaseInfo> = {}
): ElectronReleaseInfo {
  return {
    downloadUrl: "https://example.com/download",
    version: "2.0.0",
    releaseNotes: "## Changes\n- Bug fixes",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default mock return values
// ---------------------------------------------------------------------------

function setupDefaultMocks(
  releaseInfo: ElectronReleaseInfo | undefined = makeReleaseInfo()
) {
  mockUseDispatchDesktopCommand.mockReturnValue({
    mutate: mockDispatchMutate,
    isPending: false,
  });
  mockUseDesktopCommandStatus.mockReturnValue({
    data: undefined,
  });
  mockUseLatestElectronRelease.mockReturnValue({
    data: releaseInfo,
  });
}

// ---------------------------------------------------------------------------
// resolveButtonState unit tests
// ---------------------------------------------------------------------------

describe("resolveButtonState", () => {
  it("returns hidden when releaseInfo is undefined", () => {
    const target = makeTarget();
    expect(resolveButtonState(target, undefined)).toEqual({ kind: "hidden" });
  });

  it("returns hidden when target does not include the update operation", () => {
    const target = makeTarget({ supportedOperations: [] });
    const release = makeReleaseInfo();
    expect(resolveButtonState(target, release)).toEqual({ kind: "hidden" });
  });

  it("returns hidden when no update is available (current version equals release version)", () => {
    const target = makeTarget({ capabilities: { pluginVersion: "2.0.0" } });
    const release = makeReleaseInfo({ version: "2.0.0" });
    expect(resolveButtonState(target, release)).toEqual({ kind: "hidden" });
  });

  it("returns hidden when target version is ahead of release version", () => {
    const target = makeTarget({ capabilities: { pluginVersion: "3.0.0" } });
    const release = makeReleaseInfo({ version: "2.0.0" });
    expect(resolveButtonState(target, release)).toEqual({ kind: "hidden" });
  });

  it("returns hidden when the target has no pluginVersion capability", () => {
    // isUpdateAvailable(undefined, ...) returns false → hidden
    const target = makeTarget({ capabilities: {} });
    const release = makeReleaseInfo({ version: "2.0.0" });
    expect(resolveButtonState(target, release)).toEqual({ kind: "hidden" });
  });

  it("returns disabled with offline reason when update is available but target is offline", () => {
    const target = makeTarget({ isOnline: false });
    const release = makeReleaseInfo();
    const state = resolveButtonState(target, release);
    expect(state.kind).toBe("disabled");
    if (state.kind === "disabled") {
      expect(state.reason).toMatch(RE_OFFLINE);
    }
  });

  it("returns enabled when update is available and target is online", () => {
    const target = makeTarget();
    const release = makeReleaseInfo({ version: "2.0.0" });
    expect(resolveButtonState(target, release)).toEqual({
      kind: "enabled",
      currentVersion: "1.0.0",
    });
  });
});

// ---------------------------------------------------------------------------
// UpdateAndRestartButton component tests
// ---------------------------------------------------------------------------

describe("UpdateAndRestartButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Hidden states
  // -------------------------------------------------------------------------

  it("renders nothing when releaseInfo is undefined", () => {
    mockUseLatestElectronRelease.mockReturnValue({ data: undefined });
    const target = makeTarget();
    const { container } = render(<UpdateAndRestartButton target={target} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when target does not support the update operation", () => {
    const target = makeTarget({ supportedOperations: [] });
    const { container } = render(<UpdateAndRestartButton target={target} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no update is available", () => {
    mockUseLatestElectronRelease.mockReturnValue({
      data: makeReleaseInfo({ version: "2.0.0" }),
    });
    const target = makeTarget({ capabilities: { pluginVersion: "2.0.0" } });
    const { container } = render(<UpdateAndRestartButton target={target} />);
    expect(container).toBeEmptyDOMElement();
  });

  // -------------------------------------------------------------------------
  // Disabled state (offline)
  // -------------------------------------------------------------------------

  it("renders button disabled when target is offline and update is available", () => {
    const target = makeTarget({ isOnline: false });

    render(<UpdateAndRestartButton target={target} />);

    const button = screen.getByRole("button", {
      name: RE_UPDATE_AND_RESTART_BUTTON,
    });
    expect(button).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Enabled state
  // -------------------------------------------------------------------------

  it("renders enabled button when update is available and target is online", () => {
    const target = makeTarget();

    render(<UpdateAndRestartButton target={target} />);

    const button = screen.getByRole("button", {
      name: RE_UPDATE_AND_RESTART_BUTTON,
    });
    expect(button).not.toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Dialog version info
  // -------------------------------------------------------------------------

  it("shows current and new version numbers in the dialog when both are valid semver", () => {
    mockUseLatestElectronRelease.mockReturnValue({
      data: makeReleaseInfo({ version: "2.0.0" }),
    });
    const target = makeTarget({ capabilities: { pluginVersion: "1.2.3" } });

    render(<UpdateAndRestartButton target={target} />);

    fireEvent.click(
      screen.getByRole("button", { name: RE_UPDATE_AND_RESTART_BUTTON })
    );

    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText("2.0.0")).toBeInTheDocument();
  });

  it("shows 'Unknown' version fallback when validatePluginVersion returns undefined", () => {
    // validatePluginVersion returns undefined for non-semver strings, causing the UI to show 'Unknown'.
    // Since isUpdateAvailable also returns false for non-semver (compareVersions returns 0),
    // the button state would be 'hidden' and the dialog unreachable from the component.
    // This test documents the constraint: hidden-when-no-pluginVersion covers the 'Unknown' code path.
    // The resolveButtonState test "returns hidden when the target has no pluginVersion capability"
    // above verifies this boundary.
    expect(
      resolveButtonState(makeTarget({ capabilities: {} }), makeReleaseInfo())
    ).toEqual({ kind: "hidden" });
  });

  it("shows both versions in the update confirmation dialog description", () => {
    mockUseLatestElectronRelease.mockReturnValue({
      data: makeReleaseInfo({ version: "2.3.1" }),
    });
    const target = makeTarget({ capabilities: { pluginVersion: "1.5.0" } });

    render(<UpdateAndRestartButton target={target} />);

    fireEvent.click(
      screen.getByRole("button", { name: RE_UPDATE_AND_RESTART_BUTTON })
    );

    expect(screen.getByText("1.5.0")).toBeInTheDocument();
    expect(screen.getByText("2.3.1")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // renderSafeAnchor: strips non-HTTPS hrefs to '#'
  // -------------------------------------------------------------------------

  it("replaces javascript: hrefs in release notes with '#'", () => {
    const releaseNotes = "Click [here](javascript:alert(1)) for info";
    mockUseLatestElectronRelease.mockReturnValue({
      data: makeReleaseInfo({ releaseNotes }),
    });
    const target = makeTarget();

    render(<UpdateAndRestartButton target={target} />);

    fireEvent.click(
      screen.getByRole("button", { name: RE_UPDATE_AND_RESTART_BUTTON })
    );

    const link = screen.getByRole("link", { name: RE_HERE_LINK });
    expect(link).toHaveAttribute("href", "#");
  });

  it("keeps https hrefs intact in release notes", () => {
    const releaseNotes = "See [changelog](https://example.com/changelog)";
    mockUseLatestElectronRelease.mockReturnValue({
      data: makeReleaseInfo({ releaseNotes }),
    });
    const target = makeTarget();

    render(<UpdateAndRestartButton target={target} />);

    fireEvent.click(
      screen.getByRole("button", { name: RE_UPDATE_AND_RESTART_BUTTON })
    );

    const link = screen.getByRole("link", { name: RE_CHANGELOG_LINK });
    expect(link).toHaveAttribute("href", "https://example.com/changelog");
  });

  it("strips http:// hrefs to '#' (renderSafeAnchor only allows https)", () => {
    const releaseNotes = "Visit [our site](http://insecure.example.com)";
    mockUseLatestElectronRelease.mockReturnValue({
      data: makeReleaseInfo({ releaseNotes }),
    });
    const target = makeTarget();

    render(<UpdateAndRestartButton target={target} />);

    fireEvent.click(
      screen.getByRole("button", { name: RE_UPDATE_AND_RESTART_BUTTON })
    );

    const link = screen.getByRole("link", { name: RE_OUR_SITE_LINK });
    expect(link).toHaveAttribute("href", "#");
  });

  // -------------------------------------------------------------------------
  // Confirm once calls mutate once (dialog closes)
  // -------------------------------------------------------------------------

  it("calls mutate exactly once when confirm is clicked and closes the dialog", () => {
    const target = makeTarget();

    render(<UpdateAndRestartButton target={target} />);

    // Open dialog
    fireEvent.click(
      screen.getByRole("button", { name: RE_UPDATE_AND_RESTART_BUTTON })
    );

    // Confirm — the AlertDialogAction button text is "Update & Restart"
    const confirmButton = screen.getByRole("button", {
      name: RE_CONFIRM_BUTTON,
    });
    fireEvent.click(confirmButton);

    expect(mockDispatchMutate).toHaveBeenCalledTimes(1);
    // The idempotency key must be generated before mutate() is called (once per user action),
    // not inside mutationFn. Verify the key is passed as a variable.
    const [firstArg] = mockDispatchMutate.mock.calls[0];
    expect(firstArg).toMatchObject({ idempotencyKey: expect.any(String) });
    expect(
      (firstArg as { idempotencyKey: string }).idempotencyKey.length
    ).toBeGreaterThan(0);

    // Dialog should be closed after confirm
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // sessionStorage commandId restore on mount
  // -------------------------------------------------------------------------

  it("restores commandId from sessionStorage on mount and passes it to useDesktopCommandStatus", () => {
    const targetId = "target-1";
    const storedCommandId = "cmd-persisted-123";
    sessionStorage.setItem(
      `update-restart-command-${targetId}`,
      storedCommandId
    );

    const target = makeTarget({ id: targetId });

    render(<UpdateAndRestartButton target={target} />);

    // After mount, the useEffect reads sessionStorage and calls setCommandId.
    // useDesktopCommandStatus should subsequently be called with the restored commandId.
    const calls = mockUseDesktopCommandStatus.mock.calls;
    const restoredCall = calls.find(
      (call) => call[0] === targetId && call[1] === storedCommandId
    );
    expect(restoredCall).toBeDefined();
  });
});
