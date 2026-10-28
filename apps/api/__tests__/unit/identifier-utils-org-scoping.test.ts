/**
 * ISS-6988 — the resolver's own tenancy contract, proved against a DB fake that
 * models per-org visibility.
 *
 * `resolveDocumentId` used to return a UUID input unverified. Nothing was
 * exploitable, because every consumer re-scoped its own follow-up read — but
 * that put the boundary in the callers, so the first consumer to trust the
 * resolved id would have crossed orgs silently and no test would have moved.
 *
 * So these cases do not assert "the resolver builds the right `where`" (its
 * sibling suite does that). They drive the resolver through
 * {@link consumerThatTrustsTheResolver} — a stand-in for exactly that future
 * caller, which reads by the resolved id with NO organization predicate of its
 * own — and assert that the unscoped read still cannot reach another org's row.
 * Restore the `return id` passthrough and this suite goes red at the consumer,
 * which is the mistake it exists to make impossible.
 *
 * The fake follows Prisma's semantics per `apps/api/AGENTS.md`: an ABSENT
 * `where` key constrains nothing. Filtering on the caller's `organizationId`
 * argument instead of on what the resolver actually put in the `where` would
 * reintroduce the same false green one layer down.
 */
import { ArtifactType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: { DbNull: "DbNull" },
  ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH" },
}));

import {
  resolveArtifactIdentifier,
  resolveDocumentId,
  resolveProjectId,
} from "@/lib/identifier-utils";

const ORG_A = "org-a";
const ORG_B = "org-b";
const PROJECT_IN_A = "44444444-4444-4444-8444-444444444444";
const PROJECT_IN_B = "55555555-5555-4555-8555-555555555555";
const DOC_IN_A = "11111111-1111-4111-8111-111111111111";
const DOC_IN_B = "22222222-2222-4222-8222-222222222222";
const BRANCH_IN_B = "33333333-3333-4333-8333-333333333333";

type FakeArtifact = {
  id: string;
  organizationId: string;
  slug: string;
  type: string;
};

const ARTIFACTS: readonly FakeArtifact[] = [
  {
    id: DOC_IN_A,
    organizationId: ORG_A,
    slug: "ISS-1",
    type: ArtifactType.DOCUMENT,
  },
  {
    id: DOC_IN_B,
    organizationId: ORG_B,
    slug: "ISS-2",
    type: ArtifactType.DOCUMENT,
  },
  {
    id: BRANCH_IN_B,
    organizationId: ORG_B,
    slug: "BR-2",
    type: ArtifactType.BRANCH,
  },
];

type ArtifactWhere = {
  id?: string;
  organizationId?: string;
  slug?: { in: readonly string[] };
  type?: string;
};

/** Prisma semantics: every key PRESENT narrows; every key absent constrains nothing. */
function matches(row: FakeArtifact, where: ArtifactWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) {
    return false;
  }
  if (
    where.organizationId !== undefined &&
    row.organizationId !== where.organizationId
  ) {
    return false;
  }
  if (where.slug !== undefined && !where.slug.in.includes(row.slug)) {
    return false;
  }
  return !(where.type !== undefined && row.type !== where.type);
}

const findFirst = vi.fn(({ where }: { where: ArtifactWhere }) =>
  Promise.resolve(ARTIFACTS.find((row) => matches(row, where)) ?? null)
);

/**
 * The consumer this ticket is about: it trusts `resolveDocumentId` and reads by
 * the resolved id with no organization predicate of its own. Written the way a
 * route would be — resolve, 404 on null, then read — so the assertion below is
 * about reachability, not about how the resolver phrased its query.
 */
async function consumerThatTrustsTheResolver(
  id: string,
  organizationId: string
): Promise<FakeArtifact | null> {
  const resolvedId = await resolveDocumentId(id, organizationId);
  if (resolvedId === null) {
    return null;
  }
  return (await mocks.withDb(
    (db: { artifact: { findFirst: typeof findFirst } }) =>
      db.artifact.findFirst({ where: { id: resolvedId } })
  )) as FakeArtifact | null;
}

