import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { describe, expect, it } from "vitest";
import { resolveTranscriptNeverExpected } from "../transcript-never-expected-from-sync-level";

/**
 * ISS-7516 (web half) — the fold from the served `dataSyncLevel` to the panel's
 * three-valued `transcriptNeverExpected`.
 *
 * The whole risk in this module is a MISSING level being turned into a verdict.
 * Both directions are silent failures in production and neither is visible from
 * the render:
 *
 * - defaulting absence to a transcript-excluding level stamps "this is never
 *   coming" over every session served by a server that has not deployed the
 *   field yet — a new falsehood, told to more people than the old one;
 * - defaulting it to `full` disables the disclosure while every dashboard still
 *   reports the feature as on.
 *
 * So the absent case is asserted directly, and asserted to be `undefined`
 * specifically rather than merely falsy — `false` is a CLAIM ("a transcript is
 * expected"), and the panel renders it as one.
 */

describe("resolveTranscriptNeverExpected", () => {
  describe("when the server reports no level", () => {
    it("returns undefined — not false — so the panel renders today's copy", () => {
      // `toBeUndefined`, not `toBeFalsy`: `false` would pass a falsy assertion
      // while telling the reader a transcript IS on its way, which is the
      // pre-existing falsehood this ticket removes.
      expect(
        resolveTranscriptNeverExpected({ dataSyncLevel: undefined }, undefined)
      ).toBeUndefined();
    });

    it("falls back to the shell's own answer, preserving the desktop behaviour #5713 shipped", () => {
      // Version skew: a current desktop against a server that predates the
      // column. Losing this would silently un-ship #5713 for those users.
      expect(
        resolveTranscriptNeverExpected({ dataSyncLevel: undefined }, true)
      ).toBe(true);
      expect(
        resolveTranscriptNeverExpected({ dataSyncLevel: undefined }, false)
      ).toBe(false);
    });
  });

  describe("when the server reports the producing machine's level", () => {
    it("reports a never-expected transcript for every level that excludes them", () => {
      // `redacted` is the one worth naming: it reads like a partial-transcript
      // level and is not — it maps to the `metadata` observability tier, which
      // queues nothing. `off` cannot normally reach the cloud at all, but a
      // session synced before a downgrade can carry it, and it excludes
      // transcripts just the same.
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: DataSyncLevel.Metadata },
          undefined
        )
      ).toBe(true);
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: DataSyncLevel.Redacted },
          undefined
        )
      ).toBe(true);
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: DataSyncLevel.Off },
          undefined
        )
      ).toBe(true);
    });

    it("reports NOT never-expected on the one level that does carry transcripts", () => {
      // The POSITIVE sibling for the case above, on the same function: without
      // it, a fold that returned `true` unconditionally would pass every
      // assertion in the previous case.
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: DataSyncLevel.Full },
          undefined
        )
      ).toBe(false);
    });
  });

  describe("precedence between the served level and the shell's answer", () => {
    it("lets the served level overrule a shell that answered false", () => {
      // The cross-machine case, and the reason the ordering is not arbitrary.
      // #5713's desktop hook answers `false` for a session recorded on ANOTHER
      // machine, because it can only see its own device consent. The server
      // knows that other machine's level. Taking the shell's `false` here would
      // suppress a true disclosure on every colleague's session.
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: DataSyncLevel.Metadata },
          false
        )
      ).toBe(true);
    });

    it("lets the served level overrule a shell that answered true", () => {
      // The mirror, so the case above cannot pass on a fold that merely ORs the
      // two together. A `full`-level machine's in-flight upload must keep the
      // pending copy even if the local shell guessed otherwise.
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: DataSyncLevel.Full },
          true
        )
      ).toBe(false);
    });
  });

  describe("an unrecognized served level is no evidence, not a verdict", () => {
    // Review cid 3840055937. The HTTP detail read CASTS the parsed JSON, so the
    // `DataSyncLevel` annotation is a compile-time claim about a runtime value
    // the server chose. The fold is negative-by-default — every level except
    // `full` yields `true` — so an unknown string is not a harmless passthrough:
    // untreated it becomes a positive claim to the reader that the transcript is
    // never coming, which is the exact falsehood ISS-7516 exists to remove.
    //
    // `UNKNOWN_SERVED_LEVEL` is deliberately NOT a member of `DataSyncLevel` and
    // is cast at the call site only, because the whole point is a value the type
    // forbids and the wire permits.
    const UNKNOWN_SERVED_LEVEL = "quarantined" as DataSyncLevel;

    it("falls through to the shell's answer, exactly as an absent level does", () => {
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: UNKNOWN_SERVED_LEVEL },
          true
        )
      ).toBe(true);
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: UNKNOWN_SERVED_LEVEL },
          false
        )
      ).toBe(false);
    });

    it("stays undefined when the shell has no answer either", () => {
      // The case that separates "narrowed to undefined" from "coerced to false".
      // Returning `false` here would make the panel state that the transcript IS
      // still coming, on no evidence at all.
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: UNKNOWN_SERVED_LEVEL },
          undefined
        )
      ).toBeUndefined();
    });

    it("still reads a level this build DOES know", () => {
      // Anti-vacuity: without it, narrowing everything to `undefined` would pass
      // all three cases above and silently un-ship the web half entirely.
      expect(
        resolveTranscriptNeverExpected(
          { dataSyncLevel: DataSyncLevel.Metadata },
          undefined
        )
      ).toBe(true);
    });
  });
});
