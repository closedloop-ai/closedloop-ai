/**
 * ISS-9485 — the single-row PATCH contract for `PATCH /agent-sessions/[id]`,
 * walked against real Postgres through the REAL route handler. Per writable
 * field: the write is echoed back from the store. Per row field the type does
 * not let a user write: refused with `unsupported_field`, naming exactly that
 * key, and the row is left untouched — refused BEFORE the id is even looked
 * up, so a foreign-org id and a nonexistent id answer identically. Self-skips
 * without `DATABASE_URL`.
 */

import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_ROW_FIELD_EDIT,
  AgentSessionPatchField,
  ArtifactRowFieldMutationErrorCode,
} from "@repo/api/src/types/artifact-row-field-edit";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { refusedRowFields } from "@/__tests__/utils/row-field-edit";
import {
  seedTwoOrgFixture,
  type TwoOrgFixture,
} from "@/__tests__/utils/two-org-fixture";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;
const scheduled = vi.hoisted((): Promise<unknown>[] => []);

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));
// The rename's capability read is a Clerk round trip; the owner arm is what
// this suite drives, so every caller resolves to not-admin.
vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: () => Promise.resolve({ isAdmin: false }),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    scheduled.push(work);
  },
}));

import { PATCH as patchSession } from "@/app/agent-sessions/[id]/route";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(async () => {
  await Promise.allSettled(scheduled.splice(0));
  await committedOrganizations.cleanup();
});

type Envelope = {
  success: boolean;
  data?: Record<string, unknown>;
  code?: string;
  details?: {
    unsupportedFields?: string[];
    writableFields?: string[];
    useFields?: Record<string, string>;
  };
};

/** The body-key values {@link AGENT_SESSION_ROW_FIELD_EDIT} maps a field to. */
const WRITABLE_FIELD_VALUES = new Set<string>(
  Object.values(AgentSessionPatchField)
);

async function seed(): Promise<TwoOrgFixture> {
  const fixture = await seedTwoOrgFixture();
  committedOrganizations.track(fixture.orgA.organizationId);
  committedOrganizations.track(fixture.orgB.organizationId);
  mockAuthContext = createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: fixture.orgA.userId,
      organizationId: fixture.orgA.organizationId,
    },
  });
  return fixture;
}

async function sendSession(id: string, body: unknown) {
  const response = await patchSession(
    createMockRequest({ method: "PATCH", body }),
    createMockRouteContext({ id })
  );
  return { status: response.status, json: (await response.json()) as Envelope };
}

/**
 * Sends a raw JSON body verbatim. `createMockRequest` treats a falsy `body`
 * option (`null`) as "no body", which would test the empty-body path instead
 * of the non-record one — this bypasses that and puts `null`/`[]` on the wire.
 */
async function sendSessionRawBody(id: string, rawBody: string) {
  const request = new NextRequest("http://localhost:3002/api/test", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  const response = await patchSession(request, createMockRouteContext({ id }));
  return { status: response.status, json: (await response.json()) as Envelope };
}

function readSessionRow(sessionId: string) {
  return withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        status: true,
        priority: true,
        projectId: true,
        assigneeId: true,
        session: {
          select: { nameOverride: true, harness: true },
        },
      },
    })
  );
}

