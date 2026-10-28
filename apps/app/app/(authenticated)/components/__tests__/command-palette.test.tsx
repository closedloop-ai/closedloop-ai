import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import {
  AGENTS_NAV_FEATURE_FLAG_KEY,
  ArtifactFlag,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { ShellNavigationRouteId } from "@repo/app/shared/lib/shell-navigation-contract";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { CommandPalette } from "../command-palette";
import { primaryNavTitle } from "./primary-nav-title.test-helpers";

const INSIGHTS_COMMAND_TITLE = "Insights";
const JUDGES_COMMAND_TITLE = "Judges";

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
// dialog honors the `open` prop.
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

/*
 * ISS-7493. The listener under test is a bare `document.addEventListener`, and
 * `fireEvent.keyDown` cannot express this input: jsdom's `KeyboardEvent`
 * constructor coerces `key` to a string, so the EventInit route always yields
 * one. Overwriting the own property after construction is what a password
 * manager or extension shim actually does, and is the only way to reproduce
 * what RUM observed.
 */
const dispatchChordWithKey = (key: unknown) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, metaKey: true });
  Object.defineProperty(event, "key", { configurable: true, value: key });
  document.dispatchEvent(event);
};

/*
 * jsdom does not let a listener's exception escape `dispatchEvent` — it reports
 * it as an uncaught error on `window` instead. A throw-only assertion around
 * the dispatch is therefore green either way, so the error event is what this
 * suite actually watches.
 */
const captureUncaughtErrors = () => {
  const seen: string[] = [];
  const onError = (event: ErrorEvent) => {
    seen.push(event.message);
  };
  window.addEventListener("error", onError);
  return {
    seen,
    stop: () => window.removeEventListener("error", onError),
  };
};

