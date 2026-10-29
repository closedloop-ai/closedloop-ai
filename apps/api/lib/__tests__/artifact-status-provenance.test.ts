/**
 * ISS-9436 — what a CLAIMED edit surface is allowed to become.
 *
 * Two decisions live in `resolveStatusProvenance` and nowhere else, so they are
 * proved here rather than through a route:
 *  - a grouped surface (`board`, `bulk`) always leaves with a commit group;
 *  - a non-first-party caller's claimed surface is DROPPED, so an API key
 *    cannot forge UI provenance onto a receipt or onto the analytics event.
 */
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { describe, expect, it } from "vitest";
import { resolveStatusProvenance } from "../artifact-status-provenance";

describe("resolveStatusProvenance", () => {
  it("returns nothing when the caller named no surface", () => {
    expect(
      resolveStatusProvenance({ surface: undefined, authMethod: "session" })
    ).toBeUndefined();
  });

  it.each([
    ArtifactStatusEditSurface.Detail,
    ArtifactStatusEditSurface.InlineCell,
  ])("carries %s with NO commit group — it moves one row", (surface) => {
    const provenance = resolveStatusProvenance({
      surface,
      authMethod: "session",
    });

    expect(provenance).toEqual({ surface });
    expect("commitGroupId" in (provenance as object)).toBe(false);
  });

  it.each([ArtifactStatusEditSurface.Board, ArtifactStatusEditSurface.Bulk])(
    "mints a commit group for the grouped surface %s",
    (surface) => {
      const provenance = resolveStatusProvenance({
        surface,
        authMethod: "session",
      });

      expect(provenance?.surface).toBe(surface);
      expect(typeof provenance?.commitGroupId).toBe("string");
      expect(provenance?.commitGroupId?.length).toBeGreaterThan(0);
    }
  );

  it("mints a DISTINCT group per commit, so two commits never merge", () => {
    const first = resolveStatusProvenance({
      surface: ArtifactStatusEditSurface.Bulk,
      authMethod: "session",
    });
    const second = resolveStatusProvenance({
      surface: ArtifactStatusEditSurface.Bulk,
      authMethod: "session",
    });

    expect(first?.commitGroupId).not.toBe(second?.commitGroupId);
  });

  it.each([
    ArtifactStatusEditSurface.Board,
    ArtifactStatusEditSurface.Bulk,
    ArtifactStatusEditSurface.Detail,
    ArtifactStatusEditSurface.InlineCell,
    ArtifactStatusEditSurface.RowAction,
  ])("DROPS a %s surface forged by an API-key caller", (surface) => {
    // The whole taxonomy, not just the grouped pair: an `sk_live_*` script can
    // put any member in the body, and none of them describes a UI a human
    // touched. Unattributed is the honest record.
    expect(
      resolveStatusProvenance({ surface, authMethod: "api_key" })
    ).toBeUndefined();
  });

  it("keeps a desktop session's surface — it IS a first-party UI", () => {
    expect(
      resolveStatusProvenance({
        surface: ArtifactStatusEditSurface.Detail,
        authMethod: "desktop_session",
      })
    ).toEqual({ surface: ArtifactStatusEditSurface.Detail });
  });
});
