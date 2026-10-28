import { describe, expect, it } from "vitest";
import { ProvenanceRelationshipKind } from "../provenance-relationship";
import {
  relatedSessionsBatchResponseSchema,
  relatedSessionsResultSchema,
} from "../related-session-schema";
import { DISPLAYED_SESSION_STATUS } from "../session-status";

const ARTIFACT_ID = "5c1c0a2e-6d1a-4f5b-9c3e-8a1d2f3b4c5d";

const CONTRIBUTION = {
  sessionArtifactId: "session-1",
  slug: "SES-1",
  name: "Wire the column",
  status: DISPLAYED_SESSION_STATUS.ACTIVE,
  owner: {
    id: "user-1",
    firstName: "Avery",
    lastName: "Example",
    avatarUrl: null,
  },
  kind: ProvenanceRelationshipKind.Contribution,
  contributedAt: "2026-08-14T18:30:00.000Z",
};

describe("relatedSessionsBatchResponseSchema (ISS-9317)", () => {
  it("parses a well-formed batch response verbatim", () => {
    const parsed = relatedSessionsBatchResponseSchema.parse({
      results: { [ARTIFACT_ID]: { items: [CONTRIBUTION], total: 1 } },
    });

    expect(parsed.results[ARTIFACT_ID]).toEqual({
      items: [CONTRIBUTION],
      total: 1,
    });
  });

  it("rejects the harness default and a version-skewed body that carries no results", () => {
    expect(relatedSessionsBatchResponseSchema.safeParse({}).success).toBe(
      false
    );
    expect(
      relatedSessionsBatchResponseSchema.safeParse({ results: null }).success
    ).toBe(false);
  });

  it("admits an unknown top-level or row-level field from a newer server", () => {
    const parsed = relatedSessionsBatchResponseSchema.parse({
      results: {
        [ARTIFACT_ID]: {
          items: [{ ...CONTRIBUTION, confidence: 0.9 }],
          total: 1,
          window: "30d",
        },
      },
      generatedAt: "2026-09-17T00:00:00.000Z",
    });

    expect(parsed.results[ARTIFACT_ID]?.items).toHaveLength(1);
  });

  it("drops only the artifact whose entry is malformed, never the page", () => {
    const parsed = relatedSessionsBatchResponseSchema.parse({
      results: {
        [ARTIFACT_ID]: { items: [CONTRIBUTION], total: 1 },
        "0d9c7b5a-3e1f-4a2b-8c6d-4e2f0a8b6c4d": {
          items: [{ ...CONTRIBUTION, contributedAt: 1_700_000_000 }],
          total: 1,
        },
        "8f2e4d6c-1a3b-4c5d-9e7f-0a1b2c3d4e5f": { total: 2 },
      },
    });

    // A known-kind row with a malformed field is a broken entry, not a newer
    // one; the cell renders its absent key as the count chip while every other
    // artifact on the page keeps its chips.
    expect(Object.keys(parsed.results)).toEqual([ARTIFACT_ID]);
  });

  it("never lets a server-supplied __proto__ key become the results' prototype", () => {
    // JSON.parse is the only fixture that puts an OWN `__proto__` key on the
    // input — a quoted literal in source would set the fixture's prototype.
    const body: unknown = JSON.parse(
      `{"results":{"__proto__":{"items":[],"total":3},"${ARTIFACT_ID}":{"items":[],"total":0}}}`
    );

    const parsed = relatedSessionsBatchResponseSchema.parse(body);

    expect(Object.getPrototypeOf(parsed.results)).toBeNull();
    expect(parsed.results.total).toBeUndefined();
    expect(parsed.results[ARTIFACT_ID]).toEqual({ items: [], total: 0 });
  });

  it.each([
    ["a non-ISO string", "yesterday"],
    ["a date with no time", "2026-08-14"],
    ["an empty string", ""],
  ])(
    "drops the artifact whose contributedAt is %s instead of handing the cell a date it cannot format",
    (_label, contributedAt) => {
      const parsed = relatedSessionsBatchResponseSchema.parse({
        results: {
          [ARTIFACT_ID]: {
            items: [{ ...CONTRIBUTION, contributedAt }],
            total: 1,
          },
        },
      });

      expect(Object.keys(parsed.results)).toEqual([]);
    }
  );

  it("admits an ISO instant with an explicit offset", () => {
    const parsed = relatedSessionsBatchResponseSchema.parse({
      results: {
        [ARTIFACT_ID]: {
          items: [
            { ...CONTRIBUTION, contributedAt: "2026-08-14T13:30:00-05:00" },
          ],
          total: 1,
        },
      },
    });

    expect(parsed.results[ARTIFACT_ID]?.items).toHaveLength(1);
  });
});

describe("relatedSessionsResultSchema total fold", () => {
  it("folds a missing total to the delivered count", () => {
    expect(
      relatedSessionsResultSchema.parse({ items: [CONTRIBUTION] }).total
    ).toBe(1);
  });

  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["non-finite", Number.NaN],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 2],
    ["smaller than the delivered count", 0],
    ["not a number", "3"],
  ])("folds a %s total to the delivered count", (_label, total) => {
    expect(
      relatedSessionsResultSchema.parse({ items: [CONTRIBUTION], total }).total
    ).toBe(1);
  });

  it("keeps a total that exceeds the delivered count — that is the +N claim", () => {
    expect(
      relatedSessionsResultSchema.parse({ items: [CONTRIBUTION], total: 9 })
        .total
    ).toBe(9);
  });

  it("drops a row whose kind this build cannot classify and keeps it counted", () => {
    const parsed = relatedSessionsResultSchema.parse({
      items: [CONTRIBUTION, { ...CONTRIBUTION, kind: "escalation" }],
      total: 2,
    });

    // The unknown row is a session not shown here, not a broken page: the
    // overflow reads it as withheld rather than the whole cell falling back.
    expect(parsed.items).toEqual([CONTRIBUTION]);
    expect(parsed.total).toBe(2);
  });
});
