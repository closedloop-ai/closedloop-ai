import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import {
  ArtifactFlag,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  SESSIONS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CommandPalette } from "../command-palette";

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

  test("opens on cmd+k with every feature flag off (ISS-4693, ungated)", () => {
    // ISS-4693 retired the palette's own `emergent` gate, so the shortcut must
    // work for every user. Turning EVERY flag off is the strongest condition:
    // before the ungate this rendered null and registered no key listener.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, false)
    );
    render(<CommandPalette />);

    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("opens on cmd+k and lists navigation commands", () => {
    render(<CommandPalette />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });

  test("does not surface the retired Loops destination (ISS-4477)", () => {
    // Loops is removed from nav & UI, so the command palette must no longer
    // offer it as a navigation command.
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Loops")).not.toBeInTheDocument();
  });

  test("hides destinations whose feature flag is disabled", () => {
    // Palette on, but a still-gated destination's flag (Insights) off → hidden.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== INSIGHTS_FEATURE_FLAG_KEY)
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Insights")).not.toBeInTheDocument();
  });

  // ISS-5037 (ISS-4779 closed-by-default): the Labs container gate. Driven with
  // every PER-ITEM flag ON, so a pass cannot come from the items being gated —
  // only the container can remove them. Without this the palette would stay a
  // keyboard back door into a section the sidebar hides and a route that 404s.
  test("hides Labs destinations when the Labs container flag is off (ISS-5037)", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== LABS_NAV_SECTION_FEATURE_FLAG_KEY)
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Insights")).not.toBeInTheDocument();
    expect(screen.queryByText("Judges")).not.toBeInTheDocument();
    // Non-Labs destinations are untouched — the gate removed a section, not
    // the palette.
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });

  test("lists Labs destinations when the Labs container flag is on (ISS-5037)", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByText("Insights")).toBeInTheDocument();
    expect(screen.getByText("Judges")).toBeInTheDocument();
  });

  test("lists Routines when the routines flag is ON (FEA-4348)", () => {
    // Routines is gated behind the PostHog `routines` flag until GA. Palette on,
    // routines flag on → the destination surfaces.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Routines")).toBeInTheDocument();
  });

  test("hides Routines when the routines flag is OFF (FEA-4348)", () => {
    // Palette on, but the `routines` flag off → Routines must not surface. This
    // is the default-off, pre-GA state the gate exists to enforce.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== ROUTINES_FEATURE_FLAG_KEY)
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Routines")).not.toBeInTheDocument();
  });

  test("lists Branches/Sessions even with their old nav flag off (FEA-4155)", () => {
    // FEA-4155: Branches/Sessions are always-on now (their nav destinations
    // carry no featureFlag), so turning their retired nav flags off must not
    // hide them from the palette. Reference the canonical constants
    // (SESSIONS_FEATURE_FLAG_KEY / ArtifactFlag.Branches) instead of the literal
    // keys so a rename cannot silently make this stop exercising the real
    // contract (codex review #3789).
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(
        flag,
        flag !== SESSIONS_FEATURE_FLAG_KEY && flag !== ArtifactFlag.Branches
      )
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Branches")).toBeInTheDocument();
  });

  test("never lists Agent Monitoring (removed in FEA-3983/3970)", () => {
    // All flags enabled: even so, Agent Monitoring must not appear because the
    // screen was removed and its command entry deleted.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Agent Monitoring")).not.toBeInTheDocument();
  });

  test("lists Documents with every flag off (FEA-4140, always-on)", () => {
    // The org-level Documents index shipped (FEA-4140) and its primary-nav
    // affordance is restored always-on (no flag), consistent with Agents.
    // Every artifact flag off is the strongest condition proving the Documents
    // command is not gated: the palette, the third nav entry point alongside
    // the sidebar and mobile nav, must list it.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, false)
    );
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
  });

  test("lists every primary-nav destination, sourced from the shared registry", () => {
    // The palette's primary commands are derived from PRIMARY_NAV_DESTINATIONS
    // (the single source of truth the sidebar and mobile nav share), so every
    // enabled registry destination must appear. All flags on here.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    render(<CommandPalette />);
    pressCommandK();

    for (const destination of PRIMARY_NAV_DESTINATIONS) {
      expect(screen.getByText(destination.title)).toBeInTheDocument();
    }
  });

  test("navigates to the org-scoped href and closes on select", () => {
    render(<CommandPalette />);
    pressCommandK();

    fireEvent.click(screen.getByText("Dashboard"));

    expect(mockPush).toHaveBeenCalledWith("/acme/dashboard");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("scopes its copy to jumping between pages, not searching content", () => {
    // The palette only navigates to primary-nav destinations; the sidebar search
    // box owns searching real content. Now that every user has the shortcut
    // (ISS-4693), the prompt and the empty state must not promise a search the
    // palette cannot perform.
    render(<CommandPalette />);
    pressCommandK();

    expect(screen.getByPlaceholderText("Jump to a page…")).toBeInTheDocument();
    expect(screen.getByText("No pages match")).toBeInTheDocument();
    expect(screen.getByText("Pages")).toBeInTheDocument();
  });

  test("toggles closed on a second cmd+k", () => {
    render(<CommandPalette />);

    pressCommandK();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    pressCommandK();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
