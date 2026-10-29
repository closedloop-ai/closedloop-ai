/**
 * ISS-7235 — `GET /artifacts/[id]/related-sessions`.
 *
 * Org-scoping is driven through a fake that applies Prisma's own semantics: an
 * absent `where` key constrains nothing. So deleting `organizationId` from the
 * artifact lookup makes the other org's artifact resolve and the isolation case
 * turns red, which is the only thing that makes it coverage rather than
 * decoration. Every negative is paired with the positive sibling from the SAME
 * fake, because a lookup that resolved nothing at all would satisfy the
 * isolation assertion while breaking the feature.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  RELATED_SESSIONS_DISPLAY_CAP,
  RELATED_SESSIONS_PAGE_ARTIFACT_CAP,
} from "@repo/api/src/types/related-session";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_A = "11111111-1111-7111-8111-111111111111";
const ORG_B = "99999999-9999-7999-8999-999999999999";
const DOC_IN_ORG_A = "22222222-2222-7222-8222-222222222222";
const DOC_IN_ORG_B = "33333333-3333-7333-8333-333333333333";
const SESSION_IN_ORG_A = "44444444-4444-7444-8444-444444444444";

const mocks = vi.hoisted(() => {
  const withAnyAuthOptions: unknown[] = [];
  return {
    user: {
      id: "55555555-5555-7555-8555-555555555555",
      clerkId: "user_clerk_related_sessions",
      organizationId: "11111111-1111-7111-8111-111111111111",
    },
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
    withAnyAuthOptions,
    withAnyAuth: vi.fn(
      (
        handler: (...args: unknown[]) => Promise<Response>,
        options?: unknown
      ) => {
        withAnyAuthOptions.push(options);
        return (request: NextRequest, context?: { params: unknown }) =>
          handler({ user: mocks.user }, request, context?.params);
      }
    ),
    listRelatedSessions: vi.fn(),
    listRelatedSessionsForArtifacts: vi.fn(),
  };
});

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: mocks.withAnyAuth,
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: { DbNull: Symbol("DbNull") },
  ArtifactType: { DOCUMENT: "DOCUMENT", SESSION: "SESSION" },
}));

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: {
    listRelatedSessions: mocks.listRelatedSessions,
    listRelatedSessionsForArtifacts: mocks.listRelatedSessionsForArtifacts,
  },
}));

import { GET } from "../[id]/related-sessions/route";
import { POST } from "../related-sessions/route";

/** Every artifact the fake database knows about, across both orgs. */
const ARTIFACTS = [
  {
    id: DOC_IN_ORG_A,
    organizationId: ORG_A,
    type: ArtifactType.Document,
    slug: "PRD-42",
  },
  {
    id: DOC_IN_ORG_B,
    organizationId: ORG_B,
    type: ArtifactType.Document,
    slug: "PRD-43",
  },
  {
    id: SESSION_IN_ORG_A,
    organizationId: ORG_A,
    type: ArtifactType.Session,
    slug: "SES-1",
  },
];

function request() {
  return new NextRequest(
    "https://api.example.test/artifacts/x/related-sessions"
  );
}

function batchRequest(body: unknown) {
  return new NextRequest(
    "https://api.example.test/artifacts/related-sessions",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

function call(id: string) {
  return GET(request(), { params: Promise.resolve({ id }) });
}

function callBatch(body: unknown) {
  return POST(batchRequest(body), { params: Promise.resolve({}) });
}

const RESULT = {
  items: [
    {
      sessionArtifactId: SESSION_IN_ORG_A,
      slug: "SES-1",
      name: "Wrote the doc",
      status: "inactive",
      owner: null,
      kind: "contribution",
      contributedAt: "2026-08-21T09:04:00.000Z",
    },
  ],
  total: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRelatedSessions.mockResolvedValue(RESULT);
  mocks.listRelatedSessionsForArtifacts.mockResolvedValue({
    [DOC_IN_ORG_A]: RESULT,
  });
  const db = {
    artifact: {
      findUnique: ({ where }: { where: ArtifactWhere }) =>
        Promise.resolve(findArtifact(where)),
      // The identifier resolver's two branches both land here — `{ id, org }`
      // for a UUID, `{ slug: { in }, org, type }` for a slug.
      findFirst: ({ where }: { where: ArtifactWhere }) =>
        Promise.resolve(findArtifact(where)),
      findMany: ({ where }: { where: ArtifactWhere }) =>
        Promise.resolve(
          ARTIFACTS.filter((artifact) => matchesArtifact(artifact, where))
        ),
    },
  };
  mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
    cb(db)
  );
});