const UNUSABLE_CHORD_KEYS: ReadonlyArray<readonly [string, unknown]> = [
  ["absent", undefined],
  ["null", null],
  ["a non-string", 42],
];

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
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });

    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("opens on cmd+k and lists navigation commands", () => {
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });

  test("does not surface the retired Loops destination (ISS-4477)", () => {
    // Loops is removed from nav & UI, so the command palette must no longer
    // offer it as a navigation command.
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Loops")).not.toBeInTheDocument();
  });

  test("hides destinations whose feature flag is disabled", () => {
    // Palette on, but a still-gated destination's flag (Insights) off → hidden.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== INSIGHTS_FEATURE_FLAG_KEY)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.queryByText(INSIGHTS_COMMAND_TITLE)).not.toBeInTheDocument();
  });

  // ISS-5037 (ISS-4779 closed-by-default): the Labs container gate. Driven with
  // every PER-ITEM flag ON, so a pass cannot come from the items being gated —
  // only the container can remove them. Without this the palette would stay a
  // keyboard back door into a section the sidebar hides and a route that 404s.
  test("hides Labs destinations when the Labs container flag is off (ISS-5037)", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== LABS_NAV_SECTION_FEATURE_FLAG_KEY)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(INSIGHTS_COMMAND_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(JUDGES_COMMAND_TITLE)).not.toBeInTheDocument();
    // Non-Labs destinations are untouched — the gate removed a section, not
    // the palette.
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });

  test("lists Labs destinations when the Labs container flag is on (ISS-5037)", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(screen.getByText(INSIGHTS_COMMAND_TITLE)).toBeInTheDocument();
    expect(screen.getByText(JUDGES_COMMAND_TITLE)).toBeInTheDocument();
  });

  test("lists Branches/Sessions even with their old nav flag off (FEA-4155)", () => {
    // FEA-4155: Branches/Sessions are always-on now (their nav destinations
    // carry no featureFlag), so turning Branches' retired nav flag off must not
    // hide it from the palette. Reference the canonical constant instead of the
    // literal key so a rename cannot silently make this stop exercising the real
    // contract (codex review #3789). Sessions rides along only as proof the
    // palette rendered its command list at all: this mock answers `enabled` for
    // every key that is not Branches, so it cannot see a gate reintroduced on
    // Sessions. That one is pinned structurally in
    // `packages/app/shared/lib/__tests__/primary-nav-destinations.test.ts`.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== ArtifactFlag.Branches)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
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
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Agent Monitoring")).not.toBeInTheDocument();
  });

  test("lists Documents behind its own flag, independent of Issues", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag === ArtifactFlag.Documents)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText(primaryNavTitle(ShellNavigationRouteId.Documents))
    ).toBeInTheDocument();
    expect(
      screen.queryByText(primaryNavTitle(ShellNavigationRouteId.Issues))
    ).toBeNull();
  });

  test("hides Documents when its flag is off", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== ArtifactFlag.Documents)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(
      screen.getByText(primaryNavTitle(ShellNavigationRouteId.Issues))
    ).toBeInTheDocument();
    expect(
      screen.queryByText(primaryNavTitle(ShellNavigationRouteId.Documents))
    ).toBeNull();
  });

  test("lists every primary-nav destination, sourced from the shared registry", () => {
    // The palette's primary commands are derived from PRIMARY_NAV_DESTINATIONS
    // (the single source of truth the sidebar and mobile nav share), so every
    // enabled registry destination must appear. All flags on here.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    for (const destination of PRIMARY_NAV_DESTINATIONS) {
      expect(screen.getByText(destination.title)).toBeInTheDocument();
    }
  });

  // ISS-5041/ISS-7835. The registry test above turns EVERY flag on, so it would
  // pass whether or not the palette resolves `agentsNav` at all — its
  // `enabledByFlag` map is hand-maintained, and a missing key reads `undefined`,
  // which hides the command from everyone rather than gating it. These two turn
  // the one flag independently, which is the only way to see that.
  test("omits the Agents command when agentsNav is OFF", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== AGENTS_NAV_FEATURE_FLAG_KEY)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(
      screen.queryByText(primaryNavTitle(ShellNavigationRouteId.Agents))
    ).not.toBeInTheDocument();
    // A sibling destination proves the palette rendered its command list at
    // all, so the absence above is the gate and not an empty dialog.
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });

  test("offers the Agents command when agentsNav is ON", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag === AGENTS_NAV_FEATURE_FLAG_KEY)
    );
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    // The positive sibling: same locator, only the flag differs. Without it the
    // assertion above could be proving the absence of a label that never
    // rendered under any flag state.
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  test("navigates to the org-scoped href and closes on select", () => {
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
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
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
    pressCommandK();

    expect(screen.getByPlaceholderText("Jump to a page…")).toBeInTheDocument();
    expect(screen.getByText("No pages match")).toBeInTheDocument();
    expect(screen.getByText("Pages")).toBeInTheDocument();
  });

  // ISS-7493 (whitlockk review, PR #7424). Every other case in this file sends a
  // well-formed `key: "k"`, so the guard this ticket adds could be deleted
  // without one of them failing. These are the cases that hold it: the listener
  // is mounted on `document` for every authenticated page, and a synthetic
  // keydown carrying no usable `key` reached `.toLowerCase()` and threw a
  // TypeError into RUM from whatever route the user was on.
  test.each(UNUSABLE_CHORD_KEYS)(
    "a Meta chord with %s key neither opens the palette nor throws",
    (_label, key) => {
      render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });
      const errors = captureUncaughtErrors();

      try {
        dispatchChordWithKey(key);

        expect(errors.seen).toEqual([]);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      } finally {
        errors.stop();
      }

      // The positive control, same render: a real ⌘K still opens. Without it the
      // assertions above would also pass for a palette that never bound its
      // listener at all.
      pressCommandK();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    }
  );

  test("toggles closed on a second cmd+k", () => {
    render(<CommandPalette />, { wrapper: WebFeatureFlagProvider });

    pressCommandK();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    pressCommandK();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
