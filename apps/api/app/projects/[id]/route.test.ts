/**
 * Route tests for PUT /projects/[id] — team-requirement enforcement (ISS-6966).
 *
 * Verifies:
 * - teamIds: [] is rejected before the DB existence check runs
 * - teamIds omitted leaves teams unchanged and succeeds
 * - service-layer Unresolved rejection attaches the org's team roster
 * - slug-based ids get a 404 before body parsing when the slug doesn't resolve
 * - UUID-based ids get a 400 from the team check because body parsing runs
 *   before the findById existence check
 * - ISS-9688: a project status/priority transition reaches the audit ledger,
 *   and a no-op re-save does not
 * - ISS-9688 (#7225 review): the receipt is built from the transactionally
 *   captured before/after pair, and is dispatched before the custom-field step
 *   that can 400 an already-committed update
 * - ISS-9441: an explicit `priority: null` clears; an omitted key does not; a
 *   non-member value is refused; a clear outside the caller's org 404s; and the
 *   clear reaches the audit ledger with `to: null`
 * - ISS-9487: a cross-org assignee refusal from the service reaches the caller
 *   as a 400 rather than the catch-all 500
 */

import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import { NUL_CHARACTER as NUL } from "@repo/api/src/types/postgres-text";
import { ProjectErrorCode, ProjectStatus } from "@repo/api/src/types/project";
import {
  ProjectFieldMutationErrorCode,
  staleProjectNameConflict,
} from "@repo/api/src/types/project-field-mutation";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PROJECT_UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VALID_TEAM_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** A syntactically valid assignee id that the service refuses (ISS-9487). */
const FOREIGN_USER_UUID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
/**
 * Deliberately NOT the shipped org-membership string, so the 400 case can only
 * pass if the route answers with the message the service result carries.
 */
const SERVICE_REFUSAL_MESSAGE = "refusal carried by the service result";
const ORG_TEAM_A = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Alpha Team",
};
const ORG_TEAM_B = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Beta Team",
};
const ORG_TEAMS = [ORG_TEAM_A, ORG_TEAM_B];

const MOCK_PROJECT = {
  id: PROJECT_UUID,
  name: "Existing Project",
  teams: [ORG_TEAM_A],
  assigneeId: null,
  customFields: [],
  tags: [],
  status: ProjectStatus.NotStarted,
  priority: Priority.Medium,
} as const;

/** `MOCK_PROJECT` with the audited fields moved, for the post-update read. */
function movedProject(
  over: Partial<{ status: ProjectStatus; priority: Priority | null }>
) {
  return { ...MOCK_PROJECT, ...over };
}

/** The audited fields as they stood before the write, as the service returns them. */
const PREVIOUS_FIELDS = {
  status: MOCK_PROJECT.status,
  priority: MOCK_PROJECT.priority,
};

/**
 * What `projectsService.update` now resolves with: the written row plus the
 * `FOR UPDATE`-locked before-image, both from the one transaction.
 */
function updateResult(project: {
  status: ProjectStatus;
  priority: Priority | null;
}) {
  return Result.ok({ project, previous: PREVIOUS_FIELDS });
}

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  resolveProjectId: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  listTeamOptions: vi.fn(),
  customFieldsPreflightResponse: vi.fn(() => Promise.resolve(null)),
  mergeCustomFieldsIntoResponse: vi.fn(),
  dispatchAssignmentNotification: vi.fn(),
  dispatchAuditEvents: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(
        { user: { id: "user-1", organizationId: "org-1" } },
        request,
        ctx.params
      ),
}));

// importOriginal spreads the real module so InvalidProjectTeamsError and
// InvalidProjectTeamsReason are the real class/const for instanceof checks.
vi.mock("../service", async (importOriginal) => {
  const real = await importOriginal<typeof import("../service")>();
  return {
    ...real,
    projectsService: {
      findById: mocks.findById,
      update: mocks.update,
    },
  };
});

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/identifier-utils")>();
  return {
    ...real,
    resolveProjectId: mocks.resolveProjectId,
  };
});

vi.mock("../../custom-fields/route-helpers", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../custom-fields/route-helpers")
  >()),
  customFieldsPreflightResponse: mocks.customFieldsPreflightResponse,
  mergeCustomFieldsIntoResponse: mocks.mergeCustomFieldsIntoResponse,
}));

vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: mocks.dispatchAssignmentNotification,
}));

// `userAuditActor` stays REAL so the asserted actor is the one production
// builds; only the outbox enqueue is spied.
vi.mock("@/app/audit/audit-emit-service", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/app/audit/audit-emit-service")>();
  return { ...real, dispatchAuditEvents: mocks.dispatchAuditEvents };
});