describe("GET /artifacts/[id]/related-sessions org scoping", () => {
  it("returns the field for an artifact in the caller's org", async () => {
    const response = await call(DOC_IN_ORG_A);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: RESULT });
    expect(mocks.listRelatedSessions).toHaveBeenCalledWith(
      ORG_A,
      DOC_IN_ORG_A,
      RELATED_SESSIONS_DISPLAY_CAP
    );
  });

  it("does not resolve an artifact belonging to another org", async () => {
    const response = await call(DOC_IN_ORG_B);

    expect(response.status).toBe(404);
    // The provenance read must never run for a subject the caller cannot see:
    // a 404 assembled AFTER reading another org's edges is still a disclosure.
    expect(mocks.listRelatedSessions).not.toHaveBeenCalled();
  });

  it("scopes the read to the caller's org, never the requested artifact's", async () => {
    await call(DOC_IN_ORG_A);

    const [organizationId] = mocks.listRelatedSessions.mock.calls[0];
    expect(organizationId).toBe(ORG_A);
    expect(organizationId).not.toBe(ORG_B);
  });
});

/**
 * The path segment is untrusted (whitlockk review). `Artifact.id` is `@db.Uuid`, so
 * an unvalidated segment reaches the driver and raises P2023 — which the route's
 * catch reported as a 500, turning a caller's typo into a server fault.
 *
 * The STATUS CODE is the assertion, not "an error happened": a 500 and a 400 are
 * both errors, and only the code says whose fault the route thinks it was.
 */
describe("GET /artifacts/[id]/related-sessions untrusted identifier", () => {
  it("answers a malformed id as a caller error, before any query runs", async () => {
    const response = await call(MALFORMED_ID);

    expect(response.status).toBe(400);
    // Not merely "not 500" — pin the boundary that produced it. Validation that
    // happens before the first query is what keeps a malformed segment away
    // from the UUID column entirely.
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.listRelatedSessions).not.toHaveBeenCalled();
  });

  it("answers an unknown but well-formed identifier as a miss, not a fault", async () => {
    // 14 chars, so it clears the legacy-nanoid slug shape and validation alone
    // would NOT have stopped it. It is the resolver that keeps it off the UUID
    // column — which is why validating without resolving is still a 500.
    const response = await call(UNKNOWN_NANOID_SLUG);

    expect(response.status).toBe(404);
    expect(mocks.listRelatedSessions).not.toHaveBeenCalled();
  });

  it("resolves a slug to the artifact it names, so the misses above are the INPUT", async () => {
    const response = await call("PRD-42");

    expect(response.status).toBe(200);
    expect(mocks.listRelatedSessions).toHaveBeenCalledWith(
      ORG_A,
      DOC_IN_ORG_A,
      RELATED_SESSIONS_DISPLAY_CAP
    );
  });

  it("does not resolve another org's slug", async () => {
    const response = await call("PRD-43");

    expect(response.status).toBe(404);
    expect(mocks.listRelatedSessions).not.toHaveBeenCalled();
  });
});

describe("GET /artifacts/[id]/related-sessions non-Session exception", () => {
  it("refuses a Session artifact without reading its provenance", async () => {
    const response = await call(SESSION_IN_ORG_A);

    expect(response.status).toBe(400);
    expect(mocks.listRelatedSessions).not.toHaveBeenCalled();
  });

  it("serves the same org's non-Session artifact, so the refusal is the TYPE", async () => {
    const response = await call(DOC_IN_ORG_A);

    expect(response.status).toBe(200);
  });
});

