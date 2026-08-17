/**
 * FEA-4022 (PLN-1481): the cloud persists the desktop-computed frustration
 * signal into `SessionDetail.frustration_raw` / `frustration_score_version` ONLY
 * when the org opted into `calculateSessionFrustration`. The gate is applied at
 * ingest via `toTraceDetailPatch(session, { includeFrustration })`. These tests
 * pin that the fields are written when opted in, omitted when opted out (so the
 * column stays NULL / preserves any prior value), and that omission by the
 * desktop is preserved even when the org has opted in.
 */
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { toTraceDetailPatch } from "./persist-session-children";

function baseSession(
  extras: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-1",
    status: "active",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...extras,
  };
}

describe("toTraceDetailPatch — frustration gate (FEA-4022)", () => {
  it("writes the raw signal + version when the org opted in", () => {
    const patch = toTraceDetailPatch(
      baseSession({ frustrationRaw: 42, frustrationScoreVersion: 1 }),
      { includeFrustration: true }
    );
    expect(patch.frustrationRaw).toBe(42);
    expect(patch.frustrationScoreVersion).toBe(1);
  });

  it("omits the frustration fields entirely when the org has NOT opted in", () => {
    const patch = toTraceDetailPatch(
      baseSession({ frustrationRaw: 42, frustrationScoreVersion: 1 }),
      { includeFrustration: false }
    );
    // Not present on the patch at all → the upsert neither writes nor clears the
    // column (it stays NULL for an opted-out org, even though the payload carried
    // a value).
    expect("frustrationRaw" in patch).toBe(false);
    expect("frustrationScoreVersion" in patch).toBe(false);
  });

  it("omits the frustration fields when no options are passed (default off)", () => {
    const patch = toTraceDetailPatch(
      baseSession({ frustrationRaw: 42, frustrationScoreVersion: 1 })
    );
    expect("frustrationRaw" in patch).toBe(false);
    expect("frustrationScoreVersion" in patch).toBe(false);
  });

  it("preserves desktop omission even when opted in (older build sends neither)", () => {
    const patch = toTraceDetailPatch(baseSession(), {
      includeFrustration: true,
    });
    // The desktop sent no frustration fields → undefined patch entries, so the
    // upsert leaves any previously stored value untouched.
    expect(patch.frustrationRaw).toBeUndefined();
    expect(patch.frustrationScoreVersion).toBeUndefined();
  });
});

describe("toTraceDetailPatch — endsWithError (ISS-4586)", () => {
  it("writes the boolean flag the desktop synced when the batch is fresh", () => {
    expect(
      toTraceDetailPatch(baseSession({ endsWithError: true }), {
        includeEndsWithError: true,
      }).endsWithError
    ).toBe(true);
    expect(
      toTraceDetailPatch(baseSession({ endsWithError: false }), {
        includeEndsWithError: true,
      }).endsWithError
    ).toBe(false);
  });

  it("carries an explicit null as an intentional clear when fresh", () => {
    const patch = toTraceDetailPatch(baseSession({ endsWithError: null }), {
      includeEndsWithError: true,
    });
    expect("endsWithError" in patch).toBe(true);
    expect(patch.endsWithError).toBeNull();
  });

  it("omits the field when an older desktop build sends nothing (preserves stored value)", () => {
    const patch = toTraceDetailPatch(baseSession(), {
      includeEndsWithError: true,
    });
    // undefined → not on the patch → the upsert neither writes nor clears the
    // column, so a stored flag from a prior sync survives.
    expect("endsWithError" in patch).toBe(false);
  });

  it("omits the field when the batch is STALE, so a late older sync can't regress the flag", () => {
    // A delayed retry of an older batch (updatedAt < persisted sessionUpdatedAt)
    // resolves includeEndsWithError=false at the caller. Even though this payload
    // carries endsWithError=true, the gate keeps it off the patch so a newer
    // sync's recovered `false` is never overwritten with a stale `true` — which
    // would mis-classify the reaped session ERROR instead of INACTIVE.
    const patch = toTraceDetailPatch(baseSession({ endsWithError: true }), {
      includeEndsWithError: false,
    });
    expect("endsWithError" in patch).toBe(false);
  });

  it("omits the field when no options are passed (default off)", () => {
    const patch = toTraceDetailPatch(baseSession({ endsWithError: true }));
    expect("endsWithError" in patch).toBe(false);
  });
});

describe("toTraceDetailPatch — trace-duration freshness gate (ISS-4688)", () => {
  const DURATIONS = {
    wallClock: "3h 33m",
    activeAgent: "27h 8m",
    waitingUser: "41s",
  } as const;

  it("writes the whole trace-duration triple when the batch is fresh", () => {
    const patch = toTraceDetailPatch(baseSession(DURATIONS), {
      includeTraceDurations: true,
    });
    expect(patch.wallClock).toBe(DURATIONS.wallClock);
    expect(patch.activeAgent).toBe(DURATIONS.activeAgent);
    expect(patch.waitingUser).toBe(DURATIONS.waitingUser);
  });

  it("omits the triple when the batch is STALE, so an older-after-newer delivery can't pin Duration to the old value", () => {
    // wongk (#4121): a delayed sync arriving at the SAME dataRevision, after a
    // newer one already landed, resolves includeTraceDurations=false at the
    // caller. The stale wallClock must stay off the patch entirely — writing it
    // would overwrite the newer stored value and pin the Sessions list cell, the
    // detail Duration card, and the Properties row (which now share one
    // derivation) to the older number.
    const patch = toTraceDetailPatch(baseSession(DURATIONS), {
      includeTraceDurations: false,
    });
    expect("wallClock" in patch).toBe(false);
    expect("activeAgent" in patch).toBe(false);
    expect("waitingUser" in patch).toBe(false);
  });

  it("gates the triple TOGETHER so a stale batch cannot pair a new active with an old wall", () => {
    // The three are one decomposition (`wall` headline, `active`/`waiting`
    // sub-facts). Gating only the headline would let a stale batch write
    // activeAgent against a preserved newer wallClock and render an internally
    // inconsistent row — a worse failure than the one being fixed.
    const stale = toTraceDetailPatch(baseSession(DURATIONS), {
      includeTraceDurations: false,
    });
    const written = ["wallClock", "activeAgent", "waitingUser"].filter(
      (key) => key in stale
    );
    expect(written).toEqual([]);
  });

  it("still writes the triple when no options are passed, preserving the previous caller contract", () => {
    // Version-skew / compatibility: an existing caller that has not opted into
    // the gate keeps the pre-ISS-4688 write-always behavior rather than silently
    // dropping durations.
    const patch = toTraceDetailPatch(baseSession(DURATIONS));
    expect(patch.wallClock).toBe(DURATIONS.wallClock);
    expect(patch.activeAgent).toBe(DURATIONS.activeAgent);
    expect(patch.waitingUser).toBe(DURATIONS.waitingUser);
  });
});
