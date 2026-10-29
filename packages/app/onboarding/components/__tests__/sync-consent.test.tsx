import {
  DataSyncLevel,
  RECOMMENDED_DATA_SYNC_LEVEL,
} from "@repo/api/src/types/data-sync-level";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSyncLevelPicker } from "../../../shared/components/data-sync-level-picker";
import { DATA_SYNC_LEVEL_COPY } from "../../../shared/lib/data-sync-copy";
import {
  SYNC_CONSENT_LEVELS,
  SYNC_LEVEL_GROUP_LABEL,
  SyncConsent,
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
const FULL_CAVEAT =
  /transcripts, prompts, and file contents sync to the cloud/i;
const OFF_CAVEAT = /won't be able to sync across machines/i;
const ANY_CAVEAT = /for complete analysis|sync across machines/i;
const RECOMMENDED_BADGE = /recommended/i;
const SYNCS_TO_CLOUD = /syncs to cloud/i;
const STAYS_ON_DEVICE = /stays on this device/i;

describe("SyncConsent", () => {
  it("requires a choice even when a level is recommended", () => {
    // A recommendation does not record a choice (ISS-12523).
    expect(RECOMMENDED_DATA_SYNC_LEVEL).toBe(DataSyncLevel.Full);
    render(<SyncConsent onConfirm={vi.fn()} />);
    expect(screen.getByRole("radio", { name: FULL_OPTION })).not.toBeChecked();
  });

  it("uses canonical DataSyncLevel values, not the legacy tier vocabulary", () => {
    // The consolidation moved onboarding onto the canonical DataSyncLevel value
    // set — the value the setter consumes uses `off`, never the old `local`.
    expect(RECOMMENDED_DATA_SYNC_LEVEL).not.toBe("local");
  });

  it("renders the heading", () => {
    render(<SyncConsent onConfirm={vi.fn()} />);
    expect(screen.getByRole("heading", { name: HEADING })).toBeInTheDocument();
  });

  it("starts with no selected level", () => {
    render(<SyncConsent onConfirm={vi.fn()} />);
    const full = screen.getByRole("radio", { name: FULL_OPTION });
    const metadata = screen.getByRole("radio", { name: METADATA_OPTION });
    const off = screen.getByRole("radio", { name: OFF_OPTION });
    expect(full).not.toBeChecked();
    expect(metadata).not.toBeChecked();
    expect(off).not.toBeChecked();
  });

  it("marks the most-permissive level with a single Recommended badge", () => {
    // ISS-5318: the chip comes from `dataSyncLevelBadge`, so onboarding endorses
    // the SAME level Settings does.
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

  it("does not confirm an unanswered policy", () => {
    const onConfirm = vi.fn();
    render(<SyncConsent onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("threads a narrower level into the confirm payload after the user opts down", () => {
    // The consent step still records a CHOICE: opting down from the
    // recommendation must reach the host, or the screen is decorative.
    const onConfirm = vi.fn();
    render(<SyncConsent onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("radio", { name: OFF_OPTION }));
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(onConfirm).toHaveBeenCalledWith(DataSyncLevel.Off);
  });

  it("respects an explicit defaultLevel='off' and confirms with the canonical value", () => {
    const onConfirm = vi.fn();
    render(
      <SyncConsent defaultLevel={DataSyncLevel.Off} onConfirm={onConfirm} />
    );
    expect(screen.getByRole("radio", { name: OFF_OPTION })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(onConfirm).toHaveBeenCalledWith(DataSyncLevel.Off);
  });

  it("disables the Continue button while confirming", () => {
    render(<SyncConsent confirming onConfirm={vi.fn()} />);
    const button = screen.getByRole("button", { name: CONTINUE });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});

/**
 * ISS-6147 review: there is ONE recommended level and every consent surface
 * starts on it. This replaces the ISS-5249 split, where the takeover started on
 * Full and onboarding on Metadata — two constants whose whole job was to differ.
 */
describe("consent surfaces agree on where they start", () => {
  it("badges the recommended level regardless of what a host pre-selects", () => {
    // The chip is an endorsement, not a cursor: a surface that opens on a
    // narrower level (a user who previously chose Off) must still show the
    // recommendation on the level the product recommends.
    const opened = render(
      <DataSyncLevelPicker
        label={SYNC_LEVEL_GROUP_LABEL}
        levels={SYNC_CONSENT_LEVELS}
        onSelect={vi.fn()}
        selected={DataSyncLevel.Off}
      />
    );
    expect(badgedOptionTitle(opened.container)).toBe(
      DATA_SYNC_LEVEL_COPY[RECOMMENDED_DATA_SYNC_LEVEL].title
    );
  });
});

// The title of the option carrying the Recommended chip — read off that option's
// radio, whose accessible name IS the level title — so two renders can be
// compared without depending on which level either one pre-selected.
function badgedOptionTitle(container: HTMLElement): string | null | undefined {
  return within(container)
    .getByText(RECOMMENDED_BADGE)
    .closest("label")
    ?.querySelector('[role="radio"]')
    ?.getAttribute("aria-label");
}

describe("DataSyncLevelPicker", () => {
  it("badges the most-permissive level, and only it", () => {
    render(
      <DataSyncLevelPicker
        label={SYNC_LEVEL_GROUP_LABEL}
        levels={SYNC_CONSENT_LEVELS}
        onSelect={vi.fn()}
        selected={DataSyncLevel.Full}
      />
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
      <DataSyncLevelPicker
        label={SYNC_LEVEL_GROUP_LABEL}
        levels={SYNC_CONSENT_LEVELS}
        onSelect={onSelect}
        selected={DataSyncLevel.Full}
      />
    );
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: OFF_OPTION }));
    expect(onSelect).toHaveBeenCalledWith(DataSyncLevel.Off);
  });
});

/**
 * ISS-5489 regression: two consent surfaces were mountable at once (the pre-auth
 * flow's step and the post-auth takeover), and the option hardcoded
 * `name="sync-level"`. `name` is DOCUMENT-global, so all six native radios joined
 * ONE group: the browser kept a single input checked across both and unchecked
 * the rest WITHOUT firing React's onChange. On screen that read as "no option is
 * selected", "clicking does nothing", and — because each host's own state was
 * untouched — "Save persisted a level the UI never showed".
 *
 * ISS-6147 moved both surfaces onto one Radix-backed picker, which is a
 * roving-tabindex group with no document-global `name`, so the collision cannot
 * be expressed any more. The old companion assertion ("each instance gets a
 * distinct radio-group name") was pinning that native implementation detail and
 * is gone; what it was protecting — two mounted instances holding independent
 * selections — is asserted below and still fails if that ever regresses.
 */
describe("radio-group isolation between concurrent instances", () => {
  it("lets two mounted instances each hold their own selection", () => {
    render(
      <>
        <DataSyncLevelPicker
          label={SYNC_LEVEL_GROUP_LABEL}
          levels={SYNC_CONSENT_LEVELS}
          onSelect={vi.fn()}
          selected={DataSyncLevel.Metadata}
        />
        <DataSyncLevelPicker
          label={SYNC_LEVEL_GROUP_LABEL}
          levels={SYNC_CONSENT_LEVELS}
          onSelect={vi.fn()}
          selected={DataSyncLevel.Full}
        />
      </>
    );
    // Under the old native-radio implementation the DOM could keep only ONE of
    // these checked, so the second assertion failed — which is exactly what
    // shipped.
    const metadata = screen.getAllByRole("radio", { name: METADATA_OPTION });
    const full = screen.getAllByRole("radio", { name: FULL_OPTION });
    expect(metadata[0]).toBeChecked();
    expect(full[1]).toBeChecked();
  });
});

describe("option order", () => {
  it("renders the shared display order, most-permissive first", () => {
    // ISS-6147: the sequence is not this surface's to choose. `DataSyncLevelPicker`
    // sorts by the canonical `DATA_SYNC_LEVELS` ranking, and the desktop Settings
    // tab renders through that same picker, so the two cannot lead with different
    // levels.
    // Supersedes the ISS-5489 prototype's least-to-most order; the
    // PRE-SELECTION is still the safe floor (asserted above), which is the part
    // that governs what a user consents to.
    render(<SyncConsent onConfirm={vi.fn()} />);
    const labels = screen
      .getAllByRole("radio")
      .map((r) => r.getAttribute("aria-label"));
    expect(labels).toEqual(["Full transcripts", "Metadata only", "Off"]);
  });
});
