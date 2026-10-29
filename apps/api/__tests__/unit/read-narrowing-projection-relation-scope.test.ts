import { describe, expect, it } from "vitest";
import { createModelDouble } from "@/__tests__/support/read-narrowing-projection.test-db";

/**
 * The shared read double's own regression suite for ONE property: a
 * relation-scoped predicate must either be applied against an embedded related
 * row or blow up — never quietly fall back to this row's own columns.
 *
 * The org-scoped reads this double characterizes own no `organizationId`
 * column; their entire scope is a join predicate like
 * `{ artifact: { organizationId } }`. A double that answers such a predicate
 * from a same-named column on the ROOT row reports "scoped" for a read that was
 * never scoped, so a test asserting org isolation would pass against a
 * production query that had lost it. These cases pin the throw that stops that.
 */

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";

const ARTIFACT_RELATION_THROW =
  /cannot model the relation filter on "artifact"/;
const OWNER_RELATION_THROW = /cannot model the relation filter on "owner"/;
const COMPOUND_UNIQUE_THROW = /compound-unique key "bucket_subject"/;
const OPERATOR_THROW = /cannot model the operator/;

/**
 * A `Json` predicate naming only Json-family operators. Nothing about its SHAPE
 * separates it from a two-field relation filter, and the column it targets
 * stores a plain object just as an embedded related row does — so the operator
 * exclusion is the only thing standing between it and the relation branch.
 */
const JSON_PATH_PREDICATE = { path: "$.lane", string_contains: "backfill" };

describe("relation filters in the read-narrowing double", () => {
  it("throws when the fixture omits the related row instead of matching a same-named root column", () => {
    // The fail-open shape: no `artifact` relation, but a root `organizationId`
    // the relation predicate's sub-key happens to name.
    const sessionDetail = createModelDouble([
      {
        artifactId: "artifact-1",
        organizationId: ORG_ID,
        computeTargetId: "target-1",
      },
    ]);

    expect(() =>
      sessionDetail.findFirst({
        where: {
          artifactId: "artifact-1",
          artifact: { organizationId: ORG_ID },
        },
        select: { artifactId: true },
      })
    ).toThrow(ARTIFACT_RELATION_THROW);
  });

  it("throws on the explicit `is` spelling of the same absent relation", () => {
    const sessionDetail = createModelDouble([
      { artifactId: "artifact-1", organizationId: ORG_ID },
    ]);

    expect(() =>
      sessionDetail.findFirst({
        where: { artifact: { is: { organizationId: ORG_ID } } },
        select: { artifactId: true },
      })
    ).toThrow(ARTIFACT_RELATION_THROW);
  });

  it("applies the predicate to the embedded related row, so a foreign org is excluded", async () => {
    const sessionDetail = createModelDouble([
      {
        artifactId: "artifact-1",
        // Deliberately contradicts the embedded relation: were the double still
        // answering from the root column, this row would match `ORG_ID` and the
        // assertion below would read as a pass.
        organizationId: ORG_ID,
        artifact: { organizationId: OTHER_ORG_ID },
      },
    ]);

    const row = await sessionDetail.findFirst({
      where: { artifact: { organizationId: ORG_ID } },
      select: { artifactId: true },
    });

    expect(row).toBeNull();
  });

  it("matches through the embedded related row when the org does own it", async () => {
    const sessionDetail = createModelDouble([
      { artifactId: "artifact-1", artifact: { organizationId: ORG_ID } },
    ]);

    const row = await sessionDetail.findFirst({
      where: { artifact: { organizationId: ORG_ID } },
      select: { artifactId: true },
    });

    expect(row).toEqual({ artifactId: "artifact-1" });
  });

  it("still models a compound-unique key spelled as its joined field list", async () => {
    const rateLimit = createModelDouble([
      { bucket: "attachment-upload", subject: "user-1", count: 3 },
    ]);

    const row = await rateLimit.findUnique({
      where: {
        bucket_subject: { bucket: "attachment-upload", subject: "user-1" },
      },
      select: { count: true },
    });

    expect(row).toEqual({ count: 3 });
  });

  it("refuses a nested key whose sub-keys are columns but whose name is not their joined spelling", () => {
    // The discriminator: `owner` is not `organizationId`, so this is a relation
    // filter that lost its related row, not a compound unique.
    const record = createModelDouble([{ id: "row-1", organizationId: ORG_ID }]);

    expect(() =>
      record.findFirst({
        where: { owner: { organizationId: ORG_ID } },
        select: { id: true },
      })
    ).toThrow(OWNER_RELATION_THROW);
  });

  it("reports a compound-unique key whose sub-columns the fixture lacks rather than silently not matching", () => {
    const rateLimit = createModelDouble([{ bucket: "attachment-upload" }]);

    expect(() =>
      rateLimit.findUnique({
        where: {
          bucket_subject: { bucket: "attachment-upload", subject: "user-1" },
        },
        select: { bucket: true },
      })
    ).toThrow(COMPOUND_UNIQUE_THROW);
  });

  it("refuses a Json predicate instead of answering it as a relation filter", () => {
    // The fixture's Json column happens to carry the same keys the predicate
    // names — which is all it takes, because every sub-comparison is then a
    // scalar equality that RESOLVES. Read as a relation filter this returns the
    // row: a fabricated match, since `path`/`string_contains` mean something
    // this double does not implement. The refusal is the whole contract.
    const desktopCommand = createModelDouble([
      { id: "cmd-1", metadata: { ...JSON_PATH_PREDICATE } },
    ]);

    expect(() =>
      desktopCommand.findFirst({
        where: { metadata: JSON_PATH_PREDICATE },
        select: { id: true },
      })
    ).toThrow(OPERATOR_THROW);
  });

  it("blames the clause, not the fixture, for a Json predicate over a null column", () => {
    // Classification, not just the throw: routed to the relation branch this
    // reports a missing related row, sending the reader off to embed an
    // `metadata` row that was never a relation in the first place.
    const desktopCommand = createModelDouble([{ id: "cmd-1", metadata: null }]);

    expect(() =>
      desktopCommand.findFirst({
        where: { metadata: JSON_PATH_PREDICATE },
        select: { id: true },
      })
    ).toThrow(OPERATOR_THROW);
  });

  it("keeps an unmodelled multi-operator column range on the generic operator throw", () => {
    const tokenEvent = createModelDouble([
      { id: "e-1", eventCreatedAt: new Date("2026-09-04T00:00:00.000Z") },
    ]);

    expect(() =>
      tokenEvent.findMany({
        where: {
          eventCreatedAt: {
            gte: new Date("2026-09-01T00:00:00.000Z"),
            lte: new Date("2026-09-05T00:00:00.000Z"),
          },
        },
        select: { id: true },
      })
    ).toThrow(OPERATOR_THROW);
  });
});
