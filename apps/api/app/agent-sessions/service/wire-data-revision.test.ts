/**
 * ISS-8271: the per-session `dataRevision` disposition matrix.
 *
 * This module is what preserves FEA-3595's anti-poison guarantee now that the
 * ingress schema no longer rejects out-of-window revisions (rejection there was
 * batch-wide and stranded sessions permanently — see the module doc). These
 * tests pin the full matrix so a future edit cannot quietly re-admit a
 * sentinel or a poison value to the gating/commit path.
 */
import { MAX_SUPPORTED_DATA_REVISION } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  resolveWireDataRevisionDisposition,
  WireDataRevisionSkipReason,
} from "./wire-data-revision";

/** Postgres `int4` max — the poison value FEA-3595 bounded out. */
const POSTGRES_INT_MAX = 2_147_483_647;

describe("resolveWireDataRevisionDisposition (ISS-8271)", () => {
  it("passes a real revision through untouched", () => {
    expect(
      resolveWireDataRevisionDisposition({ dataRevision: 90, isChunked: false })
    ).toEqual({ kind: "use", revision: 90 });
    expect(
      resolveWireDataRevisionDisposition({ dataRevision: 1, isChunked: true })
    ).toEqual({ kind: "use", revision: 1 });
    expect(
      resolveWireDataRevisionDisposition({
        dataRevision: MAX_SUPPORTED_DATA_REVISION,
        isChunked: false,
      })
    ).toEqual({ kind: "use", revision: MAX_SUPPORTED_DATA_REVISION });
  });

  it("preserves absence and null exactly as sent", () => {
    expect(
      resolveWireDataRevisionDisposition({
        dataRevision: undefined,
        isChunked: false,
      })
    ).toEqual({ kind: "use", revision: undefined });
    expect(
      resolveWireDataRevisionDisposition({
        dataRevision: null,
        isChunked: true,
      })
    ).toEqual({ kind: "use", revision: null });
  });

  it("folds unchunked sentinel 0 (maintenance-stale) to no-revision", () => {
    expect(
      resolveWireDataRevisionDisposition({ dataRevision: 0, isChunked: false })
    ).toEqual({ kind: "use", revision: undefined });
  });

  it("skips chunked sentinel 0 — the gate cannot stage a null-revision sequence", () => {
    expect(
      resolveWireDataRevisionDisposition({ dataRevision: 0, isChunked: true })
    ).toEqual({
      kind: "skip",
      reason: WireDataRevisionSkipReason.RevisionPending,
    });
  });

  it("skips sentinel -1 (import-pending) in every shape — never folds partial content", () => {
    for (const isChunked of [false, true]) {
      expect(
        resolveWireDataRevisionDisposition({ dataRevision: -1, isChunked })
      ).toEqual({
        kind: "skip",
        reason: WireDataRevisionSkipReason.RevisionPending,
      });
    }
  });

  it("skips any other negative value as pending", () => {
    expect(
      resolveWireDataRevisionDisposition({ dataRevision: -7, isChunked: false })
    ).toEqual({
      kind: "skip",
      reason: WireDataRevisionSkipReason.RevisionPending,
    });
  });

  it("skips a too-new revision instead of dead-lettering the desktop (FEA-3595 skew hold)", () => {
    expect(
      resolveWireDataRevisionDisposition({
        dataRevision: MAX_SUPPORTED_DATA_REVISION + 1,
        isChunked: false,
      })
    ).toEqual({
      kind: "skip",
      reason: WireDataRevisionSkipReason.RevisionTooNew,
    });
  });

  it("keeps the int4-max poison value away from the high-water mark", () => {
    expect(
      resolveWireDataRevisionDisposition({
        dataRevision: POSTGRES_INT_MAX,
        isChunked: false,
      })
    ).toEqual({
      kind: "skip",
      reason: WireDataRevisionSkipReason.RevisionTooNew,
    });
  });
});
