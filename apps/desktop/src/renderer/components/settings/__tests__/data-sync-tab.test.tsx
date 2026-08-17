import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSyncLevel } from "../../../../shared/contracts";
import { DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { DataSyncTab } from "../data-sync-tab";

// FEA-3907: mount the real DataSyncTab with a stubbed window.desktopApi and
// assert it (1) reads the current level on mount, (2) renders the Recommended
// pill on the most-permissive level and no chip anywhere else, most-permissive
// first (ISS-5318), and (3) persists a picked level through setDataSyncLevel on
// Apply.

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

const FULL_TRANSCRIPTS_RE = /Full transcripts/i;
const READ_FAILURE_RE = /Couldn't read your data sync level/i;
const RAISED_CONFIRMATION_RE = /Raised to Full transcripts/i;
const RADIOGROUP_NAME_RE = /data & sync level/i;
const REDACTED_RE = /Redacted sessions/i;
const OFF_OPTION_RE = /Nothing leaves this device/i;
const LOWERED_CONFIRMATION_RE = /Lowered to Off/i;
// The approved green the ISS-5318 pill must use: the design-system `success`
// Badge variant, not a hand-rolled color.
const SUCCESS_BADGE_CLASS = "text-success";

// Mounts DataSyncTab under a feature-flag adapter that resolves the
// show-Redacted Labs flag to `enabled` (every other flag stays off).
function renderWithRedactedFlag(enabled: boolean): void {
  const adapter = {
    useFeatureFlagEnabled: (key: string) =>
      key === DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY && enabled,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider adapter={adapter}>
      {children}
    </FeatureFlagAdapterProvider>
  );
  render(<DataSyncTab />, { wrapper });
}

// The levels in RENDERED order, read off each radio's `<radioName>-<level>` id.
// Asserting the order (not just presence) is the only way the most-permissive
// first presentation can fail a test: every option is present either way.
function renderedLevelOrder(): string[] {
  return screen
    .getAllByRole("radio")
    .map((radio) => radio.id.slice(radio.id.lastIndexOf("-") + 1));
}

type DataSyncApi = {
  getDataSyncLevel: ReturnType<typeof vi.fn>;
  setDataSyncLevel: ReturnType<typeof vi.fn>;
};

function installDesktopApi(overrides: Partial<DataSyncApi> = {}): DataSyncApi {
  const api: DataSyncApi = {
    getDataSyncLevel: vi.fn(async () => ({ level: DataSyncLevel.Metadata })),
    setDataSyncLevel: vi.fn(async (level: DataSyncLevel) => ({ level })),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return api;
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.restoreAllMocks();
});

describe("DataSyncTab graduated selector", () => {
  it("reads the current data sync level on mount", async () => {
    const api = installDesktopApi();
    render(<DataSyncTab />);
    await waitFor(() => expect(api.getDataSyncLevel).toHaveBeenCalled());
    // The most-permissive level renders with its Recommended pill.
    await screen.findByText("Recommended");
  });

  it("renders one green Recommended pill, on the most-permissive level only", async () => {
    installDesktopApi();
    render(<DataSyncTab />);

    const recommended = await screen.findByText("Recommended");
    expect(recommended.className).toContain(SUCCESS_BADGE_CLASS);
    // The shield was the elevated-RISK affordance; an endorsement pill must not
    // carry it.
    expect(recommended.querySelector("svg")).toBeNull();
    // No chip marks the level a fresh install lands on.
    expect(screen.queryByText("Default")).toBeNull();
    expect(screen.getByText("Full transcripts")).not.toBeNull();
    // "Metadata only" appears in both the radio card and the current-level
    // badge, so at least one occurrence must be present.
    expect(screen.getAllByText("Metadata only").length).toBeGreaterThan(0);
  });

  it("renders the recommended level first (ISS-5318)", async () => {
    installDesktopApi();
    render(<DataSyncTab />);
    await screen.findByText("Recommended");

    expect(renderedLevelOrder()).toEqual([
      DataSyncLevel.Full,
      DataSyncLevel.Metadata,
      DataSyncLevel.Off,
    ]);
  });

  it("persists a picked level through setDataSyncLevel and disables Apply until dirty", async () => {
    const api = installDesktopApi();
    render(<DataSyncTab />);

    await screen.findByText("Recommended");

    // On the current (unchanged) level, Apply is disabled.
    const applyButton = screen.getByRole("button", {
      name: "Apply changes",
    }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);

    // Pick the elevated "Full transcripts" radio, then Apply.
    fireEvent.click(screen.getByRole("radio", { name: FULL_TRANSCRIPTS_RE }));
    await waitFor(() => expect(applyButton.disabled).toBe(false));
    fireEvent.click(applyButton);

    await waitFor(() =>
      expect(api.setDataSyncLevel).toHaveBeenCalledWith(DataSyncLevel.Full)
    );
  });

  it("surfaces a read failure instead of asserting a guessed level", async () => {
    installDesktopApi({
      getDataSyncLevel: vi.fn(() => Promise.reject(new Error("ipc down"))),
    });
    render(<DataSyncTab />);
    await screen.findByText(READ_FAILURE_RE);
    // No radio group rendered when the read failed.
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("gives the radio group an accessible name", async () => {
    installDesktopApi();
    render(<DataSyncTab />);
    await screen.findByText("Recommended");
    // Screen readers announce the group's purpose, not four unlabeled options.
    expect(
      screen.getByRole("radiogroup", { name: RADIOGROUP_NAME_RE })
    ).not.toBeNull();
  });

  it("shows a directional confirmation after a successful Apply", async () => {
    installDesktopApi();
    render(<DataSyncTab />);
    await screen.findByText("Recommended");

    // Raise from Metadata → Full and apply.
    fireEvent.click(screen.getByRole("radio", { name: FULL_TRANSCRIPTS_RE }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    // A directional "Raised to …" line confirms the change (the payoff of the
    // interaction), not just the Saved. save-state.
    await screen.findByText(RAISED_CONFIRMATION_RE);
  });

  it("the most-permissive-first order does not invert the raised/lowered confirmation", async () => {
    installDesktopApi();
    render(<DataSyncTab />);
    await screen.findByText("Recommended");

    // Metadata → Off is a LOWERING even though Off renders last: the direction
    // reads the canonical exposure ranking, not the rendered order.
    fireEvent.click(screen.getByRole("radio", { name: OFF_OPTION_RE }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    await screen.findByText(LOWERED_CONFIRMATION_RE);
  });

  it("hides the Redacted option when the show-Redacted Labs flag is off", async () => {
    installDesktopApi();
    renderWithRedactedFlag(false);
    // Wait for the current level to load (the Recommended pill) so the absence
    // below is a real gate, not just the loading skeleton.
    await screen.findByText("Recommended");
    expect(screen.queryByText(REDACTED_RE)).toBeNull();
  });

  it("shows the Redacted option when the show-Redacted Labs flag is on", async () => {
    installDesktopApi();
    renderWithRedactedFlag(true);
    await screen.findByText(REDACTED_RE);
  });

  it("keeps a persisted Redacted level visible even when the flag is off", async () => {
    // A migrated/persisted `redacted` value must not become an orphaned
    // selection: the level the user is already on stays in the picker.
    installDesktopApi({
      getDataSyncLevel: vi.fn(async () => ({ level: DataSyncLevel.Redacted })),
    });
    renderWithRedactedFlag(false);
    await screen.findByText(REDACTED_RE);
  });
});
