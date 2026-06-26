import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  COMMAND_PALETTE_FEATURE_FLAG_KEY,
  CommandPalette,
} from "../command-palette";

const flagResult = (flag: string, enabled: boolean) => ({
  key: flag,
  enabled,
  variant: undefined,
  payload: undefined,
});

// Defaults to every flag enabled; tests override to exercise gating.
const mockUseFeatureFlag = vi.fn((flag: string) => flagResult(flag, true));
const mockPush = vi.fn();

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (flag: string) => mockUseFeatureFlag(flag),
}));

// Driven by the global @repo/navigation port mocks in vitest.setup.ts, which
// delegate useNavigation()/useOrgPath() back to next/navigation.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/dashboard",
}));

// Render the command primitives inline so jsdom can query item text and the
// dialog honors the `open` prop (matches loop-dispatch-target-selector.test).
vi.mock("@repo/design-system/components/ui/command", () => ({
  CommandDialog: ({
    open,
    children,
    title,
  }: {
    open?: boolean;
    children: React.ReactNode;
    title?: string;
  }) =>
    open ? (
      <div aria-label={title} role="dialog">
        {children}
      </div>
    ) : null,
  CommandInput: ({ placeholder }: { placeholder?: string }) => (
    <input placeholder={placeholder} />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    children,
    heading,
  }: {
    children: React.ReactNode;
    heading?: string;
  }) => (
    <div>
      {heading ? <span>{heading}</span> : null}
      {children}
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    value?: string;
  }) => (
    <button data-value={value} onClick={() => onSelect?.()} type="button">
      {children}
    </button>
  ),
  CommandSeparator: () => <hr />,
}));

const pressCommandK = () => {
  fireEvent.keyDown(document, { key: "k", metaKey: true });
};

describe("CommandPalette", () => {
  beforeEach(() => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    mockPush.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders nothing and ignores the shortcut when the flag is disabled", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== COMMAND_PALETTE_FEATURE_FLAG_KEY)
    );
    render(<CommandPalette />);

    pressCommandK();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockUseFeatureFlag).toHaveBeenCalledWith(
      COMMAND_PALETTE_FEATURE_FLAG_KEY
    );
  });

  test("opens on cmd+k and lists navigation commands", () => {
    render(<CommandPalette />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Loops")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });

  test("hides destinations whose feature flag is disabled", () => {
    // Palette on, but the sessions-nav flag off → Sessions/Agent Monitoring hidden.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== "desktop-agent-session-sync")
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent Monitoring")).not.toBeInTheDocument();
  });

  test("navigates to the org-scoped href and closes on select", () => {
    render(<CommandPalette />);
    pressCommandK();

    fireEvent.click(screen.getByText("Dashboard"));

    expect(mockPush).toHaveBeenCalledWith("/acme/dashboard");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("toggles closed on a second cmd+k", () => {
    render(<CommandPalette />);

    pressCommandK();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    pressCommandK();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
