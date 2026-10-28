import {
  CustomFieldType,
  REFERENCE_SEARCH_MAX_LIMIT,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import type { Prisma } from "@repo/database";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  DisallowedReferenceSourceError,
  ReferenceFieldNotFoundError,
  referenceSearchService,
} from "@/app/custom-fields/reference-search-service";

/**
 * DB-backed coverage for the reference search + batch resolution API (ISS-7212).
 *
 * A real database is the point rather than incidental. The sibling unit suite
 * can prove which `where` fragment the service EMITS, but not that the fragment
 * selects the right rows — and "returns only artifacts of the field's permitted
 * type" is a claim about rows. The two spellings of the source contract
 * (`isTargetAllowed` on the write path, `referenceSourceScope` on the read path)
 * are likewise only provably in agreement when Postgres evaluates the second
 * one against the same corpus the first one judges.
 *
 * The cross-organization cases matter for the same reason. A reference picker
 * is a search over the whole artifact table, so a scoping mistake shows up as
 * another tenant's titles in a dropdown, which no mocked `findMany` can catch.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

type Corpus = {
  organizationId: string;
  otherOrganizationId: string;
  issueFieldId: string;
  sessionFieldId: string;
  multiSourceFieldId: string;
  artifactSourceFieldId: string;
  issueId: string;
  legacyIssueId: string;
  sessionId: string;
  branchId: string;
  prdId: string;
  foreignIssueId: string;
};

/**
 * One artifact of every population a source can name, all sharing the search
 * term. A corpus where only the wanted row matches the text would let a broken
 * type filter pass, because the text filter alone would already have removed
 * everything else.
 */
const SHARED_TERM = "zumbrella";

async function seedCorpus(): Promise<Corpus> {
  const organizationId = await createTestOrganization();
  const otherOrganizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const otherUser = await createTestUser(otherOrganizationId);

  const artifact = (
    overrides: Partial<Prisma.ArtifactUncheckedCreateInput>
  ): Prisma.ArtifactUncheckedCreateInput => ({
    organizationId,
    createdById: user.id,
    name: `${SHARED_TERM} candidate`,
    status: "TODO",
    type: ArtifactType.DOCUMENT,
    ...overrides,
  });

  const [issue, legacyIssue, session, branch, prd, foreignIssue] = await withDb(
    (db) =>
      Promise.all([
        db.artifact.create({
          data: artifact({
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.ISSUE,
            slug: "ISS-4382",
          }),
        }),
        db.artifact.create({
          data: artifact({
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.FEATURE,
            slug: "ISS-4383",
          }),
        }),
        db.artifact.create({
          data: artifact({
            type: ArtifactType.SESSION,
            status: "active",
            slug: "SES-7B91",
          }),
        }),
        db.artifact.create({
          data: artifact({
            type: ArtifactType.BRANCH,
            slug: "BRN-grid-table-v2",
          }),
        }),
        db.artifact.create({
          data: artifact({
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            slug: "PRD-560",
          }),
        }),
        db.artifact.create({
          data: {
            organizationId: otherOrganizationId,
            createdById: otherUser.id,
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.ISSUE,
            status: "TODO",
            name: `${SHARED_TERM} another tenant's issue`,
            slug: "ISS-9999",
          },
        }),
      ])
  );

  const field = (
    name: string,
    sources: ReferenceTargetSource[]
  ): Prisma.CustomFieldUncheckedCreateInput => ({
    organizationId,
    name,
    fieldType: CustomFieldType.ReferenceMulti,
    referenceTargetSources: sources,
    createdById: user.id,
  });

  const [issueField, sessionField, multiSourceField, artifactSourceField] =
    await withDb((db) =>
      Promise.all([
        db.customField.create({
          data: field("Linked issues", [ReferenceTargetSource.Issue]),
        }),
        db.customField.create({
          data: field("Linked sessions", [ReferenceTargetSource.Session]),
        }),
        db.customField.create({
          data: field("Linked work", [
            ReferenceTargetSource.Session,
            ReferenceTargetSource.Branch,
          ]),
        }),
        db.customField.create({
          data: field("Anything", [ReferenceTargetSource.Artifact]),
        }),
      ])
    );

  return {
    organizationId,
    otherOrganizationId,
    issueFieldId: issueField.id,
    sessionFieldId: sessionField.id,
    multiSourceFieldId: multiSourceField.id,
    artifactSourceFieldId: artifactSourceField.id,
    issueId: issue.id,
    legacyIssueId: legacyIssue.id,
    sessionId: session.id,
    branchId: branch.id,
    prdId: prd.id,
    foreignIssueId: foreignIssue.id,
  };
}

