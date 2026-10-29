/**
 * ISS-9699 — DB-free unit tests for the `--only=<corpus>` source selection on
 * the `search_document` backfill, and for the targeted refresh it exists to
 * make safe. Shares the in-memory `SearchBackfillClient` fake and record
 * factories with the other corpus suites via the fixtures module.
 */

import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { describe, expect, it } from "vitest";
// Deliberately imported from `backfill-search-documents`, NOT from
// `search-backfill-types` where they are now declared: the file-size split moved
// these three names, and this import is what fails typecheck if the compat
// re-export that keeps their original path working is ever dropped (davetho).
import type {
  ProjectionRow,
  SearchBackfillClient,
  SearchBackfillCounts,
} from "./backfill-search-documents";
import {
  runSearchDocumentBackfill,
  runSearchDocumentBackfillFromArgv,
} from "./backfill-search-documents";
import {
  AT,
  agentComponent,
  artifact,
  branch,
  comment,
  makeFakeClient,
  ORG_A,
  project,
  pullRequest,
  type SourceReadCalls,
} from "./backfill-search-documents.fixtures";
import {
  ALL_SEARCH_BACKFILL_SOURCES,
  parseSearchBackfillSources,
  SearchBackfillSource,
} from "./search-backfill-sources";

/** Key a projection row the way the fake's store (and the SQL unique key) does. */
function keyOf(entityType: SearchEntityType, entityId: string): string {
  return `${ORG_A}|${entityType}|${entityId}`;
}

type CorpusWasRead = Record<SearchBackfillSource, boolean>;

/**
 * Which corpora the sweep actually QUERIED, as a whole-shape record.
 *
 * The store-shaped assertions below only prove the other corpora were not
 * WRITTEN, and the fake's `findMany` is side-effect-free — so a selection check
 * moved after the page read leaves every one of them green while a
 * documents-only production run still queries all six tables inside the
 * transaction (whitlockk, review). Only the delegate tally separates those.
 *
 * Compared as one record rather than per-key so the expectation states BOTH
 * halves at once: the named corpus was read, and no other was. A test that only
 * asserted the zeroes would also pass on a sweep that read nothing at all.
 */
function corporaRead(readCalls: SourceReadCalls): CorpusWasRead {
  return Object.fromEntries(
    ALL_SEARCH_BACKFILL_SOURCES.map((source) => [source, readCalls[source] > 0])
  ) as CorpusWasRead;
}

/** The same record shape, built from the corpora a run was asked for. */
function onlyCorpora(expected: readonly SearchBackfillSource[]): CorpusWasRead {
  const wanted = new Set(expected);
  return Object.fromEntries(
    ALL_SEARCH_BACKFILL_SOURCES.map((source) => [source, wanted.has(source)])
  ) as CorpusWasRead;
}

/** A projection row in whatever shape a prior run left behind. */
function existingRow(
  over: Partial<ProjectionRow> & {
    entityType: SearchEntityType;
    entityId: string;
  }
): ProjectionRow {
  return {
    organizationId: ORG_A,
    title: "left by an earlier run",
    body: null,
    projectId: null,
    assigneeId: null,
    status: null,
    priority: null,
    updatedAt: AT,
    slug: null,
    entitySubtype: null,
    teamId: null,
    anchorEntityId: null,
    ...over,
  };
}

/**
 * The two `priority` column states a `search_document` row can be in for an
 * artifact whose column is unset, named for what the search grammar does with
 * each TODAY: `priority:medium` compiles to an equality on the MEDIUM ordinal
 * (so it claims a stale row), and `priority!=MEDIUM` compiles to
 * `IS DISTINCT FROM` that ordinal (so it claims the corrected NULL row and
 * misses the stale one). ISS-9665 adds a `priority:none` arm over the same NULL
 * state, but that predicate is not in the grammar yet, so it is not what these
 * assert.
 *
 * Spelled out with literals rather than imported from the filter builder: this
 * suite polices what the backfill WRITES into the column, so its expectation
 * must not be derived from the code that reads it.
 */
