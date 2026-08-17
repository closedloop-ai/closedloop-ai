import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSyncLevelValue } from "../../../shared/lib/data-sync-copy";
import {
  DEFAULT_SYNC_LEVEL,
  DEFAULT_TAKEOVER_SYNC_LEVEL,
  SyncConsent,
  SyncLevelOptions,
} from "../sync-consent";

const HEADING = /choose what syncs to the cloud/i;
const CONTINUE = /^continue$/i;
const FULL_OPTION = /full transcripts/i;
const METADATA_OPTION = /metadata only/i;
// Matches the "Off" level's radio by its accessible name, which starts with the
// title. Anchored to the start so it does not also match "Full transcripts" /
// "Metadata only" (neither begins with "Off").
const OFF_OPTION = /^off\b/i;
const PROMPTS_LINE = /prompts & completions/i;
const SESSION_SHAPE_LINE = /session shape, timing & cost/i;
const TOOL_ACTIVITY_LINE = /tool-call activity/i;
const TOOL_CONTENT_LINE = /tool inputs & file contents/i;
const FULL_CAVEAT = /transcripts, prompts, and file contents are sync'd/i;
const OFF_CAVEAT = /won't be able to sync across machines/i;
const ANY_CAVEAT = /for complete analysis|sync across machines/i;
const RECOMMENDED_BADGE = /recommended/i;
const SYNCS_TO_CLOUD = /syncs to cloud/i;
const STAYS_ON_DEVICE = /stays on this device/i;

