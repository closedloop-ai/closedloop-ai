import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SyncFootnote } from "../sync-footnote";
import {
  SYNC_FOOTNOTE_LABELS,
  SyncFootnoteState,
} from "../sync-footnote-state";

// The exact string three tickets (FEA-2206, ISS-4710, ISS-4716) were filed to
// remove, kept verbatim so a reintroduction fails rather than drifts.
const LEGACY_COPY = "Computed on this device · 0 bytes uploaded";
// Module-scoped so the matcher isn't recompiled per assertion (useTopLevelRegex).
const HARDCODED_BYTE_CLAIM = /0 bytes/;

afterEach(() => {
  cleanup();
});

describe("SyncFootnote (ISS-4716, shipped unflagged by ISS-5348)", () => {
  it("renders a skeleton with no text while the status read is unresolved", () => {
    // Copy that appears and is then replaced is a reflow, and a placeholder
    // string invites reading a pending status as a settled one.
    render(<SyncFootnote state={SyncFootnoteState.Loading} />);
    const skeleton = screen.getByLabelText("Loading upload status");
    expect(skeleton).toBeTruthy();
    expect(skeleton.textContent).toBe("");
  });

  it.each(
    Object.values(SyncFootnoteState).filter(
      (state) => state !== SyncFootnoteState.Loading
    )
  )("renders the mapped label for %s", (state) => {
    const { container } = render(<SyncFootnote state={state} />);
    expect(container.textContent).toContain(SYNC_FOOTNOTE_LABELS[state]);
  });

  it("keeps loading, not-computed, and true-zero distinguishable", () => {
    // ISS-4716's actual point, and the reason this component refuses to print a
    // byte figure at all: these three are different facts and must not collapse
    // into one string. `Loading` is a textless skeleton; `Unavailable` says the
    // status could not be read; `Enabled` is a settled, working lane.
    render(<SyncFootnote state={SyncFootnoteState.Loading} />);
    expect(screen.getByLabelText("Loading upload status").textContent).toBe("");
    cleanup();

    const notComputed = render(
      <SyncFootnote state={SyncFootnoteState.Unavailable} />
    );
    const notComputedText = notComputed.container.textContent;
    cleanup();

    const settled = render(<SyncFootnote state={SyncFootnoteState.Enabled} />);
    const settledText = settled.container.textContent;

    expect(notComputedText).toBe(
      SYNC_FOOTNOTE_LABELS[SyncFootnoteState.Unavailable]
    );
    expect(settledText).toBe(SYNC_FOOTNOTE_LABELS[SyncFootnoteState.Enabled]);
    expect(notComputedText).not.toBe(settledText);
  });

  it("never renders the misleading legacy copy in any state", () => {
    // ISS-5348: previously this only held "once the flag is on", while the
    // flag-off path — the one every user was actually on — returned the legacy
    // node verbatim. There is no longer a state that can produce it.
    for (const state of Object.values(SyncFootnoteState)) {
      const { container, unmount } = render(<SyncFootnote state={state} />);
      expect(container.textContent).not.toContain(LEGACY_COPY);
      expect(container.textContent).not.toMatch(HARDCODED_BYTE_CLAIM);
      unmount();
    }
  });

  it("keeps its icon decorative so the label carries the accessible name", () => {
    const { container } = render(
      <SyncFootnote state={SyncFootnoteState.Failed} />
    );
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).toContain(
      SYNC_FOOTNOTE_LABELS[SyncFootnoteState.Failed]
    );
  });
});
