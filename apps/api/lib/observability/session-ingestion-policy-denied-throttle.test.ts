import { describe, expect, it } from "vitest";
import { SessionIngestionDenialReason } from "./session-ingestion-metrics";
import { SessionIngestionPolicyDeniedThrottle } from "./session-ingestion-policy-denied-throttle";

const ORG_ID = "org-1";
const REASON = SessionIngestionDenialReason.PolicyDisabled;
const WINDOW_MS = 60_000;

describe("SessionIngestionPolicyDeniedThrottle", () => {
  it("emits the FIRST denial in a window and nothing after it in the same window", () => {
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
    });

    const first = throttle.record(ORG_ID, REASON, 0);
    expect(first).toEqual({ emit: true, flushedSuppressedCount: 0 });

    // A replayed burst inside the same window emits nothing — this is the
    // bound: N replays produce at most one emit per window.
    for (let i = 1; i < 500; i += 1) {
      const decision = throttle.record(ORG_ID, REASON, i);
      expect(decision).toEqual({ emit: false, flushedSuppressedCount: 0 });
    }
  });

  it("flushes the suppressed count as an aggregate on the next window's first denial", () => {
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
    });

    // First emits, three suppressed → suppressedCount = 3.
    throttle.record(ORG_ID, REASON, 0);
    throttle.record(ORG_ID, REASON, 1);
    throttle.record(ORG_ID, REASON, 2);
    throttle.record(ORG_ID, REASON, 3);

    // Next window: this denial both emits its own event AND flushes the 3
    // suppressed from the closed window, so the additive counter stays exact
    // (1 + 3 + 1 = 5 total denials across two emitted events).
    const rollover = throttle.record(ORG_ID, REASON, WINDOW_MS);
    expect(rollover).toEqual({ emit: true, flushedSuppressedCount: 3 });
  });

  it("re-emits (no flush) after a window with no suppressed denials expires", () => {
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
    });

    throttle.record(ORG_ID, REASON, 0);
    // No further denials in the window; next window's first denial re-emits.
    const next = throttle.record(ORG_ID, REASON, WINDOW_MS);
    expect(next).toEqual({ emit: true, flushedSuppressedCount: 0 });
  });

  it("throttles each (org, reason) independently", () => {
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
    });

    expect(throttle.record(ORG_ID, REASON, 0).emit).toBe(true);
    // Different reason for the same org is a distinct key → still emits.
    expect(
      throttle.record(ORG_ID, SessionIngestionDenialReason.OrgNotFound, 1).emit
    ).toBe(true);
    // Different org, same reason → distinct key → still emits.
    expect(throttle.record("org-2", REASON, 2).emit).toBe(true);
  });

  it("bounds memory: exceeding the max-entry cap evicts the oldest entry", () => {
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
      maxEntries: 2,
    });

    // Fill to cap with three distinct keys inside one window; the first key is
    // evicted so the map never grows past the cap.
    throttle.record("org-a", REASON, 0);
    throttle.record("org-b", REASON, 0);
    throttle.record("org-c", REASON, 0);

    // org-a was evicted, so its next denial is treated as a fresh first emit
    // rather than a suppressed replay — proving it is no longer resident.
    expect(throttle.record("org-a", REASON, 1)).toEqual({
      emit: true,
      flushedSuppressedCount: 0,
    });
  });

  it("re-emits a quiet key after its window closes without a full-map sweep", () => {
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
    });

    // A denial for a key that then goes quiet past its window. A LATER denial for
    // a DIFFERENT key does NOT touch the quiet key (no per-call sweep); when the
    // quiet key re-appears past its window it emits fresh via lazy rollover.
    throttle.record("org-quiet", REASON, 0);
    expect(throttle.record("org-active", REASON, WINDOW_MS + 1).emit).toBe(
      true
    );
    expect(throttle.record("org-quiet", REASON, WINDOW_MS + 2).emit).toBe(true);
  });

  it("flushes an evicted key's suppressed count through onFlush instead of dropping it", () => {
    const flushed: Array<{ orgId: string; reason: string; count: number }> = [];
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
      maxEntries: 1,
      onFlush: (orgId, reason, count) => {
        flushed.push({ orgId, reason, count });
      },
    });

    // org-a emits then suppresses two denials in its window → suppressedCount = 2.
    throttle.record("org-a", REASON, 0);
    throttle.record("org-a", REASON, 1);
    throttle.record("org-a", REASON, 2);

    // Inserting a distinct key exceeds the cap and evicts org-a. Its pending
    // suppressed count must be flushed as an aggregate, never silently dropped.
    throttle.record("org-b", REASON, 3);

    expect(flushed).toEqual([{ orgId: "org-a", reason: REASON, count: 2 }]);
  });

  it("does not flush an evicted key that suppressed nothing", () => {
    const flushed: Array<{ orgId: string; reason: string; count: number }> = [];
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
      maxEntries: 1,
      onFlush: (orgId, reason, count) => {
        flushed.push({ orgId, reason, count });
      },
    });

    // org-a emits its first denial but never suppresses any → nothing to flush.
    throttle.record("org-a", REASON, 0);
    throttle.record("org-b", REASON, 1);

    expect(flushed).toEqual([]);
  });

  it("preserves both keys' suppressed counts regardless of two-key rollover order", () => {
    const flushed: Array<{ orgId: string; reason: string; count: number }> = [];
    const throttle = new SessionIngestionPolicyDeniedThrottle({
      windowMs: WINDOW_MS,
      onFlush: (orgId, reason, count) => {
        flushed.push({ orgId, reason, count });
      },
    });

    // Two keys each suppress within the same window.
    throttle.record("org-a", REASON, 0);
    throttle.record("org-a", REASON, 1); // org-a suppressedCount = 1
    throttle.record("org-b", REASON, 0);
    throttle.record("org-b", REASON, 1); // org-b suppressedCount = 1

    // org-a's post-window request rolls over first and flushes ITS OWN count via
    // the decision — it must not discard org-b's pending count (the old sweep
    // bug). No LRU eviction happens (cap not exceeded), so onFlush stays empty.
    const aRollover = throttle.record("org-a", REASON, WINDOW_MS);
    expect(aRollover).toEqual({ emit: true, flushedSuppressedCount: 1 });

    // org-b is still resident with its suppressed count intact; its own rollover
    // flushes it, proving org-a's rollover did not delete it.
    const bRollover = throttle.record("org-b", REASON, WINDOW_MS);
    expect(bRollover).toEqual({ emit: true, flushedSuppressedCount: 1 });
    expect(flushed).toEqual([]);
  });
});