function idsMatchingPriorityMedium(
  store: Map<string, ProjectionRow>
): string[] {
  return [...store.values()]
    .filter((row) => row.priority === "MEDIUM")
    .map((row) => row.entityId);
}
function idsMatchingPriorityNotMedium(
  store: Map<string, ProjectionRow>
): string[] {
  // `IS DISTINCT FROM 'MEDIUM'` — NULL included, which is the whole point.
  return [...store.values()]
    .filter((row) => row.priority !== "MEDIUM")
    .map((row) => row.entityId);
}

describe("parseSearchBackfillSources (ISS-9699)", () => {
  it("returns undefined when --only is absent, so a forgotten flag still sweeps everything", () => {
    expect(parseSearchBackfillSources([])).toBeUndefined();
    expect(parseSearchBackfillSources(["--page-size=10"])).toBeUndefined();
  });

  it("maps the CLI spelling of one corpus to its source", () => {
    expect(parseSearchBackfillSources(["--only=documents"])).toEqual([
      SearchBackfillSource.Documents,
    ]);
  });

  it("accepts a comma list and trims each name", () => {
    expect(
      parseSearchBackfillSources(["--only=documents, pull-requests"])
    ).toEqual([
      SearchBackfillSource.Documents,
      SearchBackfillSource.PullRequests,
    ]);
  });

  it("throws on an unrecognised corpus instead of narrowing to a silent zero-row run", () => {
    expect(() => parseSearchBackfillSources(["--only=docs"])).toThrow("docs");
  });

  it("throws on an empty --only value", () => {
    expect(() => parseSearchBackfillSources(["--only="])).toThrow();
    expect(() => parseSearchBackfillSources(["--only= , "])).toThrow();
  });

  it("unions repeated --only flags instead of honouring only the first", () => {
    expect(
      parseSearchBackfillSources(["--only=documents", "--only=branches"])
    ).toEqual([SearchBackfillSource.Documents, SearchBackfillSource.Branches]);
  });

  it("de-duplicates a corpus named twice", () => {
    expect(parseSearchBackfillSources(["--only=documents,documents"])).toEqual([
      SearchBackfillSource.Documents,
    ]);
  });

  it("throws on a malformed --only rather than falling through to a full sweep", () => {
    // `--only documents` (space, no `=`) matches no `--only=` prefix. Returning
    // undefined here would sweep every corpus — the opposite of what was typed.
    expect(() => parseSearchBackfillSources(["--only", "documents"])).toThrow(
      "--only"
    );
    expect(() => parseSearchBackfillSources(["--onlydocuments"])).toThrow();
  });
});

describe("runSearchDocumentBackfillFromArgv (ISS-9699)", () => {
  function seedTwoCorpora() {
    return makeFakeClient({
      artifacts: [artifact({ id: "a1", name: "Doc", priority: null })],
      projects: [project({ id: "p1", name: "Proj" })],
      agentComponents: [agentComponent({ id: "ac1" })],
    });
  }

  it("applies the argv selection to the sweep, not just to the log line", async () => {
    const { client, store, readCalls } = seedTwoCorpora();

    const { counts, sources } = await runSearchDocumentBackfillFromArgv(
      client,
      ["--only=documents"]
    );

    // If the argv→sources wiring were dropped, this run would sweep every
    // corpus and these four assertions would all move.
    expect(sources).toEqual([SearchBackfillSource.Documents]);
    expect(counts.documents).toBe(1);
    expect(counts.projects).toBe(0);
    expect(store.has(keyOf(SearchEntityType.Project, "p1"))).toBe(false);
    expect(corporaRead(readCalls)).toEqual(
      onlyCorpora([SearchBackfillSource.Documents])
    );
  });

  it("reports the full corpus list when argv names none", async () => {
    const { client, readCalls } = seedTwoCorpora();

    const { counts, sources } = await runSearchDocumentBackfillFromArgv(
      client,
      []
    );

    expect(sources).toEqual(ALL_SEARCH_BACKFILL_SOURCES);
    expect(counts.projects).toBe(1);
    expect(corporaRead(readCalls)).toEqual(
      onlyCorpora(ALL_SEARCH_BACKFILL_SOURCES)
    );
  });

  it("propagates a malformed flag instead of silently sweeping everything", async () => {
    const { client } = seedTwoCorpora();

    await expect(
      runSearchDocumentBackfillFromArgv(client, ["--only", "documents"])
    ).rejects.toThrow("--only");
  });
});

