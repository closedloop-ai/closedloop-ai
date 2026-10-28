import { describe, expect, it } from "vitest";
import {
  ClaimPrecedence,
  claimPrecedence,
  type ReceiptClaimant,
  resolveReceiptClaimants,
} from "./receipt-claimants";

const CALLED = new Date("2026-10-16T12:00:00.000Z");
const PARENT_START = new Date("2026-10-16T11:00:00.000Z");
const FORK_START = new Date("2026-10-16T11:30:00.000Z");

describe("claimPrecedence", () => {
  it("keeps the receipt with the claim invoked first", () => {
    expect(
      claimPrecedence(
        { invokedAt: CALLED, sessionStartedAt: FORK_START },
        {
          invokedAt: new Date(CALLED.getTime() + 1),
          sessionStartedAt: PARENT_START,
        }
      )
    ).toBe(ClaimPrecedence.First);
  });

  it("breaks a call-time tie by the session that started strictly earlier", () => {
    const parent = { invokedAt: CALLED, sessionStartedAt: PARENT_START };
    const fork = { invokedAt: CALLED, sessionStartedAt: FORK_START };

    expect(claimPrecedence(fork, parent)).toBe(ClaimPrecedence.Second);
    expect(claimPrecedence(parent, fork)).toBe(ClaimPrecedence.First);
  });

  it("names no original when the start times tie too, or one is unknown", () => {
    const parent = { invokedAt: CALLED, sessionStartedAt: PARENT_START };

    expect(claimPrecedence(parent, { ...parent })).toBe(ClaimPrecedence.Tied);
    expect(
      claimPrecedence(parent, { invokedAt: CALLED, sessionStartedAt: null })
    ).toBe(ClaimPrecedence.Tied);
  });

  it("never lets a claim with no call time prove it came first", () => {
    const timed = { invokedAt: CALLED, sessionStartedAt: FORK_START };
    const untimed = { invokedAt: null, sessionStartedAt: PARENT_START };

    expect(claimPrecedence(untimed, timed)).toBe(ClaimPrecedence.Second);
    expect(claimPrecedence(timed, untimed)).toBe(ClaimPrecedence.First);
  });
});

describe("resolveReceiptClaimants", () => {
  it("binds the canonical copy and makes every other copy its duplicate", () => {
    const canonical = claimant(
      "a",
      "session-1",
      "00000000-0000-0000-0000-00000000000a"
    );
    const other = claimant(
      "a",
      "session-2",
      "00000000-0000-0000-0000-00000000000b"
    );

    expect(resolveReceiptClaimants([other, canonical])).toEqual({
      holder: canonical,
      duplicates: [other],
      contested: [],
    });
  });

  it("binds the parent over a fork that started later, copies included", () => {
    const parent = claimant("parent", "session-1", TARGET_A);
    const fork = claimant("fork", "session-2", TARGET_A, {
      sessionStartedAt: FORK_START,
    });
    const forkCopy = claimant("fork", "session-3", TARGET_B, {
      sessionStartedAt: FORK_START,
    });

    expect(resolveReceiptClaimants([fork, forkCopy, parent])).toEqual({
      holder: parent,
      duplicates: [fork, forkCopy],
      contested: [],
    });
  });

  it("leaves every claim contesting when the fork rule names no original", () => {
    const parent = claimant("parent", "session-1", TARGET_A);
    const fork = claimant("fork", "session-2", TARGET_A);

    expect(resolveReceiptClaimants([parent, fork])).toEqual({
      duplicates: [],
      contested: [parent, fork],
    });
  });

  it("contests a receipt two sessions match only by fingerprint, even when one came first", () => {
    const parent = claimant("parent", "session-1", TARGET_A, {
      byIdentity: false,
    });
    const fork = claimant("fork", "session-2", TARGET_A, {
      byIdentity: false,
      invokedAt: new Date(CALLED.getTime() + 60_000),
    });

    expect(resolveReceiptClaimants([parent, fork])?.contested).toEqual([
      parent,
      fork,
    ]);
  });

  it("keeps a receipt with the only copy of a session that claims it, though it is not the canonical copy", () => {
    // The parent's claim sits on its copy on TARGET_B; the canonical copy on
    // TARGET_A holds none. The fork, on TARGET_A, started later. The copy rule
    // picks among a session's own copies only, so it never hands the receipt
    // to another session that happens to sit on a lower compute target.
    const parentCopy = claimant("parent", "session-2", TARGET_B);
    const fork = claimant("fork", "session-3", TARGET_A, {
      sessionStartedAt: FORK_START,
    });

    expect(resolveReceiptClaimants([parentCopy])).toEqual({
      holder: parentCopy,
      duplicates: [],
      contested: [],
    });
    expect(resolveReceiptClaimants([fork, parentCopy])).toEqual({
      holder: parentCopy,
      duplicates: [fork],
      contested: [],
    });
  });

  it("settles nothing when one session holds two claims for the receipt", () => {
    expect(
      resolveReceiptClaimants([
        claimant("a", "session-1", TARGET_A),
        claimant("a", "session-1", TARGET_A),
      ])
    ).toBeNull();
  });
});

const TARGET_A = "00000000-0000-0000-0000-00000000000a";
const TARGET_B = "00000000-0000-0000-0000-00000000000b";

function claimant(
  externalSessionId: string,
  agentSessionId: string,
  computeTargetId: string,
  extra: Partial<ReceiptClaimant> = {}
): ReceiptClaimant {
  return {
    agentSessionId,
    session: { harness: "claude", externalSessionId, computeTargetId },
    invokedAt: CALLED,
    sessionStartedAt: PARENT_START,
    byIdentity: true,
    ...extra,
  };
}