describe("resolveDocumentId — the resolved id is safe to use unscoped (ISS-6988)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ artifact: { findFirst } })
    );
  });

  it("lets an unscoped consumer read its OWN org's document", () => {
    // The positive control. Without it, a resolver that returned null for
    // everything would satisfy every isolation case below.
    return expect(
      consumerThatTrustsTheResolver(DOC_IN_A, ORG_A)
    ).resolves.toMatchObject({ id: DOC_IN_A, organizationId: ORG_A });
  });

  it("stops an unscoped consumer from reading another org's document by UUID", async () => {
    const reached = await consumerThatTrustsTheResolver(DOC_IN_B, ORG_A);

    expect(reached).toBeNull();
    // The consumer's own read carries no organization predicate, so the fake
    // would have handed over org-B's row had the resolver passed the id
    // through. Pinning that keeps the case honest if the consumer is rewritten.
    expect(
      findFirst.mock.calls.some(([{ where }]) => where.organizationId === ORG_A)
    ).toBe(true);
  });

  it("stops an unscoped consumer from reading another org's document by slug", async () => {
    const reached = await consumerThatTrustsTheResolver("ISS-2", ORG_A);

    expect(reached).toBeNull();
  });

  it("resolves a non-DOCUMENT artifact UUID only inside the caller's org", async () => {
    // `/documents/[id]/threads` reaches this resolver with a Branch artifact id,
    // so the UUID branch must still find one — but only in the caller's own org.
    await expect(resolveDocumentId(BRANCH_IN_B, ORG_B)).resolves.toBe(
      BRANCH_IN_B
    );
    await expect(resolveDocumentId(BRANCH_IN_B, ORG_A)).resolves.toBeNull();
  });
});

describe("resolveArtifactIdentifier — same tenancy contract (ISS-6988)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ artifact: { findFirst } })
    );
  });

  it("resolves inside the caller's org and refuses outside it", async () => {
    await expect(resolveArtifactIdentifier(DOC_IN_A, ORG_A)).resolves.toBe(
      DOC_IN_A
    );
    await expect(
      resolveArtifactIdentifier(DOC_IN_B, ORG_A)
    ).resolves.toBeNull();
  });
});

/**
 * ISS-7447 — the same tenancy contract for `resolveProjectId`, whose UUID branch
 * carried the identical unverified passthrough until this change.
 *
 * The fake follows Prisma semantics exactly as the artifact one above does: an
 * ABSENT `where` key constrains nothing. That is what makes
 * {@link projectConsumerThatTrustsTheResolver} decisive — its own read carries
 * no organization predicate, so restoring `return id` hands it org-B's project.
 */
type FakeProject = { id: string; organizationId: string; slug: string };

const PROJECTS: readonly FakeProject[] = [
  { id: PROJECT_IN_A, organizationId: ORG_A, slug: "PRO-1" },
  { id: PROJECT_IN_B, organizationId: ORG_B, slug: "PRO-2" },
];

type ProjectWhere = {
  id?: string;
  organizationId?: string;
  organizationId_slug?: { organizationId: string; slug: string };
};

function projectMatches(row: FakeProject, where: ProjectWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) {
    return false;
  }
  if (
    where.organizationId !== undefined &&
    row.organizationId !== where.organizationId
  ) {
    return false;
  }
  const composite = where.organizationId_slug;
  if (composite === undefined) {
    return true;
  }
  return (
    row.organizationId === composite.organizationId &&
    row.slug === composite.slug
  );
}

const projectFindFirst = vi.fn(({ where }: { where: ProjectWhere }) =>
  Promise.resolve(PROJECTS.find((row) => projectMatches(row, where)) ?? null)
);
const projectFindUnique = projectFindFirst;

/**
 * The consumer this ticket is about: it trusts `resolveProjectId` and reads by
 * the resolved id with no organization predicate of its own.
 */
async function projectConsumerThatTrustsTheResolver(
  id: string,
  organizationId: string
): Promise<FakeProject | null> {
  const resolvedId = await resolveProjectId(id, organizationId);
  if (resolvedId === null) {
    return null;
  }
  return (await mocks.withDb(
    (db: { project: { findFirst: typeof projectFindFirst } }) =>
      db.project.findFirst({ where: { id: resolvedId } })
  )) as FakeProject | null;
}

describe("resolveProjectId — the resolved id is safe to use unscoped (ISS-7447)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        project: { findFirst: projectFindFirst, findUnique: projectFindUnique },
      })
    );
  });

  it("lets an unscoped consumer read its OWN org's project", () => {
    // The positive control: without it, a resolver that returned null for
    // everything would satisfy both isolation cases below.
    return expect(
      projectConsumerThatTrustsTheResolver(PROJECT_IN_A, ORG_A)
    ).resolves.toMatchObject({ id: PROJECT_IN_A, organizationId: ORG_A });
  });

  it("stops an unscoped consumer from reading another org's project by UUID", async () => {
    const reached = await projectConsumerThatTrustsTheResolver(
      PROJECT_IN_B,
      ORG_A
    );

    expect(reached).toBeNull();
    // The consumer's own read carries no organization predicate, so the fake
    // would have handed over org-B's row had the resolver passed the id
    // through. Pinning that keeps the case honest if the consumer is rewritten.
    expect(
      projectFindFirst.mock.calls.some(
        ([{ where }]) => where.organizationId === ORG_A
      )
    ).toBe(true);
  });

  it("stops an unscoped consumer from reading another org's project by slug", () => {
    return expect(
      projectConsumerThatTrustsTheResolver("PRO-2", ORG_A)
    ).resolves.toBeNull();
  });
});