describe("runSearchDocumentBackfill — targeted refresh (ISS-9699)", () => {
  /**
   * Seed a corpus where the DOCUMENT projection is STALE in the pre-ISS-9665
   * shape: `indexDocumentProjection` built its row from `toDocument()` output,
   * which folded a NULL artifact priority to `MEDIUM`. A suite seeded only from
   * the record factories would project a correct row on its first pass and
   * prove nothing about the corpus already sitting in production, so the store
   * is pre-loaded with the wrong row and must end right.
   *
   * That specific drift is repaired in production by the #6796 data migration,
   * not by this script. It is used here because it is a realistic, already-
   * understood way for one corpus to be wrong while the others are fine — the
   * shape a narrowed reconcile exists for — not because this suite claims the
   * remedy.
   */
  function seedStaleCorpus() {
    const fake = makeFakeClient({
      artifacts: [artifact({ id: "a1", name: "Doc", priority: null })],
      projects: [project({ id: "p1", name: "Proj" })],
      comments: [comment({ id: "c1" })],
      pullRequests: [pullRequest({ id: "pr1" })],
      branches: [branch({ artifactId: "b1" })],
      agentComponents: [agentComponent({ id: "ac1" })],
    });

    fake.store.set(
      keyOf(SearchEntityType.Document, "a1"),
      existingRow({
        entityType: SearchEntityType.Document,
        entityId: "a1",
        title: "Doc",
        priority: "MEDIUM",
      })
    );
    // A row from a corpus this run will NOT name, to prove the narrowing.
    fake.store.set(
      keyOf(SearchEntityType.Project, "p1"),
      existingRow({
        entityType: SearchEntityType.Project,
        entityId: "p1",
        title: "stale project title",
      })
    );
    // An agent-component projection whose source component is gone. The full
    // sweep's anti-join deletes it; a narrowed run must not.
    fake.store.set(
      keyOf(SearchEntityType.AgentComponent, "orphan"),
      existingRow({
        entityType: SearchEntityType.AgentComponent,
        entityId: "orphan",
      })
    );

    return fake;
  }

  it("corrects a stale MEDIUM row for an unset priority: priority:medium loses it, priority!=MEDIUM gains it", async () => {
    const { client, store } = seedStaleCorpus();

    // The gap itself, asserted rather than assumed — this is the state the
    // production corpus is in before the refresh.
    expect(idsMatchingPriorityMedium(store)).toContain("a1");
    expect(idsMatchingPriorityNotMedium(store)).not.toContain("a1");

    await runSearchDocumentBackfill(client, {
      sources: [SearchBackfillSource.Documents],
    });

    // Both directions. `toBeNull` on the row, not a falsy check: an absent row
    // would mean the refresh dropped the key rather than correcting it.
    expect(
      store.get(keyOf(SearchEntityType.Document, "a1"))?.priority
    ).toBeNull();
    expect(idsMatchingPriorityMedium(store)).not.toContain("a1");
    expect(idsMatchingPriorityNotMedium(store)).toContain("a1");
  });

  it("corrects the row in place rather than adding a competing projection", async () => {
    const { client, store } = seedStaleCorpus();
    const before = store.size;

    await runSearchDocumentBackfill(client, {
      sources: [SearchBackfillSource.Documents],
    });

    // A second row for the same artifact would leave the stale one still
    // answering `priority:medium`.
    expect(store.size).toBe(before);
  });

  it("reads and rewrites only the named corpus", async () => {
    const { client, store, readCalls } = seedStaleCorpus();

    // Annotated with the two types re-exported from `backfill-search-documents`
    // so this file consumes the compat path described at the import above.
    const backfillClient: SearchBackfillClient = client;
    const counts: SearchBackfillCounts = await runSearchDocumentBackfill(
      backfillClient,
      { sources: [SearchBackfillSource.Documents] }
    );

    // The READ half — the one the counts and the store cannot speak to.
    expect(corporaRead(readCalls)).toEqual(
      onlyCorpora([SearchBackfillSource.Documents])
    );

    expect(counts.documents).toBe(1);
    expect(counts.projects).toBe(0);
    expect(counts.comments).toBe(0);
    expect(counts.pullRequests).toBe(0);
    expect(counts.branches).toBe(0);
    expect(counts.agentComponents).toBe(0);
    expect(counts.total).toBe(1);

    // The unnamed corpus keeps the row the earlier run left, untouched.
    expect(store.get(keyOf(SearchEntityType.Project, "p1"))?.title).toBe(
      "stale project title"
    );
  });

  it("does not run the destructive component prune for a corpus it was not asked to refresh", async () => {
    const { client, store, readCalls } = seedStaleCorpus();

    const counts = await runSearchDocumentBackfill(client, {
      sources: [SearchBackfillSource.Documents],
    });

    expect(readCalls[SearchBackfillSource.AgentComponents]).toBe(0);
    expect(counts.staleAgentComponentsRemoved).toBe(0);
    expect(store.has(keyOf(SearchEntityType.AgentComponent, "orphan"))).toBe(
      true
    );
  });

  it("is idempotent: a second targeted run re-derives the same row and adds none", async () => {
    const { client, store } = seedStaleCorpus();

    const first = await runSearchDocumentBackfill(client, {
      sources: [SearchBackfillSource.Documents],
    });
    const sizeAfterFirst = store.size;
    const second = await runSearchDocumentBackfill(client, {
      sources: [SearchBackfillSource.Documents],
    });

    expect(second.documents).toBe(first.documents);
    expect(store.size).toBe(sizeAfterFirst);
    expect(
      store.get(keyOf(SearchEntityType.Document, "a1"))?.priority
    ).toBeNull();
  });

  it("re-derives a branch row from the artifact's own priority, so the reconcile net cannot erase one (ISS-10332)", async () => {
    const fake = makeFakeClient({
      artifacts: [],
      projects: [],
      branches: [
        branch({ artifactId: "b-high", priority: "HIGH" }),
        branch({ artifactId: "b-none", priority: null }),
      ],
    });
    // A row the write hook projected with a priority; a backfill that still
    // hardcoded `null` for branches would put it back to unset.
    fake.store.set(
      keyOf(SearchEntityType.Branch, "b-high"),
      existingRow({
        entityType: SearchEntityType.Branch,
        entityId: "b-high",
        priority: "HIGH",
      })
    );

    await runSearchDocumentBackfill(fake.client, {
      sources: [SearchBackfillSource.Branches],
    });

    expect(
      fake.store.get(keyOf(SearchEntityType.Branch, "b-high"))?.priority
    ).toBe("HIGH");
    expect(
      fake.store.get(keyOf(SearchEntityType.Branch, "b-none"))?.priority
    ).toBeNull();
  });

  it("sweeps every corpus, and prunes, when no sources are named", async () => {
    const { client, store, readCalls } = seedStaleCorpus();

    const counts = await runSearchDocumentBackfill(client);

    expect(corporaRead(readCalls)).toEqual(
      onlyCorpora(ALL_SEARCH_BACKFILL_SOURCES)
    );
    expect(counts.documents).toBe(1);
    expect(counts.projects).toBe(1);
    expect(counts.comments).toBe(1);
    expect(counts.pullRequests).toBe(1);
    expect(counts.branches).toBe(1);
    expect(counts.agentComponents).toBe(1);
    expect(counts.staleAgentComponentsRemoved).toBe(1);
    // The full sweep re-derives the project row the narrowed run left alone.
    expect(store.get(keyOf(SearchEntityType.Project, "p1"))?.title).toBe(
      "Proj"
    );
  });
});
