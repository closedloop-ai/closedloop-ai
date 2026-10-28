/**
 * Route tests for DELETE /documents/[id] audit-ledger wiring (ISS-10029).
 *
 * The delete is HARD, so its audit entry is the only record that outlives it.
 * These cases drive the REAL route handler through the REAL `documentService`
 * — only the Prisma layer is replaced, via the sanctioned `globalForPrisma`
 * injection (see `packages/database/AGENTS.md`), so `withDb`'s real
 * AsyncLocalStorage decides whether the audit enqueue joined the delete's
 * transaction. The fake models Postgres rollback honestly: writes made inside
 * `$transaction` are staged and discarded if the callback throws.
 *
 * What each case pins is in its own name. The atomicity OUTCOME against a real
 * database is pinned separately, on real Postgres, by
 * `app/documents/document-delete-audit.integration.test.ts`.
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  AuditAction,
  AuditActorType,
  AuditObjectType,
} from "@repo/api/src/types/audit";
import { IssueStatus } from "@repo/api/src/types/document";
import type { PrismaClient } from "@repo/database";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { createTestAuthContext } from "../../../__tests__/utils/auth-helpers";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DOC_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

const mockDeleteDocumentRoom = vi.hoisted(() => vi.fn());
const mockRemoveAfterCommit = vi.hoisted(() => vi.fn());

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (
      handler: (...args: unknown[]) => Promise<Response>,
      _options?: { requiredScopes?: ApiKeyScope[] }
    ) =>
    (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, ctx.params),
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(async (id: string) => id),
    resolveProjectId: vi.fn(async (id: string) => id),
  };
});

vi.mock("@/app/documents/room-utils", () => ({
  createDocumentRoom: vi.fn(),
  deleteDocumentRoom: mockDeleteDocumentRoom,
}));

vi.mock("@/app/search/search-index-service", () => ({
  documentProjection: vi.fn(),
  searchIndexService: { removeAfterCommit: mockRemoveAfterCommit },
}));

import { DELETE } from "./route";

// --- Fake Prisma with honest transaction semantics --------------------------

type ArtifactRow = {
  id: string;
  organizationId: string;
  slug: string | null;
  name: string;
  type: string;
  subtype: string | null;
  status: string;
  projectId: string | null;
};

type OutboxRow = {
  organizationId: string;
  action: string;
  actorType: string;
  actorId: string | null;
  objectType: string;
  objectId: string;
  detail: unknown;
};

type Store = { artifacts: ArtifactRow[]; outbox: OutboxRow[] };

const SEED_ARTIFACT: ArtifactRow = {
  id: DOC_ID,
  organizationId: ORG_ID,
  slug: "ISS-9080",
  name: "Decide whether Google Ads remarketing audiences are worth keeping",
  type: "DOCUMENT",
  subtype: "ISSUE",
  status: IssueStatus.Todo,
  projectId: PROJECT_ID,
};

function seedStore(): Store {
  return { artifacts: [{ ...SEED_ARTIFACT }], outbox: [] };
}

function cloneStore(store: Store): Store {
  return {
    artifacts: store.artifacts.map((row) => ({ ...row })),
    outbox: store.outbox.map((row) => ({ ...row })),
  };
}

/**
 * Prisma's own `where` semantics: an ABSENT key constrains nothing. Modelled
 * deliberately so dropping `organizationId` from the production query widens
 * the fake too, and the cross-org case below can actually go red for it.
 */
function matchesWhere(
  row: ArtifactRow,
  where: { id?: string; organizationId?: string }
): boolean {
  const idOk = where.id === undefined || row.id === where.id;
  const orgOk =
    where.organizationId === undefined ||
    row.organizationId === where.organizationId;
  return idOk && orgOk;
}

function authContextFor(organizationId: string): AuthContext {
  const base = createTestAuthContext();
  return {
    ...base,
    user: { ...base.user, id: USER_ID, organizationId },
  };
}

let committed: Store;
let staged: Store;
let failOutboxCreate: boolean;

/**
 * One-shot fault injector for the read-then-delete race. Fires immediately
 * AFTER a read against the committed store resolves and before the caller can
 * open its transaction, which is exactly the window a concurrent update
 * commits in. Mutating `committed` here means the transaction below clones the
 * UPDATED row, so `delete` returns a different version than the pre-read saw.
 */
let concurrentUpdate: (() => void) | null;