describeIfDb("PATCH /agent-sessions/[id] row fields (ISS-9485)", () => {
  it("echoes each writable field from the store", async () => {
    const { orgA } = await seed();
    const id = orgA.sessionArtifactId;
    // Not the uploader, which ingest already made the assignee: the owner case
    // has to move the Owner to be evidence of the write.
    const nextOwner = await createTestUser(orgA.organizationId);

    const cases: [
      Record<string, unknown>,
      (session: Record<string, unknown>) => unknown,
      unknown,
    ][] = [
      [
        { [AgentSessionPatchField.Name]: "Ledger rewrite" },
        (s) => s.name,
        "Ledger rewrite",
      ],
      [
        { [AgentSessionPatchField.Status]: SESSION_STATUS.INACTIVE },
        (s) => s.status,
        SESSION_STATUS.INACTIVE,
      ],
      [
        { [AgentSessionPatchField.Priority]: Priority.High },
        (s) => s.priority,
        Priority.High,
      ],
      [{ [AgentSessionPatchField.ProjectId]: null }, (s) => s.project, null],
      [
        { [AgentSessionPatchField.ProjectId]: orgA.projectId },
        (s) => (s.project as { id: string }).id,
        orgA.projectId,
      ],
      [
        { [AgentSessionPatchField.OwnerUserId]: nextOwner.id },
        (s) => (s.assignee as { id: string }).id,
        nextOwner.id,
      ],
    ];
    for (const [body, pick, expected] of cases) {
      const { status, json } = await sendSession(id, body);
      expect(status, JSON.stringify(body)).toBe(200);
      expect(pick(json.data?.session as Record<string, unknown>)).toEqual(
        expected
      );
    }

    const stored = await readSessionRow(id);
    expect(stored).toMatchObject({
      status: SESSION_STATUS.INACTIVE,
      priority: Priority.High,
      projectId: orgA.projectId,
      // ISS-12251 D-1: `ownerUserId` writes the artifact assignee.
      assigneeId: nextOwner.id,
      session: { nameOverride: "Ledger rewrite" },
    });
  });

  it("refuses every non-writable row field with unsupported_field, names useFields for a read-side alias, and writes nothing", async () => {
    const { orgA } = await seed();
    const id = orgA.sessionArtifactId;
    const before = await readSessionRow(id);

    for (const key of refusedRowFields(AGENT_SESSION_ROW_FIELD_EDIT)) {
      const { status, json } = await sendSession(id, {
        [AgentSessionPatchField.Status]: SESSION_STATUS.ERROR,
        [key]: "x",
      });
      expect(status, key).toBe(400);
      expect(json.code, key).toBe(
        ArtifactRowFieldMutationErrorCode.UnsupportedField
      );
      expect(json.details?.unsupportedFields, key).toEqual([key]);

      const registryValue =
        AGENT_SESSION_ROW_FIELD_EDIT[
          key as keyof typeof AGENT_SESSION_ROW_FIELD_EDIT
        ];
      if (WRITABLE_FIELD_VALUES.has(registryValue)) {
        // `project` -> `projectId`, `assignee` -> `ownerUserId`: the two
        // read-name aliases that name a writable field the caller should send
        // instead.
        expect(json.details?.useFields, key).toEqual({ [key]: registryValue });
      } else {
        expect(json.details?.useFields, key).toBeUndefined();
      }
    }

    expect(await readSessionRow(id)).toEqual(before);
  });

  it("accepts a valid field alongside an unknown non-row key (version skew) and writes only the valid field", async () => {
    const { orgA } = await seed();
    const id = orgA.sessionArtifactId;

    const { status, json } = await sendSession(id, {
      [AgentSessionPatchField.Status]: SESSION_STATUS.ERROR,
      futureField: "unknown-to-this-build",
    });

    expect(status).toBe(200);
    const session = json.data?.session as Record<string, unknown>;
    expect(session.status).toBe(SESSION_STATUS.ERROR);
    expect((await readSessionRow(id)).status).toBe(SESSION_STATUS.ERROR);
  });

  it("answers another org's session with 404 artifacts_not_found and leaves it untouched", async () => {
    const { orgB } = await seed();
    const before = await readSessionRow(orgB.sessionArtifactId);

    const { status, json } = await sendSession(orgB.sessionArtifactId, {
      [AgentSessionPatchField.Status]: SESSION_STATUS.ERROR,
    });

    expect(status).toBe(404);
    expect(json.code).toBe(ArtifactRowFieldMutationErrorCode.ArtifactsNotFound);
    expect(await readSessionRow(orgB.sessionArtifactId)).toEqual(before);
  });

  it("refuses an unsupported field before checking whether the id exists, for a foreign-org id and a nonexistent id alike", async () => {
    const { orgB } = await seed();

    for (const id of [orgB.sessionArtifactId, randomUUID()]) {
      const { status, json } = await sendSession(id, { cost: "x" });
      expect(status, id).toBe(400);
      expect(json.code, id).toBe(
        ArtifactRowFieldMutationErrorCode.UnsupportedField
      );
      expect(json.details?.unsupportedFields, id).toEqual(["cost"]);
    }
  });

  it("refuses a non-record body (null or an array) with 400 and no structured code", async () => {
    const { orgA } = await seed();
    const id = orgA.sessionArtifactId;

    for (const rawBody of ["null", "[]"]) {
      const { status, json } = await sendSessionRawBody(id, rawBody);
      expect(status, rawBody).toBe(400);
      expect(json.code, rawBody).toBeUndefined();
    }
  });
});
