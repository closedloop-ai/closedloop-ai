import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import { matchesFilter } from "@repo/app/documents/lib/document-filter";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { documentListRead } from "./document-list-read";
import { documentListService } from "./document-list-service";

/**
 * ISS-9724 — `GET /documents` narrows by free text IN THE DATABASE, over the
 * whole matching population.
 *
 * The ticket exists because the Documents index cannot page server-side without
 * this: paging a read whose search still runs over the loaded rows silently
 * turns "find it anywhere" into "find it on this page". So the load-bearing case
 * here is the first one — the match is deliberately seeded where a first page
 * could never reach it, and the assertion is that a page-one request still
 * returns it. A single-page or single-row fixture would pass with the predicate
 * deleted and prove nothing.
 *
 * These run against a real Postgres because the claim is about what the DATABASE
 * does with the predicate — Prisma's `mode: "insensitive"`, `contains` against a
 * NULL slug, and whether `%`/`_`/`'` reach it as data or as pattern syntax are
 * all properties of the compiled SQL, and a mocked client would assert only the
 * object this repo already builds.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** Rows per page in the paging cases. Small enough that page 1 cannot cheat. */
const PAGE_SIZE = 5;
/** How many decoys sit ahead of the planted match in newest-first order. */
const DECOY_COUNT = 11;

type SeededOrg = { organizationId: string };

