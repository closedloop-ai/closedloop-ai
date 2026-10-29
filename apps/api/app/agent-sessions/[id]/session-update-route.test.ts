import {
  AgentSessionFieldMutationErrorCode,
  staleSessionFieldsConflict,
} from "@repo/api/src/types/agent-session-field-mutation";
import { AGENT_SESSION_NAME_MAX_CHARS } from "@repo/api/src/types/agent-session-rename";
import {
  ArtifactPriorityMutationErrorCode,
  stalePriorityConflict,
} from "@repo/api/src/types/artifact-priority-mutation";
import {
  AGENT_SESSION_ROW_FIELD_EDIT,
  AgentSessionPatchField,
  ArtifactRowFieldMutationErrorCode,
} from "@repo/api/src/types/artifact-row-field-edit";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import { Result, Status } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType } from "@repo/database";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refusedRowFields } from "@/__tests__/utils/row-field-edit";
import { OrgAdminDenialReason } from "@/lib/auth/org-admin-denial";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const OTHER_SESSION_ID = "55555555-5555-4555-8555-555555555552";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const CALLER_ID = "22222222-2222-4222-8222-222222222221";
const CLERK_ORG_ID = "org_2fXk8733";
const CLERK_USER_ID = "user_2fXk8733";
// Built via char code so no literal NUL byte lives in this source.
const NUL = String.fromCharCode(0);

const mocks = vi.hoisted(() => ({
  user: {
    id: "22222222-2222-4222-8222-222222222221",
    organizationId: "11111111-1111-4111-8111-111111111111",
  },
  updateSession: vi.fn(),
  rename: vi.fn(),
  getOrgAdminStatus: vi.fn(),
  updatePriority: vi.fn(),
  captureBatchPriorityChange: vi.fn(),
  captureArtifactFieldEditAnalytics: vi.fn(),
  dispatchSingleArtifactMutationAudits: vi.fn(),
  updatePriorityAfterCommit: vi.fn(),
}));

import { MOCK_TRANSACTION_CLIENT } from "@/__tests__/utils/mock-with-db";

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchPriorityChange: mocks.captureBatchPriorityChange,
}));
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: mocks.captureArtifactFieldEditAnalytics,
}));
vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: {
    updatePriorityAfterCommit: mocks.updatePriorityAfterCommit,
  },
}));
vi.mock("@/app/audit/single-artifact-mutation-audit", () => ({
  dispatchSingleArtifactMutationAudits:
    mocks.dispatchSingleArtifactMutationAudits,
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        {
          authMethod: "session",
          user: mocks.user,
          clerkOrgId: "org_2fXk8733",
          clerkUserId: "user_2fXk8733",
        },
        request,
        context.params
      ),
}));

vi.mock("../service", () => ({
  agentSessionsService: { findSessionDetail: vi.fn() },
}));

vi.mock("../session-write-service", () => ({
  sessionWriteService: { updateSession: mocks.updateSession },
}));

vi.mock("../session-rename-service", () => ({
  sessionRenameService: { rename: mocks.rename },
}));