describe("POST /artifacts/related-sessions batch read", () => {
  it("keeps the read-only POST route on read-scoped API keys", () => {
    expect(mocks.withAnyAuthOptions).toContainEqual({
      requiredScopes: ["read"],
    });
  });

  it("dedupes, org-gates, and omits unsupported or inaccessible artifacts", async () => {
    const response = await callBatch({
      artifactIds: [DOC_IN_ORG_A, DOC_IN_ORG_A, DOC_IN_ORG_B, SESSION_IN_ORG_A],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { results: { [DOC_IN_ORG_A]: RESULT } },
    });
    expect(mocks.listRelatedSessionsForArtifacts).toHaveBeenCalledWith(
      ORG_A,
      [DOC_IN_ORG_A],
      RELATED_SESSIONS_DISPLAY_CAP,
      {}
    );
  });

  it("applies a selected-session scope before the display cap and echoes the applied scope", async () => {
    const response = await callBatch({
      artifactIds: [DOC_IN_ORG_A, DOC_IN_ORG_B],
      sessionArtifactIds: [SESSION_IN_ORG_A, SESSION_IN_ORG_A],
    });

    expect(response.status).toBe(200);
    expect(mocks.listRelatedSessionsForArtifacts).toHaveBeenCalledWith(
      ORG_A,
      [DOC_IN_ORG_A],
      RELATED_SESSIONS_DISPLAY_CAP,
      { sessionArtifactIds: [SESSION_IN_ORG_A] }
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { appliedSessionArtifactIds: [SESSION_IN_ORG_A] },
    });
  });

  it("trims session search and reports the scope actually applied", async () => {
    const response = await callBatch({
      artifactIds: [DOC_IN_ORG_A],
      sessionSearch: "  design  ",
    });

    expect(response.status).toBe(200);
    expect(mocks.listRelatedSessionsForArtifacts).toHaveBeenCalledWith(
      ORG_A,
      [DOC_IN_ORG_A],
      RELATED_SESSIONS_DISPLAY_CAP,
      { sessionSearch: "design" }
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { appliedSessionSearch: "design" },
    });
  });

  it.each([
    { sessionArtifactIds: [] },
    { sessionArtifactIds: ["SES-1"] },
    { sessionSearch: "  " },
    { sessionSearch: "a".repeat(257) },
  ])("rejects malformed session scope before any query: %j", async (scope) => {
    const response = await callBatch({ artifactIds: [DOC_IN_ORG_A], ...scope });
    expect(response.status).toBe(400);
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.listRelatedSessionsForArtifacts).not.toHaveBeenCalled();
  });

  it("rejects an empty request without reading artifacts", async () => {
    const response = await callBatch({ artifactIds: [] });

    expect(response.status).toBe(400);
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.listRelatedSessionsForArtifacts).not.toHaveBeenCalled();
  });

  it("rejects non-UUID artifact ids before any query", async () => {
    const response = await callBatch({ artifactIds: ["PRD-42"] });

    expect(response.status).toBe(400);
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.listRelatedSessionsForArtifacts).not.toHaveBeenCalled();
  });

  it("dedupes before enforcing the page artifact cap", async () => {
    const response = await callBatch({
      artifactIds: Array.from(
        { length: RELATED_SESSIONS_PAGE_ARTIFACT_CAP + 1 },
        () => DOC_IN_ORG_A
      ),
    });

    expect(response.status).toBe(200);
    expect(mocks.listRelatedSessionsForArtifacts).toHaveBeenCalledWith(
      ORG_A,
      [DOC_IN_ORG_A],
      RELATED_SESSIONS_DISPLAY_CAP,
      {}
    );
  });

  it("rejects more than the page artifact cap after dedupe", async () => {
    const artifactIds = Array.from(
      { length: RELATED_SESSIONS_PAGE_ARTIFACT_CAP + 1 },
      (_, index) => uuidForIndex(index)
    );

    const response = await callBatch({ artifactIds });

    expect(response.status).toBe(400);
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.listRelatedSessionsForArtifacts).not.toHaveBeenCalled();
  });
});

/** Not a UUID, not a typed slug, not 14 chars — rejected by shape alone. */
const MALFORMED_ID = "not-a-uuid";

/**
 * Exactly 14 characters, so it PASSES the legacy-nanoid slug shape and reaches
 * the resolver. It exists to prove the fix is the resolver as well as the
 * validator: shape-checking alone would have handed this to the UUID column.
 */
const UNKNOWN_NANOID_SLUG = "abcdefghijklmn";

const UUID_COLUMN_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ArtifactWhere = {
  id?: { in: string[] } | string;
  organizationId?: string;
  slug?: { in: string[] };
  type?: string;
};

type ArtifactRow = (typeof ARTIFACTS)[number];

/**
 * Prisma's own semantics for a `@db.Uuid` column: a malformed value is rejected
 * at the driver (P2023), it is NOT a quiet miss.
 *
 * Modelling that is what gives the regressions above the power to fail. A fake
 * that returned null for a malformed id would let the unvalidated route answer
 * a tidy 404 and the 500 this suite exists to pin would be invisible here.
 */
function readUuidColumn(value: string): string {
  if (!UUID_COLUMN_SHAPE.test(value)) {
    throw new Error(
      `Inconsistent column data: Malformed UUID (P2023): ${value}`
    );
  }
  return value;
}

/** Prisma semantics: an absent `where` key constrains nothing. */
function matchesArtifact(artifact: ArtifactRow, where: ArtifactWhere): boolean {
  if (typeof where.id === "string" && artifact.id !== where.id) {
    return false;
  }
  if (typeof where.id === "object" && !where.id.in.includes(artifact.id)) {
    return false;
  }
  if (
    where.organizationId !== undefined &&
    artifact.organizationId !== where.organizationId
  ) {
    return false;
  }
  if (where.slug !== undefined && !where.slug.in.includes(artifact.slug)) {
    return false;
  }
  return where.type === undefined || artifact.type === where.type;
}

function findArtifact(where: ArtifactWhere): ArtifactRow | null {
  if (typeof where.id === "string") {
    readUuidColumn(where.id);
  }
  return ARTIFACTS.find((artifact) => matchesArtifact(artifact, where)) ?? null;
}

function uuidForIndex(index: number): string {
  return `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
}