describeIfDb("document list search predicate (ISS-9724)", () => {
  it("returns a match that lives past the first page", async () => {
    const { organizationId } = await seedPagedCorpus();

    const page = await documentListService.findPageWithCustomFields({
      organizationId,
      unassignedProject: true,
      limit: PAGE_SIZE,
      offset: 0,
      search: "porcupine",
    });

    expect(page.items.map((item) => item.title)).toEqual([
      "Buried porcupine runbook",
    ]);
    // The total is over the matching population, not the page: a client that
    // paged this read is told there is exactly one match anywhere, so it cannot
    // offer a second page that does not exist.
    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it("returns nothing but the decoys when the same read carries no search", async () => {
    // The control for the case above. Without the predicate the planted match is
    // unreachable from page one — which is exactly the behavior the predicate
    // exists to change, and the reason the first case is not vacuous.
    const { organizationId } = await seedPagedCorpus();

    const page = await documentListService.findPageWithCustomFields({
      organizationId,
      unassignedProject: true,
      limit: PAGE_SIZE,
      offset: 0,
    });

    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.items.map((item) => item.title)).not.toContain(
      "Buried porcupine runbook"
    );
    expect(page.total).toBe(DECOY_COUNT + 1);
  });

  it("matches case-insensitively and on the slug as well as the title", async () => {
    const organizationId = await createTestOrganization();
    await createDocument(organizationId, {
      name: "Quarterly Planning",
      slug: "ISS-1111",
    });
    await createDocument(organizationId, {
      name: "Unrelated note",
      slug: "ISS-2222",
    });

    const byUpperCasedTitle = await findTitles(organizationId, "QUARTERLY");
    const byLowerCasedSlug = await findTitles(organizationId, "iss-2222");

    expect(byUpperCasedTitle).toEqual(["Quarterly Planning"]);
    expect(byLowerCasedSlug).toEqual(["Unrelated note"]);
  });

  it("keeps a slug-less artifact reachable by its title", async () => {
    // `slug` is nullable and `contains` cannot match NULL, so an OR'd predicate
    // that leaned on the slug would drop every org-level doc that has none.
    const organizationId = await createTestOrganization();
    await createDocument(organizationId, {
      name: "Slugless evergreen doc",
      slug: null,
    });

    expect(await findTitles(organizationId, "evergreen")).toEqual([
      "Slugless evergreen doc",
    ]);
  });

  it("treats a percent sign as text rather than a wildcard", async () => {
    // The parameterization proof. If the term reached SQL as pattern syntax,
    // `100%` would match every title starting `100` — including the decoy.
    const organizationId = await createTestOrganization();
    await createDocument(organizationId, { name: "100% coverage plan" });
    await createDocument(organizationId, { name: "100 percent coverage plan" });

    expect(await findTitles(organizationId, "100%")).toEqual([
      "100% coverage plan",
    ]);
  });

  it("treats an underscore as text rather than a single-character wildcard", async () => {
    const organizationId = await createTestOrganization();
    await createDocument(organizationId, { name: "release_notes draft" });
    await createDocument(organizationId, { name: "releaseXnotes draft" });

    expect(await findTitles(organizationId, "release_notes")).toEqual([
      "release_notes draft",
    ]);
  });

  it("treats a backslash as text rather than a LIKE escape character", async () => {
    // The escaping itself introduces backslashes, so an unescaped backslash in
    // the term would neutralize the very character after it.
    const organizationId = await createTestOrganization();
    await createDocument(organizationId, { name: String.raw`path\to spec` });
    await createDocument(organizationId, { name: "pathXto spec" });

    expect(await findTitles(organizationId, String.raw`path\to`)).toEqual([
      String.raw`path\to spec`,
    ]);
  });

  it("treats an apostrophe as text rather than a string terminator", async () => {
    const organizationId = await createTestOrganization();
    await createDocument(organizationId, { name: "Reviewer's checklist" });
    await createDocument(organizationId, { name: "Reviewers checklist" });

    expect(await findTitles(organizationId, "reviewer's")).toEqual([
      "Reviewer's checklist",
    ]);
  });

  it("returns an empty result rather than the whole list when nothing matches", async () => {
    const organizationId = await createTestOrganization();
    await createDocument(organizationId, { name: "Only document" });

    expect(await findTitles(organizationId, "nothing-matches-this")).toEqual(
      []
    );
  });

  it("applies no narrowing for a blank term", async () => {
    // The route rejects a blank term outright; a direct service caller that
    // passes one must still get the unnarrowed list rather than an empty one.
    const organizationId = await createTestOrganization();
    await createDocument(organizationId, { name: "Only document" });

    expect(await findTitles(organizationId, "   ")).toEqual(["Only document"]);
  });

  it.each(SEMANTICS_PROBES)(
    "agrees with the index's own client-side filter on %s",
    async (_label, term) => {
      // The guard the ticket asks for: this surface now has TWO implementations
      // of "does this artifact match" — the SQL predicate and `matchesFilter`,
      // which the table still runs over whatever it holds. A term either finds
      // the same artifacts through both or the reader sees one answer while the
      // other is what the server counted.
      const organizationId = await seedSemanticsCorpus();

      const fromDatabase = await findTitles(organizationId, term);
      const fromClientFilter = SEMANTICS_CORPUS.filter((row) =>
        // `slug ?? ""` is not a convenience: it is what the row adapter does
        // (`artifact.slug ?? ""`), so the client filter is asked about exactly
        // the value it would see in the browser.
        matchesFilter({ title: row.name, slug: row.slug ?? "" }, term)
      ).map((row) => row.name);

      expect([...fromDatabase].sort()).toEqual([...fromClientFilter].sort());
    }
  );

  it("composes with the archived-project exclusion instead of replacing it", async () => {
    // Both slices contribute a disjunction to one `where`. A bare `OR` from the
    // search would have overwritten the archived-project `OR` on spread, and the
    // clobber is silent — whichever lost would simply stop narrowing.
    const organizationId = await createTestOrganization();
    const author = await createTestUser(organizationId);
    const archivedProjectId = await createTestProject(
      organizationId,
      author.id,
      {
        status: ProjectStatus.Archived,
      }
    );
    await createDocument(organizationId, {
      name: "Archived shared term",
      projectId: archivedProjectId,
    });
    await createDocument(organizationId, { name: "Live shared term" });

    const documents = await documentListRead.findAllDocuments({
      organizationId,
      search: "shared term",
      includeArchivedProjects: false,
    });

    expect(documents.map((document) => document.title)).toEqual([
      "Live shared term",
    ]);
  });
});

/**
 * One corpus both predicates are asked about, chosen so the ways they could
 * plausibly disagree are all represented: letter case, a mid-word fragment no
 * lexeme-based matcher would find, LIKE metacharacters, a slug-only hit, and a
 * NULL slug (which the adapter hands the client as `""`).
 */
const SEMANTICS_CORPUS: readonly { name: string; slug: string | null }[] = [
  { name: "Quarterly Planning", slug: "ISS-4001" },
  { name: "deployment checklist", slug: "ISS-4002" },
  { name: "100% coverage plan", slug: "ISS-4003" },
  { name: "release_notes draft", slug: "ISS-4004" },
  { name: "Reviewer's checklist", slug: "ISS-4005" },
  { name: "Slugless evergreen", slug: null },
  // Near-misses, and they are the whole reason the metacharacter probes can
  // fail. Without them `100%` and `release_notes` each match exactly one row
  // whether or not the wildcards are neutralized, so both predicates return the
  // same set and the comparison proves nothing. Each decoy differs from its
  // partner only where a LIKE wildcard would stop caring.
  { name: "100 percent coverage plan", slug: "ISS-4006" },
  { name: "releaseXnotes draft", slug: "ISS-4007" },
  { name: "ISSX4004 lookalike", slug: "ISS-4008" },
];

/** Terms probed against {@link SEMANTICS_CORPUS}, each with a stated reason. */
const SEMANTICS_PROBES: readonly [string, string][] = [
  ["a differently-cased title", "QUARTERLY"],
  ["a mid-word fragment", "eploy"],
  ["a percent sign", "100%"],
  ["an underscore", "release_notes"],
  ["an apostrophe", "reviewer's"],
  ["a slug", "iss-4004"],
  ["a term nothing carries", "zzzz-no-such-thing"],
];

/**
 * A corpus whose single match is unreachable from page one.
 *
 * The list orders `createdAt DESC, id DESC`, so the match is stamped OLDEST and
 * {@link DECOY_COUNT} newer decoys sit ahead of it — more than two full pages.
 * Timestamps are explicit rather than insertion-ordered so the planted position
 * is a property of the fixture and not of how fast the inserts ran.
 */
async function seedPagedCorpus(): Promise<SeededOrg> {
  const organizationId = await createTestOrganization();
  const base = Date.UTC(2026, 0, 1);
  const dayMs = 86_400_000;

  for (let index = 0; index < DECOY_COUNT; index++) {
    await createDocument(organizationId, {
      name: `Decoy runbook ${index}`,
      createdAt: new Date(base + (index + 1) * dayMs),
    });
  }
  await createDocument(organizationId, {
    name: "Buried porcupine runbook",
    createdAt: new Date(base),
  });

  return { organizationId };
}

/** {@link SEMANTICS_CORPUS} persisted into a fresh org. */
async function seedSemanticsCorpus(): Promise<string> {
  const organizationId = await createTestOrganization();
  for (const row of SEMANTICS_CORPUS) {
    await createDocument(organizationId, row);
  }
  return organizationId;
}

async function createDocument(
  organizationId: string,
  overrides: {
    name: string;
    slug?: string | null;
    projectId?: string;
    createdAt?: Date;
  }
): Promise<void> {
  await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.Document,
        subtype: DocumentType.Doc,
        status: DocumentStatus.Draft,
        ...overrides,
      },
      select: { id: true },
    })
  );
}

/** Titles the unbounded org-level list read returns for `search`. */
async function findTitles(
  organizationId: string,
  search: string
): Promise<string[]> {
  const documents = await documentListRead.findAllDocuments({
    organizationId,
    search,
  });
  return documents.map((document) => document.title);
}
