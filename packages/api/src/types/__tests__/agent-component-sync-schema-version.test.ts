/**
 * @file ISS-8609 — the component-sync accepted-version contract.
 *
 * WHY THIS EXISTS SEPARATELY from the route suite. The shipped tuple has ONE
 * member, so membership-of-a-set and equality-with-a-single-literal are
 * behaviourally identical to any test that can only pass the live tuple — and the
 * single-literal check is exactly what ISS-8609 replaced. So the route test can
 * only prove the wiring; the MEMBERSHIP branch has to be driven at a cardinality
 * the tree does not have yet, which is what `accepted` being a parameter is for.
 * Otherwise the first version bump is where the capability gets tested, and that
 * is the one moment nobody can afford it.
 *
 * The versions below are hand-written literals, never read off the tuple under
 * test: a table computed from the implementation stays green when the
 * implementation is emptied.
 */
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS,
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION_V1,
  isAcceptedAgentComponentSyncSchemaVersion,
  isAgentComponentSyncSchemaVersionSkew,
} from "../agent-component-sync-schema-version";

/** A two-member set, the shape the tuple takes on the next bump. */
const MID_ROLLOUT = [1, 2] as const;

describe("component sync accepted schema versions", () => {
  it("accepts every member of a mid-rollout set, not just the newest", () => {
    // The whole point of the set. During a bump the cloud must accept BOTH, so
    // that an installed desktop stamping the old version keeps syncing while a
    // new one stamping the next is already understood. A single-literal check
    // passes for one of these and 400s the other, whichever way it is written.
    for (const version of MID_ROLLOUT) {
      expect(
        isAcceptedAgentComponentSyncSchemaVersion(version, MID_ROLLOUT)
      ).toBe(true);
      expect(isAgentComponentSyncSchemaVersionSkew(version, MID_ROLLOUT)).toBe(
        false
      );
    }
  });

  it("treats a well-formed version outside the set as SKEW, so a deploy can clear it", () => {
    expect(isAcceptedAgentComponentSyncSchemaVersion(3, MID_ROLLOUT)).toBe(
      false
    );
    expect(isAgentComponentSyncSchemaVersionSkew(3, MID_ROLLOUT)).toBe(true);
  });

  it.each([
    { label: "absent", version: undefined },
    { label: "null", version: null },
    { label: "a numeric string", version: "1" },
    { label: "an object", version: {} },
    { label: "an array", version: [] },
    { label: "a fraction", version: 1.5 },
    { label: "zero", version: 0 },
    { label: "a negative version", version: -1 },
    {
      label: "a magnitude past the safe-integer range",
      version: Number.MAX_SAFE_INTEGER + 1,
    },
    { label: "NaN", version: Number.NaN },
    { label: "Infinity", version: Number.POSITIVE_INFINITY },
  ])(
    "refuses to call $label skew — no deploy would ever accept it",
    ({ version }) => {
      // The cursor-holding 400 is reachable ONLY by real skew (ISS-7978). Each of
      // these is neither accepted nor skew, so it falls through to the 422 an
      // installed desktop dead-letters instead of stalling the lane forever.
      expect(
        isAcceptedAgentComponentSyncSchemaVersion(version, MID_ROLLOUT)
      ).toBe(false);
      expect(isAgentComponentSyncSchemaVersionSkew(version, MID_ROLLOUT)).toBe(
        false
      );
    }
  );

  it("ships a tuple built from named historical literals, with 1 still accepted", () => {
    // Hand-written, and the assertion the next bump has to confront: widening the
    // tuple is additive and fine, but a bump that REPLACES 1 strands every
    // installed desktop still stamping it. `toContain` rather than `toEqual` so
    // adding version 2 does not red this, while dropping 1 does.
    expect([...ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS]).toContain(1);
    expect(AGENT_COMPONENT_SYNC_SCHEMA_VERSION_V1).toBe(1);
  });

  it("stamps a version the cloud already accepts", () => {
    // The cloud-deploys-first invariant, as a test rather than a convention: the
    // version a desktop writes must never be one this build's boundary rejects.
    expect(
      isAcceptedAgentComponentSyncSchemaVersion(
        AGENT_COMPONENT_SYNC_SCHEMA_VERSION
      )
    ).toBe(true);
  });
});