function clientFor(readStore: () => Store, onRead?: () => void) {
  return {
    artifact: {
      findUnique: ({
        where,
      }: {
        where: { id: string; organizationId?: string };
      }) => {
        const row = readStore().artifacts.find((a) => matchesWhere(a, where));
        // Snapshot BEFORE the hook: a real read returns the version that was
        // committed when it ran, so a concurrent update firing after it must
        // not retroactively change what this read saw.
        const snapshot = row ? { ...row } : null;
        onRead?.();
        return Promise.resolve(snapshot);
      },
      delete: ({
        where,
      }: {
        where: { id: string; organizationId?: string };
      }) => {
        const store = readStore();
        const index = store.artifacts.findIndex((a) => matchesWhere(a, where));
        if (index === -1) {
          return Promise.reject(new Error("Record to delete does not exist"));
        }
        const [row] = store.artifacts.splice(index, 1);
        return Promise.resolve(row);
      },
    },
    auditOutbox: {
      create: ({ data }: { data: OutboxRow }) => {
        if (failOutboxCreate) {
          return Promise.reject(new Error("audit_outbox insert failed"));
        }
        readStore().outbox.push({ ...data });
        return Promise.resolve({ id: "outbox-row-1" });
      },
    },
  };
}

const mockPrisma = {
  ...clientFor(
    () => committed,
    () => {
      const fire = concurrentUpdate;
      concurrentUpdate = null;
      fire?.();
    }
  ),
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    staged = cloneStore(committed);
    const result = await fn(clientFor(() => staged));
    // Commit ONLY on a clean return. A throw propagates with `committed`
    // untouched, so every staged write is discarded — the rollback.
    committed = staged;
    return result;
  },
} as unknown as PrismaClient;

beforeEach(() => {
  committed = seedStore();
  staged = seedStore();
  failOutboxCreate = false;
  concurrentUpdate = null;
  mockAuthContext = authContextFor(ORG_ID);
  (globalThis as unknown as { prisma: unknown }).prisma = mockPrisma;
  mockDeleteDocumentRoom.mockReset().mockResolvedValue(undefined);
  mockRemoveAfterCommit.mockReset();
});

afterEach(() => {
  (globalThis as unknown as { prisma: PrismaClient | null }).prisma = null;
});

function callDelete(id = DOC_ID) {
  return DELETE(
    new NextRequest(`http://localhost/documents/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) } as never
  );
}

// --- Cases ------------------------------------------------------------------

describe("DELETE /documents/[id] audit entry", () => {
  it("returns 200 and commits one document.deleted entry describing the destroyed artifact", async () => {
    const response = await callDelete();

    expect(response.status).toBe(200);
    expect(committed.artifacts).toHaveLength(0);
    expect(committed.outbox).toHaveLength(1);
    expect(committed.outbox[0]).toEqual({
      organizationId: ORG_ID,
      action: AuditAction.DocumentDeleted,
      actorType: AuditActorType.User,
      actorId: USER_ID,
      objectType: AuditObjectType.Document,
      objectId: DOC_ID,
      detail: {
        slug: SEED_ARTIFACT.slug,
        title: SEED_ARTIFACT.name,
        subtype: SEED_ARTIFACT.subtype,
        status: SEED_ARTIFACT.status,
        projectId: PROJECT_ID,
      },
    });
  });

  it("records the row the delete destroyed, not the version a concurrent update replaced", async () => {
    const updatedTitle = "Retire Google Ads remarketing audiences";
    concurrentUpdate = () => {
      const row = committed.artifacts[0];
      row.name = updatedTitle;
      row.status = IssueStatus.InReview;
    };

    const response = await callDelete();

    expect(response.status).toBe(200);
    expect(committed.artifacts).toHaveLength(0);
    expect(committed.outbox).toHaveLength(1);
    // The entry is the artifact's only survivor, so it must describe the
    // version that actually disappeared. Built from the pre-read instead, both
    // of these would still carry the seeded title and TODO status.
    expect(committed.outbox[0].detail).toEqual({
      slug: SEED_ARTIFACT.slug,
      title: updatedTitle,
      subtype: SEED_ARTIFACT.subtype,
      status: IssueStatus.InReview,
      projectId: PROJECT_ID,
    });
  });

  it("fails closed: a rejected audit enqueue leaves the artifact undeleted and does not return 200", async () => {
    failOutboxCreate = true;

    const response = await callDelete();

    expect(response.status).not.toBe(200);
    expect(response.status).toBe(500);
    // The load-bearing assertion: the row the delete would have destroyed is
    // still there, so the delete rolled back with its unwritable audit entry.
    expect(committed.artifacts).toHaveLength(1);
    expect(committed.artifacts[0].id).toBe(DOC_ID);
    expect(committed.outbox).toHaveLength(0);
  });

  it("leaves another organization's document undeleted and unaudited", async () => {
    mockAuthContext = authContextFor(OTHER_ORG_ID);

    const response = await callDelete();

    expect(response.status).toBe(200);
    // The artifact belongs to ORG_ID; the caller is in OTHER_ORG_ID, so the
    // org-scoped read finds nothing and the service returns before deleting.
    expect(committed.artifacts).toHaveLength(1);
    expect(committed.outbox).toHaveLength(0);
  });

  it("does not enqueue an entry when the id resolves to no artifact", async () => {
    committed = { artifacts: [], outbox: [] };

    const response = await callDelete();

    expect(response.status).toBe(200);
    expect(committed.outbox).toHaveLength(0);
  });
});
