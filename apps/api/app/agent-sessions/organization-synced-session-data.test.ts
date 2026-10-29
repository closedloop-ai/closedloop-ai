/**
 * ISS-8375 coverage for the Web `DownloadDesktop` skip input.
 *
 * The fake below models Prisma's own `findFirst` semantics rather than the
 * caller's arguments: it evaluates whatever the production `where` actually
 * contained, and **an absent key constrains nothing**. That is what makes the
 * cross-tenant case decidable here — drop `organizationId` from the production
 * `where` and the foreign row starts matching, so the test goes red. A fake
 * that filtered on the `organizationId` parameter instead would stay green and
 * reintroduce the false negative one layer down.
 *
 * It also THROWS on a `where` key it does not model, so a predicate added to
 * production (an `origin` exclusion, a `pendingChunkRevision` filter) cannot
 * quietly pass through unevaluated and leave the "not excluded" cases green.
 */
import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, mockFindFirst, mockLogError } = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockFindFirst: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: Object.assign(mockWithDb, { tx: vi.fn() }),
  };
});

import { ArtifactType } from "@repo/api/src/types/artifact";
import { SessionOrigin } from "@repo/database";
import { organizationHasSyncedSessionData } from "./organization-synced-session-data";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "11111111-1111-4111-8111-111111111112";

/** The SessionDetail columns a plausible exclusion would filter on. */
type FakeSessionFacts = {
  origin: SessionOrigin;
  pendingChunkRevision: number | null;
  dataRevision: number | null;
  dataSyncLevel: string | null;
};

type FakeArtifactRow = {
  id: string;
  organizationId: string;
  type: ArtifactType;
  status: string;
  /** Null for a non-SESSION artifact, which carries no SessionDetail. */
  session: FakeSessionFacts | null;
};

type FakeSessionWhere = Partial<FakeSessionFacts>;

/** Both Prisma spellings of a to-one relation filter: `{ is: {…} }` and `{…}`. */
type FakeSessionRelationWhere = FakeSessionWhere & { is?: FakeSessionWhere };

type FakeArtifactWhere = {
  id?: string;
  organizationId?: string;
  type?: ArtifactType;
  status?: string;
  session?: FakeSessionRelationWhere;
};

type FakeArtifactQuery = {
  where: FakeArtifactWhere;
  select?: Record<string, boolean>;
  orderBy?: unknown;
  take?: number;
};

const ARTIFACT_SCALAR_KEYS: Record<
  "id" | "organizationId" | "type" | "status",
  true
> = { id: true, organizationId: true, type: true, status: true };

const SESSION_SCALAR_KEYS: Record<keyof FakeSessionFacts, true> = {
  origin: true,
  pendingChunkRevision: true,
  dataRevision: true,
  dataSyncLevel: true,
};

let rows: FakeArtifactRow[] = [];
let queries: FakeArtifactQuery[] = [];

function sessionRow(
  id: string,
  organizationId: string,
  session: Partial<FakeSessionFacts> = {}
): FakeArtifactRow {
  return {
    id,
    organizationId,
    type: ArtifactType.Session,
    status: "active",
    session: {
      origin: SessionOrigin.DESKTOP_SYNC,
      pendingChunkRevision: null,
      dataRevision: 3,
      dataSyncLevel: "full",
      ...session,
    },
  };
}

function unwrapRelationFilter(
  filter: FakeSessionRelationWhere
): FakeSessionWhere {
  return filter.is ?? filter;
}

function matchesSession(
  session: FakeSessionFacts | null,
  filter: FakeSessionWhere
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (expected === undefined) {
      continue;
    }
    if (!Object.hasOwn(SESSION_SCALAR_KEYS, key)) {
      throw new Error(
        `fake artifact.findFirst: unmodelled session where key "${key}"`
      );
    }
    if (session === null) {
      return false;
    }
    if (session[key as keyof FakeSessionFacts] !== expected) {
      return false;
    }
  }
  return true;
}