describeIfDb("reference target search (real Postgres)", () => {
  let corpus: Corpus;

  beforeAll(async () => {
    corpus = await seedCorpus();
  });

  async function searchIds(
    fieldId: string,
    overrides: Record<string, unknown> = {}
  ): Promise<string[]> {
    const result = await referenceSearchService.searchTargets({
      fieldId,
      organizationId: corpus.organizationId,
      query: SHARED_TERM,
      ...overrides,
    });
    return result.targets.map((target) => target.id).sort();
  }

  it("returns only the field's permitted population", async () => {
    // Every artifact in the corpus matches the query text, so anything other
    // than the two issues here is the type filter having failed.
    expect(await searchIds(corpus.issueFieldId)).toEqual(
      [corpus.issueId, corpus.legacyIssueId].sort()
    );
  });

  it("matches both persisted spellings of an issue subtype", async () => {
    const ids = await searchIds(corpus.issueFieldId);

    // FEA-3956 left rows on both spellings; a filter that named one would drop
    // half the org's issues from the picker and look like a search bug.
    expect(ids).toContain(corpus.issueId);
    expect(ids).toContain(corpus.legacyIssueId);
  });

  it("excludes a document subtype the field does not name", async () => {
    expect(await searchIds(corpus.issueFieldId)).not.toContain(corpus.prdId);
  });

  it("returns the union when a field names several sources", async () => {
    expect(await searchIds(corpus.multiSourceFieldId)).toEqual(
      [corpus.sessionId, corpus.branchId].sort()
    );
  });

  it("returns every population for an ARTIFACT-sourced field", async () => {
    expect(await searchIds(corpus.artifactSourceFieldId)).toEqual(
      [
        corpus.issueId,
        corpus.legacyIssueId,
        corpus.sessionId,
        corpus.branchId,
        corpus.prdId,
      ].sort()
    );
  });

  it("never returns another organization's artifacts", async () => {
    // The widest field in the corpus, so nothing but the org predicate is
    // standing between this caller and the other tenant's issue.
    expect(await searchIds(corpus.artifactSourceFieldId)).not.toContain(
      corpus.foreignIssueId
    );
  });

  it("matches on slug as readily as on name", async () => {
    const bySlug = await searchIds(corpus.issueFieldId, { query: "ISS-4382" });

    expect(bySlug).toEqual([corpus.issueId]);
  });

  it("matches a slug case-insensitively", async () => {
    expect(await searchIds(corpus.issueFieldId, { query: "iss-4382" })).toEqual(
      [corpus.issueId]
    );
  });

  it("treats a typed wildcard as a literal character", async () => {
    // Unescaped, `%` would match every issue in the org rather than none.
    expect(await searchIds(corpus.issueFieldId, { query: "%" })).toEqual([]);
  });

  it("omits the entity being edited", async () => {
    const ids = await searchIds(corpus.issueFieldId, {
      excludeEntityId: corpus.issueId,
    });

    expect(ids).toEqual([corpus.legacyIssueId]);
  });

  it("rejects a population the field does not permit", async () => {
    await expect(
      referenceSearchService.searchTargets({
        fieldId: corpus.sessionFieldId,
        organizationId: corpus.organizationId,
        sources: [ReferenceTargetSource.Issue],
      })
    ).rejects.toBeInstanceOf(DisallowedReferenceSourceError);
  });

  it("narrows within the permitted populations when asked", async () => {
    const ids = await searchIds(corpus.multiSourceFieldId, {
      sources: [ReferenceTargetSource.Branch],
    });

    expect(ids).toEqual([corpus.branchId]);
  });

  it("narrows an ARTIFACT-sourced field to a single population", async () => {
    // ARTIFACT is a superset, so ISSUE is inside what this field permits even
    // though the literal string is not in its source list. The write path
    // accepts an issue target here, so the search must let the picker ask for
    // one rather than 400.
    const ids = await searchIds(corpus.artifactSourceFieldId, {
      sources: [ReferenceTargetSource.Issue],
    });

    expect(ids).toEqual([corpus.issueId, corpus.legacyIssueId].sort());
  });

  it("returns candidates when the picker opens with nothing typed", async () => {
    // The widest field with no query and no exclusion is the only path that
    // reaches the query with an EMPTY `AND` list. Prisma treats that as a no-op,
    // but a builder change that made it match nothing would open the picker on
    // an empty list that reads as "no artifacts exist".
    const ids = await searchIds(corpus.artifactSourceFieldId, {
      query: undefined,
      limit: REFERENCE_SEARCH_MAX_LIMIT,
    });

    expect(ids).toEqual(
      expect.arrayContaining([
        corpus.issueId,
        corpus.legacyIssueId,
        corpus.sessionId,
        corpus.branchId,
        corpus.prdId,
      ])
    );
  });

  it("bounds the page and reports that more remain", async () => {
    const result = await referenceSearchService.searchTargets({
      fieldId: corpus.artifactSourceFieldId,
      organizationId: corpus.organizationId,
      query: SHARED_TERM,
      limit: 2,
    });

    expect(result.targets).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it("reports a field in another organization as not found", async () => {
    // The concrete class, not a bare `.rejects.toThrow()`: an unmatched throw
    // assertion also passes on a connection error or a bad fixture, so it would
    // stay green if the org predicate on the field lookup degraded into some
    // other failure. It must be NOT-FOUND specifically — anything that
    // distinguished "exists but not yours" would confirm the field's existence.
    await expect(
      referenceSearchService.searchTargets({
        fieldId: corpus.issueFieldId,
        organizationId: corpus.otherOrganizationId,
      })
    ).rejects.toBeInstanceOf(ReferenceFieldNotFoundError);
  });
});

describeIfDb("reference target batch resolution (real Postgres)", () => {
  let corpus: Corpus;

  beforeAll(async () => {
    corpus = await seedCorpus();
  });

  it("resolves ids into the chip projection", async () => {
    const result = await referenceSearchService.resolveTargets(
      [corpus.issueId],
      corpus.organizationId
    );

    expect(result.targets).toEqual([
      {
        id: corpus.issueId,
        slug: "ISS-4382",
        name: `${SHARED_TERM} candidate`,
        artifactType: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        status: "TODO",
      },
    ]);
    expect(result.unresolvable).toEqual([]);
  });

  it("reports another organization's artifact as unresolvable, not as a chip", async () => {
    const result = await referenceSearchService.resolveTargets(
      [corpus.issueId, corpus.foreignIssueId],
      corpus.organizationId
    );

    expect(result.unresolvable).toEqual([corpus.foreignIssueId]);
    expect(result.targets.map((t) => t.id)).toEqual([corpus.issueId]);
  });

  it("reports a deleted artifact as unresolvable", async () => {
    const doomed = await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId: corpus.organizationId,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.ISSUE,
          status: "TODO",
          name: "About to be deleted",
          slug: "ISS-8888",
        },
      })
    );
    await withDb((db) => db.artifact.delete({ where: { id: doomed.id } }));

    const result = await referenceSearchService.resolveTargets(
      [doomed.id],
      corpus.organizationId
    );

    // Indistinguishable from the out-of-organization case above, on purpose:
    // telling them apart would confirm the id exists somewhere.
    expect(result).toEqual({ targets: [], unresolvable: [doomed.id] });
  });

  it("resolves a mixed batch in one call", async () => {
    const result = await referenceSearchService.resolveTargets(
      [corpus.sessionId, corpus.branchId, corpus.prdId],
      corpus.organizationId
    );

    expect(result.targets.map((t) => t.id)).toEqual([
      corpus.sessionId,
      corpus.branchId,
      corpus.prdId,
    ]);
    expect(result.unresolvable).toEqual([]);
  });
});