vi.mock("@/app/documents/artifact-bulk-priority-service", () => ({
  artifactBulkPriorityService: { updatePriority: mocks.updatePriority },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

import { PATCH } from "./route";

function request(body: unknown) {
  return new NextRequest("https://api.example.test/agent-sessions/x", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateSession.mockResolvedValue({
    ok: true,
    value: { session: { id: SESSION_ID } },
  });
  mocks.rename.mockResolvedValue(Result.ok(undefined));
  mocks.updatePriority.mockResolvedValue(
    Result.ok({ changed: true, beforePriority: null })
  );
  // `reason` is the canonical `OrgAdminDenialReason`, imported rather than
  // respelled (ISS-8733 review) — nothing here asserts on it; it only keeps the
  // double the shape production actually emits.
  //
  // `isAdmin` is deliberately NOT derived from `OrgAdminRole`. That const is the
  // policy under test, and a fixture built from it could not detect a mutation
  // of it; its role-to-verdict mapping is pinned against independent literals in
  // `packages/api/src/types/__tests__/org-admin-role.test.ts`.
  mocks.getOrgAdminStatus.mockResolvedValue({
    isAdmin: false,
    reason: OrgAdminDenialReason.NotAdmin,
  });
});

describe("PATCH /agent-sessions/[id] (ISS-8648)", () => {
  it("passes the ROUTE id under test, not a fixed one, plus the caller's org", async () => {
    await PATCH(request({ ownerUserId: OWNER_ID }), context(SESSION_ID));
    expect(mocks.updateSession).toHaveBeenLastCalledWith(
      {
        organizationId: ORG_ID,
        actor: { userId: CALLER_ID, authMethod: "session" },
        sessionId: SESSION_ID,
        ownerUserId: OWNER_ID,
      },
      undefined
    );

    await PATCH(request({ ownerUserId: OWNER_ID }), context(OTHER_SESSION_ID));
    expect(mocks.updateSession).toHaveBeenLastCalledWith(
      {
        organizationId: ORG_ID,
        actor: { userId: CALLER_ID, authMethod: "session" },
        sessionId: OTHER_SESSION_ID,
        ownerUserId: OWNER_ID,
      },
      undefined
    );
  });

  it("forwards an explicit null so the tri-state reaches the service", async () => {
    await PATCH(request({ projectId: null }), context(SESSION_ID));

    const [input] = mocks.updateSession.mock.calls[0];
    expect(input.projectId).toBeNull();
    expect("ownerUserId" in input).toBe(false);
  });

  it("rejects a non-lifecycle status but accepts a lifecycle one", async () => {
    // "stale" is a plain literal now — ISS-10364 retired the display-only
    // member — but it is still not a valid SessionStatus to WRITE, same as
    // any other unrecognized spelling.
    const refused = await PATCH(
      request({ status: "stale" }),
      context(SESSION_ID)
    );
    expect(refused.status).toBe(400);
    expect(mocks.updateSession).not.toHaveBeenCalled();

    const accepted = await PATCH(
      request({ status: SESSION_STATUS.INACTIVE }),
      context(SESSION_ID)
    );
    expect(accepted.status).toBe(200);
    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: SESSION_STATUS.INACTIVE }),
      undefined
    );
  });

  it("maps a service NotFound to 404 and a BadRequest to 400", async () => {
    mocks.updateSession.mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });
    const missing = await PATCH(
      request({ status: SESSION_STATUS.ACTIVE }),
      context(SESSION_ID)
    );
    expect(missing.status).toBe(404);

    mocks.updateSession.mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });
    const bad = await PATCH(
      request({ status: SESSION_STATUS.ACTIVE }),
      context(SESSION_ID)
    );
    expect(bad.status).toBe(400);
  });

  it("rejects a malformed id payload before the service is reached", async () => {
    const response = await PATCH(
      request({ projectId: "not-a-uuid" }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(400);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
});

/**
 * ISS-8733 reconciled the two PATCH handlers that landed on this route. These
 * are MAPPING tests: both services are mocked, so per `apps/api/AGENTS.md`
 * (ISS-6748) they prove only that the route sends each field to the right write
 * and turns a `Result` into the right status. That a non-owner is refused, an
 * admin is not, and a cross-org id is not confirmed is decidable only against a
 * real database, and is proven in `../session-rename.integration.test.ts`.
 *
 * What these add is the half that suite cannot see: which service a field
 * reaches, and whether the 403/404 ternary is the right way round.
 */
describe("PATCH /agent-sessions/[id] (ISS-8733 reconciliation)", () => {
  it("sends `name` to the rename write and never to the org-scoped update", async () => {
    const response = await PATCH(
      request({ name: "  Ledger rewrite  " }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(200);
    // The whole point of the reconciliation: `name` no longer reaches
    // `updateSession`, which would put it on `artifacts.name` and have the next
    // desktop sync erase it.
    expect(mocks.rename).toHaveBeenCalledWith(
      {
        id: SESSION_ID,
        organizationId: ORG_ID,
        actorUserId: CALLER_ID,
        authMethod: "session",
        actorIsOrgAdmin: false,
        name: "Ledger rewrite",
      },
      undefined
    );
    const [input, recordWrite] = mocks.updateSession.mock.calls[0];
    expect("name" in input).toBe(false);
    // ISS-12552: the rename recorded its own receipt; the re-read after it
    // records none.
    expect(recordWrite).toBeUndefined();
  });

  it.each([true, false])(
    "forwards the caller's resolved admin standing (%s) rather than a fixed one",
    async (resolved) => {
      mocks.getOrgAdminStatus.mockResolvedValue({
        isAdmin: resolved,
        reason: resolved ? "admin" : OrgAdminDenialReason.NotAdmin,
      });

      await PATCH(request({ name: "Renamed" }), context(SESSION_ID));

      // Pins the identity the gate is asked about, not just that it was asked:
      // resolving admin standing for the wrong org would widen the write for a
      // caller who is an admin somewhere else.
      expect(mocks.getOrgAdminStatus).toHaveBeenCalledWith(
        CLERK_ORG_ID,
        CLERK_USER_ID
      );
      expect(mocks.rename).toHaveBeenCalledWith(
        expect.objectContaining({ actorIsOrgAdmin: resolved }),
        undefined
      );
    }
  );

  it("fails CLOSED to owner-only when the org-role provider is unreachable", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: OrgAdminDenialReason.ProviderError,
    });

    await PATCH(request({ name: "Renamed" }), context(SESSION_ID));

    // A Clerk outage must not widen the write. Distinct from `not_admin`: the
    // gate could not DECIDE, and an undecidable admin check has to leave the
    // stricter pre-ISS-8733 owner-only rule in force.
    expect(mocks.rename).toHaveBeenCalledWith(
      expect.objectContaining({ actorIsOrgAdmin: false }),
      undefined
    );
  });

  it("does not pay the org-admin round trip for a grouping-only write", async () => {
    await PATCH(
      request({ status: SESSION_STATUS.INACTIVE }),
      context(SESSION_ID)
    );

    // Grouping fields are org-scoped, so admin standing is irrelevant to them.
    expect(mocks.getOrgAdminStatus).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("maps a rename Forbidden to 403, not to 404", async () => {
    mocks.rename.mockResolvedValue(Result.err(Status.Forbidden));

    const response = await PATCH(
      request({ name: "Not mine" }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(403);
    // Refused before the readback, so a rejected rename cannot 200 on the
    // response the grouping path shapes.
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("maps a rename NotFound to 404, not to 403", async () => {
    mocks.rename.mockResolvedValue(Result.err(Status.NotFound));

    const response = await PATCH(
      request({ name: "Not here" }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(404);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("refuses a body that pairs a rename with a grouping field before either write runs", async () => {
    const response = await PATCH(
      request({ name: "Renamed", status: SESSION_STATUS.INACTIVE }),
      context(SESSION_ID)
    );

    // The two halves are separate writes under separate authorization rules and
    // cannot commit together, so applying one and refusing the other would be
    // the endpoint lying about what it stored.
    expect(response.status).toBe(400);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("bounds `name` by the ceiling the desktop sync boundary would otherwise truncate at", async () => {
    const atCeiling = "n".repeat(AGENT_SESSION_NAME_MAX_CHARS);
    const accepted = await PATCH(
      request({ name: atCeiling }),
      context(SESSION_ID)
    );
    expect(accepted.status).toBe(200);

    const overCeiling = "n".repeat(AGENT_SESSION_NAME_MAX_CHARS + 1);
    const refused = await PATCH(
      request({ name: overCeiling }),
      context(SESSION_ID)
    );
    expect(refused.status).toBe(400);
    expect(mocks.rename).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty name at the boundary without reaching the rename write", async () => {
    const response = await PATCH(request({ name: "   " }), context(SESSION_ID));

    expect(response.status).toBe(400);
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  // ISS-8717 review (tamsinb): a NUL is legal JSON and legal to `z.string()`,
  // and illegal in a Postgres `text` column. Unsanitized it cleared the schema
  // and died at the write as a 500 — an input error reported as a server fault.
  it("strips an unstorable NUL from the name instead of handing it to the write", async () => {
    const response = await PATCH(
      request({ name: `a${NUL}b` }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(200);
    expect(mocks.rename).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ab" }),
      undefined
    );
  });

  it("rejects a name left empty by sanitization rather than storing a blank one", async () => {
    const response = await PATCH(
      request({ name: `${NUL}${NUL}` }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(400);
    expect(mocks.rename).not.toHaveBeenCalled();
  });
});

describe("PATCH /agent-sessions/[id] priority (ISS-10332)", () => {
  it("ISS-10681 AC-001 writes and audits Session priority through the shared host, then re-reads", async () => {
    const response = await PATCH(
      request({ priority: Priority.High }),
      context(OTHER_SESSION_ID)
    );

    expect(response.status).toBe(200);
    expect(mocks.updatePriority).toHaveBeenCalledWith({
      artifactId: OTHER_SESSION_ID,
      artifactType: ArtifactType.SESSION,
      organizationId: ORG_ID,
      priority: Priority.High,
    });
    // The response row comes from the no-field arm of the grouping write, so it
    // must be asked for with NO grouping field — and no priority key either.
    // ISS-12552: that re-read records no receipt of its own.
    expect(mocks.updateSession).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        actor: { userId: CALLER_ID, authMethod: "session" },
        sessionId: OTHER_SESSION_ID,
      },
      undefined
    );
    expect(mocks.dispatchSingleArtifactMutationAudits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: CALLER_ID,
      changes: [
        {
          action: AuditAction.DocumentPriorityChanged,
          objectId: OTHER_SESSION_ID,
          before: null,
          after: Priority.High,
        },
      ],
    });
  });

  it("keeps the tri-state: null clears, and an omitted key never reaches the writer", async () => {
    await PATCH(request({ priority: null }), context(SESSION_ID));
    expect(mocks.updatePriority.mock.calls[0][0].priority).toBeNull();

    mocks.updatePriority.mockClear();
    await PATCH(request({ ownerUserId: OWNER_ID }), context(SESSION_ID));
    expect(mocks.updatePriority).not.toHaveBeenCalled();
  });

  it("forwards expectedPriority only when sent, keeping a null assertion distinct from no guard", async () => {
    await PATCH(request({ priority: Priority.Low }), context(SESSION_ID));
    expect("expectedPriority" in mocks.updatePriority.mock.calls[0][0]).toBe(
      false
    );

    await PATCH(
      request({ priority: Priority.Low, expectedPriority: null }),
      context(SESSION_ID)
    );
    expect(mocks.updatePriority.mock.calls[1][0].expectedPriority).toBeNull();
  });

  it("maps a stale expectation to 409 with the shared code and details, and skips the re-read", async () => {
    const stalePriorities = [
      {
        documentId: SESSION_ID,
        currentPriority: Priority.Urgent,
        expectedPriority: Priority.Low,
      },
    ];
    mocks.updatePriority.mockResolvedValue(
      Result.err(stalePriorityConflict(stalePriorities))
    );

    const response = await PATCH(
      request({ priority: Priority.High, expectedPriority: Priority.Low }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: ArtifactPriorityMutationErrorCode.StalePriority,
      details: { stalePriorities },
    });
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.dispatchSingleArtifactMutationAudits).not.toHaveBeenCalled();
  });

  it("maps the writer's NotFound to 404 with the shared code and details", async () => {
    const missingDocuments = [{ documentId: SESSION_ID }];
    mocks.updatePriority.mockResolvedValue(
      Result.err({
        status: Status.NotFound,
        code: ArtifactPriorityMutationErrorCode.ArtifactsNotFound,
        message: "not found",
        details: { missingDocuments },
      })
    );

    const response = await PATCH(
      request({ priority: Priority.High }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: ArtifactPriorityMutationErrorCode.ArtifactsNotFound,
      details: { missingDocuments },
    });
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("records the committed transition in the activity feed, and nothing for a no-op or a refusal", async () => {
    mocks.updatePriority.mockResolvedValue(
      Result.ok({ changed: true, beforePriority: Priority.Low })
    );
    await PATCH(request({ priority: null }), context(SESSION_ID));

    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledTimes(1);
    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledWith({
      tx: MOCK_TRANSACTION_CLIENT,
      organizationId: ORG_ID,
      actor: { userId: mocks.user.id, authMethod: "session" },
      changes: [{ artifactId: SESSION_ID, before: Priority.Low, after: null }],
      provenance: undefined,
      stage: "single_update",
    });

    mocks.captureBatchPriorityChange.mockClear();
    mocks.updatePriority.mockResolvedValue(
      Result.ok({ changed: false, beforePriority: Priority.High })
    );
    await PATCH(request({ priority: Priority.High }), context(SESSION_ID));
    mocks.updatePriority.mockResolvedValue(
      Result.err(stalePriorityConflict([]))
    );
    await PATCH(request({ priority: Priority.High }), context(SESSION_ID));

    expect(mocks.captureBatchPriorityChange).not.toHaveBeenCalled();
  });

  it("refuses priority mixed with a rename or a grouping field, and a guard with nothing to guard, before any write", async () => {
    for (const body of [
      { priority: Priority.High, name: "renamed" },
      { priority: Priority.High, status: SESSION_STATUS.ACTIVE },
      { priority: null, projectId: null },
      { expectedPriority: Priority.Low },
      { expectedPriority: null, ownerUserId: OWNER_ID },
    ]) {
      const response = await PATCH(request(body), context(SESSION_ID));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.updatePriority).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("rejects an off-vocabulary priority at the boundary", async () => {
    const response = await PATCH(
      request({ priority: "CRITICAL" }),
      context(SESSION_ID)
    );
    expect(response.status).toBe(400);
    expect(mocks.updatePriority).not.toHaveBeenCalled();
  });

  // PLN-2086 Milestone 2: the analytics event the #7723 review deferred.
  it("attributes the analytics event to the surface the body names, and re-projects the search row", async () => {
    mocks.updatePriority.mockResolvedValue(
      Result.ok({ changed: true, beforePriority: Priority.Low })
    );
    const response = await PATCH(
      request({
        priority: Priority.High,
        surface: ArtifactStatusEditSurface.InlineCell,
      }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(200);
    // `surface` is provenance, never a write: the writer sees the priority
    // alone and the grouping re-read sees no field at all.
    expect(mocks.updatePriority).toHaveBeenCalledWith({
      artifactId: SESSION_ID,
      artifactType: ArtifactType.SESSION,
      organizationId: ORG_ID,
      priority: Priority.High,
    });
    expect(mocks.updateSession).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        actor: { userId: CALLER_ID, authMethod: "session" },
        sessionId: SESSION_ID,
        surface: ArtifactStatusEditSurface.InlineCell,
      },
      undefined
    );
    expect(mocks.captureArtifactFieldEditAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { surface: ArtifactStatusEditSurface.InlineCell },
        before: Priority.Low,
        after: Priority.High,
        artifactCount: 1,
      })
    );
    expect(mocks.updatePriorityAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: SearchEntityType.AgentSession,
        entityId: SESSION_ID,
      }),
      Priority.High
    );
  });

  it("commits an unattributed write for an unrecognized surface, and refuses a bulk one", async () => {
    const degraded = await PATCH(
      request({ priority: Priority.High, surface: "holodeck" }),
      context(SESSION_ID)
    );
    expect(degraded.status).toBe(200);
    expect(mocks.updatePriority).toHaveBeenCalledTimes(1);
    const [capturedAnalytics] =
      mocks.captureArtifactFieldEditAnalytics.mock.calls[0];
    expect(capturedAnalytics).not.toHaveProperty("provenance");

    const refused = await PATCH(
      request({
        priority: Priority.High,
        surface: ArtifactStatusEditSurface.Bulk,
      }),
      context(SESSION_ID)
    );
    expect(refused.status).toBe(400);
    expect(mocks.updatePriority).toHaveBeenCalledTimes(1);
  });

  it("reads a surface beside a grouping write as nothing at all", async () => {
    // Not a grouping field, so not a mixed body; not a priority write, so no
    // event to attribute. The grouping write proceeds without it.
    const response = await PATCH(
      request({
        ownerUserId: OWNER_ID,
        surface: ArtifactStatusEditSurface.InlineCell,
      }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(200);
    expect(mocks.updateSession).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        actor: { userId: CALLER_ID, authMethod: "session" },
        sessionId: SESSION_ID,
        ownerUserId: OWNER_ID,
        surface: ArtifactStatusEditSurface.InlineCell,
      },
      undefined
    );
    expect(mocks.captureArtifactFieldEditAnalytics).not.toHaveBeenCalled();
  });
});

/**
 * ISS-9486 — the per-field guards. MAPPING tests, like the blocks above: that a
 * stale guard refuses and a same-value retry passes is decided against a real
 * database in `../session-field-guards.integration.test.ts`. What this pins is
 * the route half: which write each guard reaches, that an omitted guard never
 * reaches it as `null`, and which bodies are refused before any write.
 */
describe("PATCH /agent-sessions/[id] field guards (ISS-9486)", () => {
  it("forwards each grouping guard to the grouping write only when sent, keeping null distinct from absent", async () => {
    await PATCH(
      request({
        status: SESSION_STATUS.INACTIVE,
        expectedStatus: SESSION_STATUS.ACTIVE,
        projectId: null,
        expectedProjectId: null,
        ownerUserId: OWNER_ID,
        expectedOwnerUserId: CALLER_ID,
      }),
      context(SESSION_ID)
    );
    expect(mocks.updateSession).toHaveBeenLastCalledWith(
      {
        organizationId: ORG_ID,
        actor: { userId: CALLER_ID, authMethod: "session" },
        sessionId: SESSION_ID,
        status: SESSION_STATUS.INACTIVE,
        expectedStatus: SESSION_STATUS.ACTIVE,
        projectId: null,
        expectedProjectId: null,
        ownerUserId: OWNER_ID,
        expectedOwnerUserId: CALLER_ID,
      },
      undefined
    );

    await PATCH(
      request({ status: SESSION_STATUS.INACTIVE }),
      context(SESSION_ID)
    );
    const [unguarded] = mocks.updateSession.mock.calls[1];
    expect(Object.keys(unguarded).sort()).toEqual([
      "actor",
      "organizationId",
      "sessionId",
      "status",
    ]);
  });

  it("sends expectedName with the rename alone, and never to the grouping write", async () => {
    const response = await PATCH(
      request({ name: "Renamed", expectedName: "  collected name  " }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(200);
    expect(mocks.rename).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Renamed",
        // Untrimmed: it has to equal the rendered name byte for byte.
        expectedName: "  collected name  ",
      }),
      undefined
    );
    expect(mocks.updateSession).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        actor: { userId: CALLER_ID, authMethod: "session" },
        sessionId: SESSION_ID,
      },
      undefined
    );

    await PATCH(request({ name: "Renamed" }), context(SESSION_ID));
    expect("expectedName" in mocks.rename.mock.calls[1][0]).toBe(false);
  });

  it("refuses a guard sent without its field, or beside a write it cannot guard, before any write", async () => {
    for (const body of [
      { expectedName: "collected name" },
      { expectedStatus: SESSION_STATUS.ACTIVE },
      { expectedProjectId: null },
      { expectedOwnerUserId: OWNER_ID },
      { name: "Renamed", expectedStatus: SESSION_STATUS.ACTIVE },
      { status: SESSION_STATUS.ACTIVE, expectedName: "collected name" },
      { projectId: null, expectedOwnerUserId: null },
      { priority: Priority.High, expectedStatus: SESSION_STATUS.ACTIVE },
    ]) {
      const response = await PATCH(request(body), context(SESSION_ID));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.updatePriority).not.toHaveBeenCalled();
  });

  it("renders a stale grouping guard as 409 with its scoped code and details", async () => {
    const conflict = staleSessionFieldsConflict({
      projectId: {
        documentId: SESSION_ID,
        currentProjectId: null,
        expectedProjectId: OTHER_SESSION_ID,
      },
    });
    mocks.updateSession.mockResolvedValue({ ok: false, error: conflict });

    const response = await PATCH(
      request({ projectId: null, expectedProjectId: OTHER_SESSION_ID }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: AgentSessionFieldMutationErrorCode.StaleProjectId,
      details: {
        staleProjectIds: [
          {
            documentId: SESSION_ID,
            currentProjectId: null,
            expectedProjectId: OTHER_SESSION_ID,
          },
        ],
      },
    });
  });

  it("renders a stale expectedName as 409 stale_name and skips the re-read", async () => {
    const conflict = staleSessionFieldsConflict({
      name: {
        documentId: SESSION_ID,
        currentName: "collected name",
        expectedName: "older name",
      },
    });
    mocks.rename.mockResolvedValue(Result.err(conflict));

    const response = await PATCH(
      request({ name: "Renamed", expectedName: "older name" }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: AgentSessionFieldMutationErrorCode.StaleName,
      details: {
        staleNames: [
          expect.objectContaining({ currentName: "collected name" }),
        ],
      },
    });
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
});

/**
 * ISS-9485 — the row-field applicability contract. Every field of the list
 * row is either a body key this PATCH writes, or refused by name with
 * `unsupported_field`; it is never silently stripped. A key that is not a row
 * field at all is still stripped, because a newer client may send a field this
 * server predates.
 */
describe("PATCH /agent-sessions/[id] row-field applicability (ISS-9485)", () => {
  const refused = refusedRowFields(AGENT_SESSION_ROW_FIELD_EDIT);

  it("refuses each row field it does not write, by name, before any write", async () => {
    expect(refused).toEqual(
      expect.arrayContaining(["cost", "harness", "model", "startedAt", "tags"])
    );
    for (const key of refused) {
      const response = await PATCH(
        request({ status: SESSION_STATUS.INACTIVE, [key]: "x" }),
        context(SESSION_ID)
      );
      const body = await response.json();
      expect(response.status, key).toBe(400);
      expect(body.code, key).toBe(
        ArtifactRowFieldMutationErrorCode.UnsupportedField
      );
      expect(body.details.unsupportedFields, key).toEqual([key]);
      expect(body.details.writableFields, key).toEqual(
        Object.values(AgentSessionPatchField)
      );
    }
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.updatePriority).not.toHaveBeenCalled();
  });

  it("names the body key for a row field sent under its read name", async () => {
    const response = await PATCH(
      request({ project: { id: OWNER_ID }, assignee: null }),
      context(SESSION_ID)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.details.useFields).toEqual({
      project: AgentSessionPatchField.ProjectId,
      assignee: AgentSessionPatchField.OwnerUserId,
    });
  });

  it("refuses the row field ahead of a priority write that would otherwise be attempted", async () => {
    const response = await PATCH(
      request({
        priority: Priority.High,
        expectedPriority: Priority.Low,
        tokensIn: 5,
      }),
      context(SESSION_ID)
    );

    expect((await response.json()).code).toBe(
      ArtifactRowFieldMutationErrorCode.UnsupportedField
    );
    expect(mocks.updatePriority).not.toHaveBeenCalled();
  });

  it.each([null, [], "status", 5])(
    "answers a non-object body (%j) with the validator's 400 and no code",
    async (body) => {
      const response = await PATCH(request(body), context(SESSION_ID));

      expect(response.status).toBe(400);
      expect((await response.json()).code).toBeUndefined();
      expect(mocks.updateSession).not.toHaveBeenCalled();
    }
  );

  it("refuses the row field ahead of a Zod failure elsewhere in the body", async () => {
    const response = await PATCH(
      request({ status: "stale", cost: "1.00" }),
      context(SESSION_ID)
    );

    expect((await response.json()).code).toBe(
      ArtifactRowFieldMutationErrorCode.UnsupportedField
    );
  });

  it("still strips a key that is not a row field, so a newer client's field is ignored", async () => {
    const response = await PATCH(
      request({ status: SESSION_STATUS.INACTIVE, fieldFromANewerClient: 1 }),
      context(SESSION_ID)
    );

    expect(response.status).toBe(200);
    expect(mocks.updateSession).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        actor: { userId: CALLER_ID, authMethod: "session" },
        sessionId: SESSION_ID,
        status: SESSION_STATUS.INACTIVE,
      },
      undefined
    );
  });

  it("answers a missing session with the artifacts_not_found code on the grouping and rename paths", async () => {
    mocks.updateSession.mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });
    const grouping = await PATCH(
      request({ status: SESSION_STATUS.ACTIVE }),
      context(SESSION_ID)
    );
    expect(grouping.status).toBe(404);
    expect((await grouping.json()).code).toBe(
      ArtifactRowFieldMutationErrorCode.ArtifactsNotFound
    );

    mocks.rename.mockResolvedValue(Result.err(Status.NotFound));
    const rename = await PATCH(request({ name: "Gone" }), context(SESSION_ID));
    expect(rename.status).toBe(404);
    expect((await rename.json()).code).toBe(
      ArtifactRowFieldMutationErrorCode.ArtifactsNotFound
    );
  });

  it("answers a refused rename with field_forbidden naming the field", async () => {
    mocks.rename.mockResolvedValue(Result.err(Status.Forbidden));

    const response = await PATCH(
      request({ name: "Not mine" }),
      context(SESSION_ID)
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe(ArtifactRowFieldMutationErrorCode.FieldForbidden);
    expect(body.details).toEqual({
      forbiddenFields: [AgentSessionPatchField.Name],
    });
  });
});
