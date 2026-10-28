import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type ArtifactStatus,
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";
import { documentListRead } from "./document-list-read";
import { documentListService } from "./document-list-service";

let mockAuthContext: AuthContext = createTestAuthContext();

// Only the credential is replaced. The route, the validator, the service and
// the database are all real, which is the point of the route-level case below:
// nothing between the query string and the SQL is stubbed.
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (auth: AuthContext, request: Request) => unknown) =>
    (request: Request) =>
      handler(mockAuthContext, request),
}));

import { GET } from "./route";

/**
 * ISS-6778 — `GET /documents` narrows by lifecycle status IN THE DATABASE, over
 * the whole matching population.
 *
 * The ticket exists because a post-fetch filter answers a different question:
 * `symphony-nightly-apply` logged "no TODO issues to sweep" on every run while
 * 25 tagged TODOs waited, because the first 100 rows of a 1,144-artifact project
 * held none of them. So the load-bearing case here is the first one — the TODO
 * is seeded where a first page could never reach it, and the assertion is that a
 * page-one request still returns it. A client-side `.filter()` behind the same
 * parameter would fail that case, and a single-page fixture would pass with the
 * predicate deleted and prove nothing.
 *
 * These run against a real Postgres because the claim is about what the DATABASE
 * does with the predicate: that the `IN` bounds the rows the server materializes
 * and the honest `total` counts the narrowed population rather than the whole
 * one. A mocked client would assert only the object this repo already builds —
 * which the unit suite in `__tests__/document-list-query.test.ts` covers.
 *
 * Most cases here call the service directly, which is the right altitude for a
 * claim about SQL. The two route-level cases at the end are the exception and
 * are deliberately different: they compose a real query string through the real
 * `GET` handler, its validator, and the service into the database, with only the
 * credential stubbed. Nothing else in the repo does — the route suite mocks the
 * service — so a parameter that never survived the query string would otherwise
 * be invisible to both halves of the coverage (davetho review).
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** Rows per page in the paging cases. Small enough that page 1 cannot cheat. */
const PAGE_SIZE = 5;
/** How many non-TODO decoys sit ahead of the planted TODO in newest-first order. */
const DECOY_COUNT = 11;