function matchesArtifact(
  row: FakeArtifactRow,
  where: FakeArtifactWhere
): boolean {
  const { session: sessionWhere, ...scalarWhere } = where;
  if (
    sessionWhere !== undefined &&
    !matchesSession(row.session, unwrapRelationFilter(sessionWhere))
  ) {
    return false;
  }
  for (const [key, expected] of Object.entries(scalarWhere)) {
    // Prisma: a key that is absent (or undefined) constrains nothing.
    if (expected === undefined) {
      continue;
    }
    if (!Object.hasOwn(ARTIFACT_SCALAR_KEYS, key)) {
      throw new Error(`fake artifact.findFirst: unmodelled where key "${key}"`);
    }
    if (row[key as keyof typeof ARTIFACT_SCALAR_KEYS] !== expected) {
      return false;
    }
  }
  return true;
}

describe("organizationHasSyncedSessionData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    queries = [];
    mockFindFirst.mockImplementation((query: FakeArtifactQuery) => {
      queries.push(query);
      const hit = rows.find((row) => matchesArtifact(row, query.where));
      return Promise.resolve(hit ? { id: hit.id } : null);
    });
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ artifact: { findFirst: mockFindFirst } })
    );
  });

  it("reports No for an organization with no artifacts at all", async () => {
    await expect(organizationHasSyncedSessionData(ORG_A)).resolves.toBe(
      KnownFlag.No
    );
  });

  it("reports Yes once the organization has one synced SESSION artifact", async () => {
    rows = [sessionRow("session-a", ORG_A)];

    await expect(organizationHasSyncedSessionData(ORG_A)).resolves.toBe(
      KnownFlag.Yes
    );
  });

  it("reports No when the only SESSION artifact belongs to another organization", async () => {
    rows = [sessionRow("session-b", ORG_B)];

    await expect(organizationHasSyncedSessionData(ORG_A)).resolves.toBe(
      KnownFlag.No
    );
  });

  it("counts a LOOP-origin session: it arrives through the same desktop sync route", async () => {
    rows = [sessionRow("session-loop", ORG_A, { origin: SessionOrigin.LOOP })];

    await expect(organizationHasSyncedSessionData(ORG_A)).resolves.toBe(
      KnownFlag.Yes
    );
  });

  it("counts a session with a chunk still in flight: partial data is real data", async () => {
    rows = [
      sessionRow("session-chunking", ORG_A, {
        pendingChunkRevision: 7,
        dataRevision: null,
        dataSyncLevel: null,
      }),
    ];

    await expect(organizationHasSyncedSessionData(ORG_A)).resolves.toBe(
      KnownFlag.Yes
    );
  });

  it("reports No when the organization owns only non-SESSION artifacts", async () => {
    rows = [
      {
        id: "doc-a",
        organizationId: ORG_A,
        type: ArtifactType.Document,
        status: "DRAFT",
        session: null,
      },
      {
        id: "branch-a",
        organizationId: ORG_A,
        type: ArtifactType.Branch,
        status: "open",
        session: null,
      },
    ];

    await expect(organizationHasSyncedSessionData(ORG_A)).resolves.toBe(
      KnownFlag.No
    );
  });

  it("resolves a failed read to Unknown rather than No, and still answers No on a healthy empty read", async () => {
    mockFindFirst.mockRejectedValueOnce(new Error("connection terminated"));

    const failed = await organizationHasSyncedSessionData(ORG_A);

    expect(failed).toBe(KnownFlag.Unknown);
    // PRD-689: Unknown is not false. A read that never answered must not be
    // reported as the answer "this org has nothing".
    expect(failed).not.toBe(KnownFlag.No);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("synced session probe failed"),
      expect.objectContaining({
        organizationId: ORG_A,
        error: "connection terminated",
      })
    );

    // Counterfactual: the same call over a healthy, genuinely empty read. An
    // implementation stuck on Unknown passes the assertions above and fails
    // this one.
    await expect(organizationHasSyncedSessionData(ORG_A)).resolves.toBe(
      KnownFlag.No
    );
  });

  it("issues one bounded org-scoped seek: organizationId + type, id-only select, no orderBy", async () => {
    await organizationHasSyncedSessionData(ORG_A);

    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    const query = queries[0];
    expect(query?.where).toEqual({
      organizationId: ORG_A,
      type: ArtifactType.Session,
    });
    expect(query?.select).toEqual({ id: true });
    // An orderBy would trade the index seek for a sort over every session row
    // in the org, and findFirst is free to take an arbitrary match.
    expect(query?.orderBy).toBeUndefined();
  });
});
