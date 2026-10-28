/**
 * ISS-7669: which clock the session-grain `lastContributedAt` fallback reads.
 *
 * The production call site passes `resolveArtifactContributionAt(session)` into
 * `persistArtifactLinks`, and TypeScript already enforces that an argument is
 * passed at all (dropping it is `TS2554: Expected 6 arguments, but got 5`). What
 * types cannot enforce is WHICH clock it resolves — swapping the ladder for
 * `new Date()` would compile and every other suite would stay green.
 *
 * That substitution is the defect this pins. An ingest clock flattens a whole
 * offline backlog onto the minute it was processed and re-dates a long-lived
 * session's edges on every re-sync, so "newest contribution" silently becomes
 * "most recently ingested". Every tier below is bounded by the session itself.
 */
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { resolveArtifactContributionAt } from "./session-slice-links";

const UPDATED_AT = "2026-08-22T12:00:00.000Z";
const ENDED_AT = "2026-08-22T11:00:00.000Z";
const LAST_ACTIVITY_AT = "2026-08-22T10:00:00.000Z";

/**
 * The three tiers are deliberately ordered OLDEST-first here, opposite to the
 * ladder's precedence. A "just take the newest timestamp" implementation would
 * return `updatedAt` in every case below and pass a same-order fixture.
 */
function session(overrides: Partial<SyncedAgentSession>): SyncedAgentSession {
  return {
    externalSessionId: "ext-1",
    startedAt: "2026-08-22T08:00:00.000Z",
    updatedAt: UPDATED_AT,
    ...overrides,
  } as SyncedAgentSession;
}

describe("resolveArtifactContributionAt (ISS-7669)", () => {
  it("prefers the genuine-activity clock over every other tier", () => {
    // `updatedAt` is bumped by OTEL ingest, enrichment, and sync bookkeeping
    // that is not activity, so it must lose to `lastActivityAt` even when it is
    // the LATER of the two.
    expect(
      resolveArtifactContributionAt(
        session({
          lastActivityAt: LAST_ACTIVITY_AT,
          endedAt: ENDED_AT,
          updatedAt: UPDATED_AT,
        })
      )
    ).toEqual(new Date("2026-08-22T10:00:00.000Z"));
  });

  it("falls to the end instant when no activity clock was sent", () => {
    // An older desktop build that predates `lastActivityAt`.
    expect(
      resolveArtifactContributionAt(
        session({ endedAt: ENDED_AT, updatedAt: UPDATED_AT })
      )
    ).toEqual(new Date("2026-08-22T11:00:00.000Z"));
  });

  it("falls to the update instant when the session states neither", () => {
    // `updatedAt` is required on the payload, so the ladder always resolves and
    // never needs a clock read.
    expect(resolveArtifactContributionAt(session({}))).toEqual(
      new Date("2026-08-22T12:00:00.000Z")
    );
  });

  it("skips a null activity clock rather than treating it as a value", () => {
    // The field is `string | null | undefined`; an explicit null must fall
    // through, not resolve to the epoch.
    expect(
      resolveArtifactContributionAt(
        session({ lastActivityAt: null, endedAt: ENDED_AT })
      )
    ).toEqual(new Date("2026-08-22T11:00:00.000Z"));
  });

  it("returns a backlogged session's own instant, not the ingest wall-clock", () => {
    // The regression this file exists for, stated without reading a clock: a
    // session that ran seven weeks before every other fixture here still
    // reports July, so an implementation returning "now" cannot satisfy it.
    expect(
      resolveArtifactContributionAt(
        session({ lastActivityAt: "2026-07-01T09:00:00.000Z" })
      )
    ).toEqual(new Date("2026-07-01T09:00:00.000Z"));
  });
});