describe("SyncConsent", () => {
  it("defaults to the safest insight-bearing level, not the broadest", () => {
    // Consent is explicit and per-level: the pre-selected state must never be a
    // wider data-sharing level than the user chose. The recommended default is
    // metadata (matching the shipped Settings default), never "full".
    expect(DEFAULT_SYNC_LEVEL).toBe(DataSyncLevelValue.Metadata);
  });

  it("uses canonical DataSyncLevel values, not the legacy tier vocabulary", () => {
    // The consolidation moved onboarding onto the canonical DataSyncLevel value
    // set — the value the setter consumes uses `off`, never the old `local`.
    expect(DEFAULT_SYNC_LEVEL).not.toBe("local");
  });

  it("renders the heading", () => {
    render(<SyncConsent onConfirm={vi.fn()} />);
    expect(screen.getByRole("heading", { name: HEADING })).toBeInTheDocument();
  });

  it("pre-selects metadata (the recommended level) by default, not full or off", () => {
    render(<SyncConsent onConfirm={vi.fn()} />);
    const full = screen.getByRole("radio", { name: FULL_OPTION });
    const metadata = screen.getByRole("radio", { name: METADATA_OPTION });
    const off = screen.getByRole("radio", { name: OFF_OPTION });
    expect(metadata).toBeChecked();
    expect(full).not.toBeChecked();
    expect(off).not.toBeChecked();
  });

  it("marks the most-permissive level with a single Recommended badge", () => {
    // ISS-5318: the chip comes from `dataSyncLevelBadge`, so onboarding endorses
    // the SAME level Settings does. It sits on Full even though onboarding
    // pre-selects Metadata — the badge is the endorsement, not the selection.
    render(<SyncConsent onConfirm={vi.fn()} />);
    const badges = screen.getAllByText(RECOMMENDED_BADGE);
    expect(badges).toHaveLength(1);
    const fullOption = screen
      .getByRole("radio", { name: FULL_OPTION })
      .closest("label");
    expect(fullOption).not.toBeNull();
    if (fullOption) {
      expect(
        within(fullOption).getByText(RECOMMENDED_BADGE)
      ).toBeInTheDocument();
    }
  });

  it("renders each level's per-line data breakdown (FEA-4055)", () => {
    render(<SyncConsent onConfirm={vi.fn()} />);
    // Every level breaks the same four data categories down, so each label
    // appears once per level — three times across the fieldset.
    expect(screen.getAllByText(PROMPTS_LINE)).toHaveLength(3);
    expect(screen.getAllByText(SESSION_SHAPE_LINE)).toHaveLength(3);
    expect(screen.getAllByText(TOOL_ACTIVITY_LINE)).toHaveLength(3);
    expect(screen.getAllByText(TOOL_CONTENT_LINE)).toHaveLength(3);
  });

  it("splits tool-call activity from tool inputs/file contents so metadata is honest", () => {
    // Metadata syncs tool-call ACTIVITY (names & counts) but keeps tool inputs /
    // file contents local — the split the reviewer asked for so "stays local"
    // is not overclaimed on the metadata lane.
    render(<SyncConsent onConfirm={vi.fn()} />);
    const metadataOption = screen
      .getByRole("radio", { name: METADATA_OPTION })
      .closest("label");
    expect(metadataOption).not.toBeNull();
    if (metadataOption) {
      const activity = within(metadataOption).getByText(TOOL_ACTIVITY_LINE);
      const contents = within(metadataOption).getByText(TOOL_CONTENT_LINE);
      // Activity syncs; contents stay local. The sr-only egress suffix rides in
      // the same span as the label.
      expect(activity.textContent).toMatch(SYNCS_TO_CLOUD);
      expect(contents.textContent).toMatch(STAYS_ON_DEVICE);
    }
  });

  it("exposes each data line's egress status to assistive tech (FEA-4055)", () => {
    render(<SyncConsent onConfirm={vi.fn()} />);
    // The icon is decorative; the per-line consent info (syncs vs. stays local)
    // must reach screen readers via text, not icon color alone. Four lines per
    // level: Full syncs all four; Off keeps all four local; metadata splits two
    // sync / two local — so 4 + 0 + 2 = 6 "syncs to cloud" and 0 + 4 + 2 = 6
    // "stays on this device" across the set.
    expect(screen.getAllByText(SYNCS_TO_CLOUD)).toHaveLength(6);
    expect(screen.getAllByText(STAYS_ON_DEVICE)).toHaveLength(6);
  });

  it("renders per-level caveats for full and off but not metadata", () => {
    render(<SyncConsent onConfirm={vi.fn()} />);
    expect(screen.getByText(FULL_CAVEAT)).toBeInTheDocument();
    expect(screen.getByText(OFF_CAVEAT)).toBeInTheDocument();
    // Metadata is the no-caveat level; only two caveat strings exist on screen.
    const metadataOption = screen
      .getByRole("radio", { name: METADATA_OPTION })
      .closest("label");
    expect(metadataOption).not.toBeNull();
    if (metadataOption) {
      expect(within(metadataOption).queryByText(ANY_CAVEAT)).toBeNull();
    }
  });

  it("toggles selection independently between levels", () => {
    render(<SyncConsent onConfirm={vi.fn()} />);
    const full = screen.getByRole("radio", { name: FULL_OPTION });
    const off = screen.getByRole("radio", { name: OFF_OPTION });
    fireEvent.click(full);
    expect(full).toBeChecked();
    expect(off).not.toBeChecked();
    fireEvent.click(off);
    expect(off).toBeChecked();
    expect(full).not.toBeChecked();
  });

  it("confirms with the recommended 'metadata' level when clicked with no interaction", () => {
    const onConfirm = vi.fn();
    render(<SyncConsent onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(onConfirm).toHaveBeenCalledWith(DataSyncLevelValue.Metadata);
  });

  it("threads a wider level into the confirm payload only after the user opts up", () => {
    const onConfirm = vi.fn();
    render(<SyncConsent onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("radio", { name: FULL_OPTION }));
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(onConfirm).toHaveBeenCalledWith(DataSyncLevelValue.Full);
  });

  it("respects an explicit defaultLevel='off' and confirms with the canonical value", () => {
    const onConfirm = vi.fn();
    render(
      <SyncConsent
        defaultLevel={DataSyncLevelValue.Off}
        onConfirm={onConfirm}
      />
    );
    expect(screen.getByRole("radio", { name: OFF_OPTION })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(onConfirm).toHaveBeenCalledWith(DataSyncLevelValue.Off);
  });

  it("disables the Continue button while confirming", () => {
    render(<SyncConsent confirming onConfirm={vi.fn()} />);
    const button = screen.getByRole("button", { name: CONTINUE });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});

/**
 * ISS-5489 — the post-auth takeover starts from a DIFFERENT level than Settings,
 * and that divergence is a product decision (ISS-5249), not drift. These tests
 * exist so a future "cleanup" that collapses the two constants has to argue with
 * a named expectation instead of quietly widening — or narrowing — what one of
 * the two surfaces pre-selects.
 */
describe("takeover vs. Settings defaults", () => {
  it("keeps the takeover default deliberately different from the Settings default", () => {
    expect(DEFAULT_TAKEOVER_SYNC_LEVEL).not.toBe(DEFAULT_SYNC_LEVEL);
  });

  it("starts the takeover on Full and Settings on Metadata", () => {
    expect(DEFAULT_TAKEOVER_SYNC_LEVEL).toBe(DataSyncLevelValue.Full);
    expect(DEFAULT_SYNC_LEVEL).toBe(DataSyncLevelValue.Metadata);
  });

  it("badges the same level on both surfaces, whatever each pre-selects", () => {
    // ISS-5318: the divergence is the PRE-SELECTION only. A host cannot pass a
    // chip any more, so the takeover and onboarding cannot label different
    // levels with the same word — which is exactly what they used to do.
    const onboarding = render(
      <SyncLevelOptions onSelect={vi.fn()} selected={DEFAULT_SYNC_LEVEL} />
    );
    const onboardingBadged = badgedOptionTitle(onboarding.container);
    onboarding.unmount();

    const takeover = render(
      <SyncLevelOptions
        onSelect={vi.fn()}
        selected={DEFAULT_TAKEOVER_SYNC_LEVEL}
      />
    );
    expect(badgedOptionTitle(takeover.container)).toBe(onboardingBadged);
  });
});

// The title of the option carrying the Recommended chip, so two renders can be
// compared without depending on which level either one pre-selected.
function badgedOptionTitle(container: HTMLElement): string | undefined {
  return within(container)
    .getByText(RECOMMENDED_BADGE)
    .closest("label")
    ?.querySelector("span")?.textContent as string | undefined;
}

describe("SyncLevelOptions", () => {
  it("badges the most-permissive level, and only it", () => {
    render(
      <SyncLevelOptions onSelect={vi.fn()} selected={DataSyncLevelValue.Full} />
    );
    const badges = screen.getAllByText(RECOMMENDED_BADGE);
    expect(badges).toHaveLength(1);
    expect(
      screen.getByRole("radio", { name: FULL_OPTION }).closest("label")
    ).toContainElement(badges[0]);
  });

  it("renders all three levels and reports the picked one", () => {
    const onSelect = vi.fn();
    render(
      <SyncLevelOptions
        onSelect={onSelect}
        selected={DataSyncLevelValue.Full}
      />
    );
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: OFF_OPTION }));
    expect(onSelect).toHaveBeenCalledWith(DataSyncLevelValue.Off);
  });
});

/**
 * ISS-5489 regression: two consent surfaces were mountable at once (the pre-auth
 * flow's step and the post-auth takeover), and `SyncLevelOption` hardcoded
 * `name="sync-level"`. `name` is DOCUMENT-global, so all six radios joined ONE
 * native group: the browser kept a single input checked across both and
 * unchecked the rest WITHOUT firing React's onChange. On screen that read as "no
 * option is selected", "clicking does nothing", and — because each host's own
 * state was untouched — "Save persisted a level the UI never showed".
 */
describe("radio-group isolation between concurrent instances", () => {
  it("lets two mounted instances each hold their own selection", () => {
    render(
      <>
        <SyncLevelOptions
          onSelect={vi.fn()}
          selected={DataSyncLevelValue.Metadata}
        />
        <SyncLevelOptions
          onSelect={vi.fn()}
          selected={DataSyncLevelValue.Full}
        />
      </>
    );
    // With a shared `name` the DOM can only keep ONE of these checked, so the
    // second assertion fails — which is exactly what shipped.
    const metadata = screen.getAllByRole("radio", { name: METADATA_OPTION });
    const full = screen.getAllByRole("radio", { name: FULL_OPTION });
    expect(metadata[0]).toBeChecked();
    expect(full[1]).toBeChecked();
  });

  it("gives each instance a distinct radio-group name", () => {
    render(
      <>
        <SyncLevelOptions
          onSelect={vi.fn()}
          selected={DataSyncLevelValue.Metadata}
        />
        <SyncLevelOptions
          onSelect={vi.fn()}
          selected={DataSyncLevelValue.Metadata}
        />
      </>
    );
    const names = new Set(
      screen.getAllByRole("radio").map((r) => r.getAttribute("name"))
    );
    expect(names.size).toBe(2);
  });
});

describe("option order", () => {
  it("lists least-to-most exposure, matching the prototype", () => {
    // The prototype orders Off -> Metadata -> Full. Shipping the reverse put the
    // widest option first and read as a different screen from the agreed design.
    render(<SyncConsent onConfirm={vi.fn()} />);
    const labels = screen
      .getAllByRole("radio")
      .map((r) => r.getAttribute("aria-label"));
    expect(labels).toEqual(["Off", "Metadata only", "Full transcripts"]);
  });
});