describeIfDb("document list status predicate (ISS-6778)", () => {
  it("returns a TODO that lives past the first page", async () => {
    const organizationId = await seedPagedCorpus();

    const page = await documentListService.findPageWithCustomFields({
      organizationId,
      limit: PAGE_SIZE,
      offset: 0,
      status: [IssueStatus.Todo],
    });

    expect(page.items.map((item) => item.title)).toEqual(["Buried TODO issue"]);
    // The total is over the NARROWED population, not the whole one: a client
    // that paged this read is told there is exactly one TODO anywhere, so it
    // cannot offer a second page that does not exist.
    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it("cannot reach that TODO from page one when the same read carries no status", async () => {
    // The control for the case above, and the reason the first case is not
    // vacuous: without the predicate the planted TODO is unreachable from page
    // one, which is the whole defect the ticket describes.
    const organizationId = await seedPagedCorpus();

    const page = await documentListService.findPageWithCustomFields({
      organizationId,
      limit: PAGE_SIZE,
      offset: 0,
    });

    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.items.map((item) => item.title)).not.toContain(
      "Buried TODO issue"
    );
    expect(page.total).toBe(DECOY_COUNT + 1);
  });

  it("excludes a row that exists in the org but carries another status", async () => {
    // Absence, asserted directly: a filter that only ever narrowed the shape of
    // what it returned would still have to drop this row.
    const organizationId = await createTestOrganization();
    await createIssue(organizationId, {
      name: "Wanted",
      status: IssueStatus.Todo,
    });
    await createIssue(organizationId, {
      name: "Unwanted",
      status: IssueStatus.Done,
    });

    expect(await findTitles(organizationId, [IssueStatus.Todo])).toEqual([
      "Wanted",
    ]);
  });

  it("unions a multi-value status set rather than intersecting it", async () => {
    const organizationId = await createTestOrganization();
    await createIssue(organizationId, {
      name: "A todo",
      status: IssueStatus.Todo,
    });
    await createIssue(organizationId, {
      name: "An in-progress",
      status: IssueStatus.InProgress,
    });
    await createIssue(organizationId, {
      name: "A done",
      status: IssueStatus.Done,
    });

    const titles = await findTitles(organizationId, [
      IssueStatus.Todo,
      IssueStatus.InProgress,
    ]);

    expect([...titles].sort()).toEqual(["A todo", "An in-progress"]);
  });

  it("applies no narrowing at all when no status is requested", async () => {
    // The live-endpoint case: every existing consumer sends no `status`, and
    // must keep getting exactly what it got yesterday.
    const organizationId = await createTestOrganization();
    await createIssue(organizationId, {
      name: "A todo",
      status: IssueStatus.Todo,
    });
    await createIssue(organizationId, {
      name: "A done",
      status: IssueStatus.Done,
    });

    const documents = await documentListRead.findAllDocuments({
      organizationId,
    });

    expect([...documents.map((d) => d.title)].sort()).toEqual([
      "A done",
      "A todo",
    ]);
  });

  it("returns nothing, not everything, for a status no row carries", async () => {
    const organizationId = await createTestOrganization();
    await createIssue(organizationId, {
      name: "A todo",
      status: IssueStatus.Todo,
    });

    expect(await findTitles(organizationId, [IssueStatus.Blocked])).toEqual([]);
  });

  it("composes with the type filter instead of replacing it", async () => {
    const organizationId = await createTestOrganization();
    await createIssue(organizationId, {
      name: "In-review issue",
      status: IssueStatus.InReview,
    });
    await createDocumentArtifact(organizationId, {
      name: "In-review PRD",
      status: DocumentStatus.InReview,
    });

    // IN_REVIEW is the one member both vocabularies share, so a `type` that
    // stopped being applied would show up here as a second row.
    expect(
      await findTitles(organizationId, [DocumentStatus.InReview], {
        type: DocumentType.Prd,
      })
    ).toEqual(["In-review PRD"]);
  });

  it("keeps an off-vocabulary row reachable by the status it actually carries", async () => {
    // The reason `status` is NOT narrowed by `type`: `Artifact.status` is a
    // freeform column and a FEATURE carrying the Document member OBSOLETE exists
    // in production. Refusing `type=FEATURE&status=OBSOLETE` at the boundary
    // would make exactly those rows unreachable through the filter that exists
    // to find them.
    const organizationId = await createTestOrganization();
    await createIssue(organizationId, {
      name: "Off-vocabulary feature",
      status: DocumentStatus.Obsolete,
    });
    await createIssue(organizationId, {
      name: "Ordinary feature",
      status: IssueStatus.Todo,
    });

    expect(
      await findTitles(organizationId, [DocumentStatus.Obsolete], {
        type: DocumentType.Feature,
      })
    ).toEqual(["Off-vocabulary feature"]);
  });

  it("narrows through the real HTTP route, not just the service (ISS-6778)", async () => {
    // Every other case here calls `documentListService` directly, and the route
    // suite mocks that service — so until this case nothing composed a query
    // string through the public handler into the database, and a parameter that
    // never reached the service would have been invisible to both
    // (davetho review).
    //
    // The corpus is the paged one: the two wanted rows sit past `limit`, behind
    // more than a page of decoys, so a filter applied after the rows arrived
    // returns neither of them.
    const organizationId = await seedRouteCorpus();
    mockAuthContext = createTestAuthContext({
      user: { ...createTestAuthContext().user, organizationId },
    });

    const response = await GET(
      new NextRequest(
        `http://localhost:3002/documents?limit=${PAGE_SIZE}&includeTotal=true&status=${IssueStatus.Todo}&status=${IssueStatus.InProgress}`,
        { method: "GET" }
      ),
      createMockRouteContext({})
    );
    const body = (await response.json()) as {
      data: { items: { title: string; status: string }[]; total: number };
    };

    expect(response.status).toBe(200);
    expect([...body.data.items.map((item) => item.title)].sort()).toEqual([
      "Buried IN_PROGRESS issue",
      "Buried TODO issue",
    ]);
    // Both requested statuses survived the query string. A shape that kept one
    // occurrence per key would return the IN_PROGRESS row alone and report a
    // total of 1, with nothing saying TODO had been dropped.
    expect(body.data.total).toBe(2);
  });

  it("rejects a comma-joined status at the route rather than widening the read", async () => {
    // The wire contract stated end to end: the comma form is not a second
    // accepted spelling, and it fails loudly instead of returning the
    // unnarrowed population.
    const organizationId = await seedRouteCorpus();
    mockAuthContext = createTestAuthContext({
      user: { ...createTestAuthContext().user, organizationId },
    });

    const response = await GET(
      new NextRequest(
        `http://localhost:3002/documents?limit=${PAGE_SIZE}&status=${IssueStatus.Todo},${IssueStatus.InProgress}`,
        { method: "GET" }
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
  });
});

/**
 * {@link seedPagedCorpus} plus a second buried row, so the route case can prove
 * BOTH requested statuses survived the query string. One wanted row cannot: a
 * shape that kept only the last occurrence would still return it.
 */
async function seedRouteCorpus(): Promise<string> {
  const organizationId = await seedPagedCorpus();
  await createIssue(organizationId, {
    name: "Buried IN_PROGRESS issue",
    status: IssueStatus.InProgress,
    createdAt: new Date(Date.UTC(2025, 11, 31)),
  });
  return organizationId;
}

/**
 * A corpus whose single TODO is unreachable from page one.
 *
 * The list orders `createdAt DESC, id DESC`, so the TODO is stamped OLDEST and
 * {@link DECOY_COUNT} newer non-TODO rows sit ahead of it — more than two full
 * pages. Timestamps are explicit rather than insertion-ordered so the planted
 * position is a property of the fixture and not of how fast the inserts ran.
 */
async function seedPagedCorpus(): Promise<string> {
  const organizationId = await createTestOrganization();
  const base = Date.UTC(2026, 0, 1);
  const dayMs = 86_400_000;

  for (let index = 0; index < DECOY_COUNT; index++) {
    await createIssue(organizationId, {
      name: `Decoy issue ${index}`,
      status: index % 2 === 0 ? IssueStatus.Done : IssueStatus.InReview,
      createdAt: new Date(base + (index + 1) * dayMs),
    });
  }
  await createIssue(organizationId, {
    name: "Buried TODO issue",
    status: IssueStatus.Todo,
    createdAt: new Date(base),
  });

  return organizationId;
}

async function createIssue(
  organizationId: string,
  overrides: { name: string; status: ArtifactStatus; createdAt?: Date }
): Promise<void> {
  await createArtifact(organizationId, DocumentType.Feature, overrides);
}

async function createDocumentArtifact(
  organizationId: string,
  overrides: { name: string; status: ArtifactStatus; createdAt?: Date }
): Promise<void> {
  await createArtifact(organizationId, DocumentType.Prd, overrides);
}

async function createArtifact(
  organizationId: string,
  subtype: DocumentType,
  overrides: { name: string; status: ArtifactStatus; createdAt?: Date }
): Promise<void> {
  await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.Document,
        subtype,
        ...overrides,
      },
      select: { id: true },
    })
  );
}

/** Titles the unbounded org-level list read returns for a status set. */
async function findTitles(
  organizationId: string,
  status: readonly ArtifactStatus[],
  extra: { type?: DocumentType } = {}
): Promise<string[]> {
  const documents = await documentListRead.findAllDocuments({
    organizationId,
    status,
    ...extra,
  });
  return documents.map((document) => document.title);
}