// team-requirement.ts imports teamsService from this path alias.
vi.mock("@/app/teams/service", () => ({
  teamsService: {
    listTeamOptions: mocks.listTeamOptions,
  },
}));

import { ArtifactCustomFieldValueErrorKind } from "../../custom-fields/artifact-custom-field-value-contract";
import { CustomFieldsRefusedError } from "../../custom-fields/route-helpers";
import {
  InvalidProjectTeamsError,
  InvalidProjectTeamsReason,
} from "../service";
import { PUT } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function putRequest(body: unknown) {
  return new NextRequest(`http://localhost:3002/projects/${PROJECT_UUID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// PUT /projects/[id]
// ---------------------------------------------------------------------------

describe("PUT /projects/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProjectId.mockResolvedValue(PROJECT_UUID);
    mocks.findById.mockResolvedValue(MOCK_PROJECT);
    mocks.update.mockResolvedValue(updateResult(MOCK_PROJECT));
    mocks.listTeamOptions.mockResolvedValue(ORG_TEAMS);
    mocks.mergeCustomFieldsIntoResponse.mockImplementation(
      async (project: unknown) => project
    );
  });

  // Case 1: teamIds: [] → 400 + team list; update NOT called
  it("returns 400 with team list when teamIds is an empty array", async () => {
    const response = await PUT(
      putRequest({ teamIds: [] }),
      routeCtx(PROJECT_UUID)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(ORG_TEAMS);
    expect(body.error).toContain(ORG_TEAM_A.name);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  // Case 2: teamIds omitted → succeeds, update called with no teamIds key
  it("succeeds and omits teamIds from the update call when teamIds is not in the body", async () => {
    const response = await PUT(
      putRequest({ name: "Updated Name" }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledOnce();
    const updateArg = mocks.update.mock.calls[0][2] as Record<string, unknown>;
    expect("teamIds" in updateArg).toBe(false);
  });

  // Case 3: valid teamIds → succeeds
  it("succeeds when teamIds contains a valid UUID", async () => {
    const response = await PUT(
      putRequest({ name: "Updated Name", teamIds: [VALID_TEAM_UUID] }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      PROJECT_UUID,
      "org-1",
      expect.objectContaining({ teamIds: [VALID_TEAM_UUID] }),
      undefined
    );
  });

  // Case 4: service rejects with Unresolved → 400 + team list (symmetric with POST)
  it("returns 400 with team list when the service rejects because a team id does not resolve", async () => {
    mocks.update.mockRejectedValueOnce(
      new InvalidProjectTeamsError(
        "One or more teams were not found in this organization.",
        InvalidProjectTeamsReason.Unresolved
      )
    );

    const response = await PUT(
      putRequest({ teamIds: [VALID_TEAM_UUID] }),
      routeCtx(PROJECT_UUID)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    expect(body.details.teams).toEqual(ORG_TEAMS);
  });

  // Case 4b (ISS-9487): the service's assignee refusal reaches the caller as a
  // 400 carrying the message the refusal itself carries.
  it("maps a refused update to 400 with the service's message", async () => {
    mocks.update.mockResolvedValueOnce(
      Result.err({
        status: Status.BadRequest,
        message: SERVICE_REFUSAL_MESSAGE,
      })
    );

    const response = await PUT(
      putRequest({ assigneeId: FOREIGN_USER_UUID }),
      routeCtx(PROJECT_UUID)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(SERVICE_REFUSAL_MESSAGE);
  });

  // ISS-11198: a stale guard is a 409 carrying its code and details, not the
  // 400 every other refused write gets.
  it("maps a stale field guard to 409 with its code and details", async () => {
    const stale = staleProjectNameConflict({
      projectId: PROJECT_UUID,
      currentName: "Renamed elsewhere",
      expectedName: MOCK_PROJECT.name,
    });
    mocks.update.mockResolvedValueOnce(Result.err(stale));

    const response = await PUT(
      putRequest({ name: "Mine", expectedName: MOCK_PROJECT.name }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: stale.message,
      code: ProjectFieldMutationErrorCode.StaleName,
      details: stale.details,
    });
    expect(mocks.update).toHaveBeenCalledWith(
      PROJECT_UUID,
      "org-1",
      {
        name: "Mine",
        expectedName: MOCK_PROJECT.name,
      },
      undefined
    );
  });

  // Case 5: unknown slug → resolveProjectId returns null → 404 before body parsing
  it("returns 404 when the project slug does not resolve, before reading the body", async () => {
    mocks.resolveProjectId.mockResolvedValueOnce(null);

    const response = await PUT(
      putRequest({ teamIds: [] }),
      routeCtx("pro-999")
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toContain("not found");
    // Body parsing (which would produce the team error) never ran
    expect(mocks.listTeamOptions).not.toHaveBeenCalled();
  });

  // Case 6: a UUID that DOES resolve, with teamIds: [] → 400
  //
  // The PUT route runs: resolveProjectId → parseBody → findById. The resolver
  // answers with the id, so body parsing runs next; teamIds: [] fails validation
  // and the route returns the team-required 400 before findById is ever called.
  // ISS-7447: the UUID branch is no longer a passthrough — it is an org-scoped
  // lookup like the slug branch — so what this case pins is the route's ORDER,
  // not a resolver that skipped the database.
  it("returns 400 from the team check when the id is UUID-shaped but teamIds is empty, before the existence check", async () => {
    mocks.resolveProjectId.mockResolvedValueOnce(PROJECT_UUID);

    const response = await PUT(
      putRequest({ teamIds: [] }),
      routeCtx(PROJECT_UUID)
    );
    const body = await response.json();

    // Team check ran (body parsing step), not the existence check (findById step)
    expect(response.status).toBe(400);
    expect(body.code).toBe(ProjectErrorCode.ProjectTeamRequired);
    // findById was NOT called — the route returned before reaching it
    expect(mocks.findById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ISS-9688 — the project audit receipt, at the route
// ---------------------------------------------------------------------------

describe("PUT /projects/[id] audit receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProjectId.mockResolvedValue(PROJECT_UUID);
    mocks.findById.mockResolvedValue(MOCK_PROJECT);
    mocks.update.mockResolvedValue(updateResult(MOCK_PROJECT));
    mocks.listTeamOptions.mockResolvedValue(ORG_TEAMS);
    mocks.mergeCustomFieldsIntoResponse.mockImplementation(
      async (project: unknown) => project
    );
  });

  /**
   * BOTH halves of the receipt now come from `projectsService.update` — the
   * locked before-image and that same transaction's written row (#7225 review).
   * The `findById` reads around the write feed the response, not the ledger, so
   * this deliberately leaves them at the pre-update value: if the route ever
   * goes back to diffing them, the transition under test disappears and these
   * cases fail.
   */
  function stageTransition(after: ReturnType<typeof movedProject>) {
    mocks.update.mockResolvedValue(updateResult(after));
  }

  it("emits project.status_changed when a project status moves", async () => {
    stageTransition(movedProject({ status: ProjectStatus.InProgress }));

    const response = await PUT(
      putRequest({ status: ProjectStatus.InProgress }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(200);
    expect(mocks.dispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: AuditAction.ProjectStatusChanged,
        objectType: AuditObjectType.Project,
        objectId: PROJECT_UUID,
        detail: {
          from: ProjectStatus.NotStarted,
          to: ProjectStatus.InProgress,
        },
      },
    ]);
  });

  it("emits project.priority_changed when a project priority moves", async () => {
    // The ticket's headline case: `useUpdateProjectPriority` is live on three
    // surfaces and produced no ledger entry at all.
    stageTransition(movedProject({ priority: Priority.Urgent }));

    const response = await PUT(
      putRequest({ priority: Priority.Urgent }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(200);
    expect(mocks.dispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: AuditAction.ProjectPriorityChanged,
        objectType: AuditObjectType.Project,
        objectId: PROJECT_UUID,
        detail: { from: Priority.Medium, to: Priority.Urgent },
      },
    ]);
  });

  it("emits nothing when the PUT changes neither audited field", async () => {
    mocks.findById.mockResolvedValue(MOCK_PROJECT);

    const response = await PUT(
      putRequest({ name: "Renamed" }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(200);
    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
  });

  /**
   * ISS-12552: the custom fields apply on the project write's own
   * transaction, so a refused value rolls the transition back with it. The
   * caller gets the 400 and the ledger gets nothing, because nothing
   * committed.
   */
  it("answers 400 and records no transition when a custom field is refused inside the write", async () => {
    mocks.update.mockRejectedValueOnce(
      new CustomFieldsRefusedError({
        kind: ArtifactCustomFieldValueErrorKind.InvalidValue,
        message: "bad custom field",
      })
    );

    const response = await PUT(
      putRequest({ status: ProjectStatus.InProgress }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(400);
    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
  });

  it("404s and records nothing when the locked row yielded no before-image", async () => {
    // No row to lock is the same answer as no project. It must not silently
    // become "nothing changed" — that would 200 a write that never happened.
    mocks.update.mockResolvedValue(
      Result.ok({ project: MOCK_PROJECT, previous: null })
    );

    const response = await PUT(
      putRequest({ status: ProjectStatus.InProgress }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(404);
    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ISS-9441 — the three-state priority write contract
// ---------------------------------------------------------------------------

/** The project as it stands once the clear has committed. */
const CLEARED_PROJECT = movedProject({ priority: null });

/** Not members of `Priority`, one shape per way a caller gets it wrong. */
const REFUSED_PRIORITIES = [
  ["the search grammar's unset token", "NONE"],
  ["an empty string", ""],
  ["a lowercased member", "medium"],
  ["a number", 3],
  ["an object", {}],
] as const;

describe("PUT /projects/[id] priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProjectId.mockResolvedValue(PROJECT_UUID);
    mocks.findById.mockResolvedValue(MOCK_PROJECT);
    mocks.update.mockResolvedValue(updateResult(MOCK_PROJECT));
    mocks.listTeamOptions.mockResolvedValue(ORG_TEAMS);
    mocks.mergeCustomFieldsIntoResponse.mockImplementation(
      async (project: unknown) => project
    );
  });

  it("clears the priority and answers priority: null for an explicit null", async () => {
    mocks.findById.mockResolvedValue(CLEARED_PROJECT);
    mocks.update.mockResolvedValue(updateResult(CLEARED_PROJECT));

    const response = await PUT(
      putRequest({ priority: null }),
      routeCtx(PROJECT_UUID)
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    // The `null` has to survive validation as a null, not be dropped on the way
    // to the service — a stripped key would leave the priority standing and
    // still answer 200.
    expect(mocks.update).toHaveBeenCalledWith(
      PROJECT_UUID,
      "org-1",
      expect.objectContaining({ priority: null }),
      undefined
    );
    expect(body.data.priority).toBeNull();
  });

  it("leaves the priority alone when the key is omitted", async () => {
    const response = await PUT(
      putRequest({ name: "Renamed" }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(200);
    const updateArg = mocks.update.mock.calls[0][2] as Record<string, unknown>;
    expect("priority" in updateArg).toBe(false);
  });

  it.each(REFUSED_PRIORITIES)(
    "returns 400 and writes nothing for %s",
    async (_label, value) => {
      const response = await PUT(
        putRequest({ priority: value }),
        routeCtx(PROJECT_UUID)
      );

      expect(response.status).toBe(400);
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );

  it("404s a clear on a project outside the caller's organization", async () => {
    // `resolveProjectId` is org-scoped, so another org's project does not
    // resolve. Asserted here rather than left to the generic PUT cases because
    // a clear is the one write this ticket adds, and an unscoped one would
    // silently erase another tenant's priority.
    mocks.resolveProjectId.mockResolvedValueOnce(null);

    const response = await PUT(
      putRequest({ priority: null }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("emits one project.priority_changed carrying to: null", async () => {
    mocks.findById.mockResolvedValue(CLEARED_PROJECT);
    mocks.update.mockResolvedValue(
      Result.ok({
        project: CLEARED_PROJECT,
        previous: { status: MOCK_PROJECT.status, priority: Priority.High },
      })
    );

    const response = await PUT(
      putRequest({ priority: null }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(200);
    expect(mocks.dispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: "org-1",
        actor: { actorType: "user", actorId: "user-1" },
        action: AuditAction.ProjectPriorityChanged,
        objectType: AuditObjectType.Project,
        objectId: PROJECT_UUID,
        detail: { from: Priority.High, to: null },
      },
    ]);
  });
});

// ISS-11195: a NUL in the name cleared the schema and failed the write at the
// `text` column as a 500.
describe("PUT /projects/[id] NUL in text fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProjectId.mockResolvedValue(PROJECT_UUID);
    mocks.findById.mockResolvedValue(MOCK_PROJECT);
    mocks.update.mockResolvedValue(updateResult(MOCK_PROJECT));
    mocks.mergeCustomFieldsIntoResponse.mockImplementation(
      async (project: unknown) => project
    );
  });

  it("strips a NUL from the name before the write", async () => {
    const response = await PUT(
      putRequest({ name: `a${NUL}b` }),
      routeCtx(PROJECT_UUID)
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      PROJECT_UUID,
      "org-1",
      {
        name: "ab",
      },
      undefined
    );
  });

  it("forwards a name with no NUL byte for byte", async () => {
    const name = "Roadmap 🚀 — Q4 ";

    const response = await PUT(putRequest({ name }), routeCtx(PROJECT_UUID));

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      PROJECT_UUID,
      "org-1",
      { name },
      undefined
    );
  });
});
