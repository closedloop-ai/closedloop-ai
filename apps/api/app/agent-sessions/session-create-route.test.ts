import { Harness } from "@repo/api/src/types/agent-component";
import { Status } from "@repo/api/src/types/result";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INDEX_KEY_MAX_BYTES } from "@/lib/index-key-projection";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222221";
const PROJECT_ID = "33333333-3333-4333-8333-333333333331";
const COMPUTE_TARGET_ID = "44444444-4444-4444-8444-444444444441";
// The bound is ours; the sentence after the colon is Zod's and may be
// reworded by a patch bump, so only the field attribution is pinned.
const EXTERNAL_SESSION_ID_ERROR = /^externalSessionId: /;

const mocks = vi.hoisted(() => ({
  user: {
    id: "22222222-2222-4222-8222-222222222221",
    organizationId: "11111111-1111-4111-8111-111111111111",
  },
  createSession: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler({ user: mocks.user }, request, context.params),
}));

vi.mock("./service", () => ({
  agentSessionsService: { findSessions: vi.fn() },
}));

vi.mock("./route-helpers", () => ({
  authorizeAgentSessionTeamScope: vi.fn().mockResolvedValue(true),
}));

vi.mock("./session-write-service", () => ({
  sessionWriteService: { createSession: mocks.createSession },
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://api.example.test/agent-sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const validBody = {
  computeTargetId: COMPUTE_TARGET_ID,
  externalSessionId: "ext-1",
  name: "inline created",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSession.mockResolvedValue({
    ok: true,
    value: { session: { id: "s-1" }, created: true },
  });
});

describe("POST /agent-sessions (ISS-8648)", () => {
  it("threads the caller's org and the parsed body into the service", async () => {
    const response = await POST(
      request({ ...validBody, projectId: PROJECT_ID }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        actorUserId: ACTOR_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        externalSessionId: "ext-1",
        name: "inline created",
        projectId: PROJECT_ID,
      },
      undefined
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { session: { id: "s-1" }, created: true },
    });
  });

  it("rejects a non-lifecycle status but accepts a lifecycle one on the same call", async () => {
    // "waiting" is a plain literal now — ISS-10364 retired the display-only
    // member — but it is still not a valid SessionStatus to WRITE.
    const refused = await POST(request({ ...validBody, status: "waiting" }), {
      params: Promise.resolve({}),
    });
    expect(refused.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();

    const accepted = await POST(
      request({ ...validBody, status: SESSION_STATUS.ERROR }),
      { params: Promise.resolve({}) }
    );
    expect(accepted.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: SESSION_STATUS.ERROR }),
      undefined
    );
  });

  it("rejects the other two retired display-only spellings", async () => {
    for (const status of ["unknown", "stale"]) {
      const response = await POST(request({ ...validBody, status }), {
        params: Promise.resolve({}),
      });
      expect(response.status).toBe(400);
    }
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("accepts an over-long externalSessionId and hands it to the service RAW", async () => {
    // The index-key contract puts the bound at the WRITE, not the wire
    // (`index-key-projection.ts`: "no caller of this module may turn it into a
    // `.max()`"). The desktop ingest's own schema has no upper bound either, so
    // a wire cap here would reject exactly the ids ingest accepts-and-projects
    // and this endpoint could not pre-register those sessions (whitlockk, #6330).
    const longExternalId = `run-${"a".repeat(INDEX_KEY_MAX_BYTES)}`;

    const response = await POST(
      request({ ...validBody, externalSessionId: longExternalId }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    // RAW, not projected: the projection belongs to the service, at the column.
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ externalSessionId: longExternalId }),
      undefined
    );
  });

  it("rejects a non-UUID computeTargetId before it can reach the service", async () => {
    const response = await POST(
      request({ ...validBody, computeTargetId: "not-a-uuid" }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "computeTargetId: Must be a valid UUID",
    });
  });

  it("rejects an empty externalSessionId before it can reach the service", async () => {
    const response = await POST(
      request({ ...validBody, externalSessionId: "" }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(EXTERNAL_SESSION_ID_ERROR);
  });

  it("maps a service BadRequest to 400 rather than a 500", async () => {
    mocks.createSession.mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    const response = await POST(request(validBody), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });
});

// ISS-9073 §5: the create path was the one write on this resource that did not
// sanitize. A NUL is legal JSON and legal to `z.string()`, and illegal in a
// Postgres `text` column, so it cleared the schema and died at the write as a
// 500. Same contract the PATCH route already holds (`session-update-route.test.ts`).
describe("POST /agent-sessions — Postgres text sanitization (ISS-9073)", () => {
  const NUL = String.fromCharCode(0);

  it("strips an unstorable NUL from externalSessionId instead of handing it to the write", async () => {
    const response = await POST(
      request({ ...validBody, externalSessionId: `a${NUL}b` }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ externalSessionId: "ab" }),
      undefined
    );
  });

  it("rejects a name left empty by sanitization rather than storing a blank one", async () => {
    const response = await POST(
      request({ ...validBody, name: `${NUL}${NUL}` }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("hands a NUL-free body to the service unchanged", async () => {
    const response = await POST(
      request({
        ...validBody,
        harness: Harness.Claude,
        repositoryFullName: "o/r",
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        actorUserId: ACTOR_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        externalSessionId: "ext-1",
        name: "inline created",
        harness: Harness.Claude,
        repositoryFullName: "o/r",
      },
      undefined
    );
  });
});
