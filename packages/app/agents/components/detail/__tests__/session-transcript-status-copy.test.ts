import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { CloudOffIcon, CloudUploadIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  permanentUnavailableDescription,
  terminalUnavailablePresentation,
} from "../session-transcript-status-copy";

/**
 * ISS-9884 — the detail panel's third terminal headline. Both exports moved off
 * `isRecoverableTranscriptSkipReason` onto the reason itself, because a
 * two-valued predicate cannot address three states. These cases pin the words a
 * reader actually sees; the exhaustive `Record`s behind them are what stops a
 * future reason reaching this surface unworded, and `tsc` owns that half.
 */
describe("terminalUnavailablePresentation", () => {
  it("gives an environmentally-abandoned transcript its own paused headline", () => {
    const paused = terminalUnavailablePresentation(
      TranscriptSkipReason.EnvironmentUnavailable
    );
    expect(paused.title).toBe("Transcript upload paused");
    // Neither neighbour's icon is true of it: the lane has stopped attempting,
    // so the upload glyph would claim work in flight, and it is not a dead end,
    // so the cloud-off glyph would claim the transcript is never coming.
    expect(paused.icon).not.toBe(CloudUploadIcon);
    expect(paused.icon).not.toBe(CloudOffIcon);
  });

  it("leaves the hard and recoverable headlines exactly where they were", () => {
    // `retries_exhausted` is the control that matters most: every installed
    // desktop that never upgrades keeps sending it, and its panel must not move.
    for (const reason of [
      TranscriptSkipReason.TooLarge,
      TranscriptSkipReason.SourceGone,
      TranscriptSkipReason.RetriesExhausted,
    ]) {
      const presentation = terminalUnavailablePresentation(reason);
      expect(presentation.title).toBe("Transcript not archived");
      expect(presentation.icon).toBe(CloudOffIcon);
    }
    const materialized = terminalUnavailablePresentation(
      TranscriptSkipReason.MaterializedSourceUnavailable
    );
    expect(materialized.title).toBe("Transcript still syncing");
    expect(materialized.icon).toBe(CloudUploadIcon);
  });

  it("degrades an unknown/legacy reason to the hard headline", () => {
    // `null` is what the reader hands back for a label this build cannot name
    // (an older API row, or a newer desktop's reason). It must never borrow the
    // recoverable or the paused presentation.
    const unknown = terminalUnavailablePresentation(null);
    expect(unknown.title).toBe("Transcript not archived");
    expect(unknown.icon).toBe(CloudOffIcon);
  });
});

describe("permanentUnavailableDescription", () => {
  it("tells an environmental give-up apart from the repeated-attempts sentence it replaces", () => {
    const paused = permanentUnavailableDescription(
      TranscriptSkipReason.EnvironmentUnavailable
    );
    expect(paused).toBe(
      "The machine stopped trying because this workspace’s transcript archive isn’t available. It resumes automatically once that’s restored."
    );
    expect(paused).not.toBe(
      permanentUnavailableDescription(TranscriptSkipReason.RetriesExhausted)
    );
  });

  it("words every reason in the enum, and the unknown fallback, non-emptily", () => {
    // Runtime half of the exhaustive `Record`: a reason added without copy
    // answers `undefined` here rather than rendering a blank paragraph.
    for (const reason of Object.values(TranscriptSkipReason)) {
      expect(permanentUnavailableDescription(reason).length).toBeGreaterThan(0);
    }
    expect(permanentUnavailableDescription(null).length).toBeGreaterThan(0);
  });
});
