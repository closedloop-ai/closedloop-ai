import { describe, expect, it } from "vitest";
import {
  AgentSessionFieldMutationErrorCode,
  type AgentSessionStaleName,
  type AgentSessionStaleOwnerUserId,
  type AgentSessionStaleProjectId,
  staleSessionFieldsConflict,
} from "./agent-session-field-mutation.ts";
import {
  DocumentStatusMutationErrorCode,
  type DocumentStatusMutationStaleStatus,
  STALE_STATUS_CONFLICT_MESSAGE,
} from "./document-status-mutation.ts";
import { Status } from "./result.ts";
import { SESSION_STATUS } from "./session-status.ts";

const NAME_MESSAGE = "One or more sessions changed before the name update";
const PROJECT_MESSAGE =
  "One or more sessions changed before the project update";
const OWNER_MESSAGE = "One or more sessions changed before the owner update";

const name: AgentSessionStaleName = {
  documentId: "s1",
  currentName: "new",
  expectedName: "old",
};
const status: DocumentStatusMutationStaleStatus = {
  documentId: "s1",
  currentStatus: SESSION_STATUS.INACTIVE,
  expectedStatus: SESSION_STATUS.ACTIVE,
};
const projectId: AgentSessionStaleProjectId = {
  documentId: "s1",
  currentProjectId: null,
  expectedProjectId: "p1",
};
const ownerUserId: AgentSessionStaleOwnerUserId = {
  documentId: "s1",
  currentOwnerUserId: "u2",
  expectedOwnerUserId: null,
};

describe("staleSessionFieldsConflict", () => {
  it("returns null when no guard is stale", () => {
    expect(staleSessionFieldsConflict({})).toBeNull();
  });

  it("reuses the document route's stale_status code", () => {
    expect(AgentSessionFieldMutationErrorCode.StaleStatus).toBe(
      DocumentStatusMutationErrorCode.StaleStatus
    );
  });

  it.each([
    [
      "name",
      { name },
      AgentSessionFieldMutationErrorCode.StaleName,
      NAME_MESSAGE,
      { staleNames: [name] },
    ],
    [
      "status",
      { status },
      AgentSessionFieldMutationErrorCode.StaleStatus,
      STALE_STATUS_CONFLICT_MESSAGE,
      { staleStatuses: [status] },
    ],
    [
      "projectId",
      { projectId },
      AgentSessionFieldMutationErrorCode.StaleProjectId,
      PROJECT_MESSAGE,
      { staleProjectIds: [projectId] },
    ],
    [
      "ownerUserId",
      { ownerUserId },
      AgentSessionFieldMutationErrorCode.StaleOwnerUserId,
      OWNER_MESSAGE,
      { staleOwnerUserIds: [ownerUserId] },
    ],
  ])(
    "builds a 409 carrying only the stale %s",
    (_label, stale, code, message, details) => {
      expect(staleSessionFieldsConflict(stale)).toEqual({
        status: Status.Conflict,
        code,
        message,
        details,
      });
    }
  );

  it("names the first stale field in listed order and reports every stale field", () => {
    expect(
      staleSessionFieldsConflict({ name, status, projectId, ownerUserId })
    ).toEqual({
      status: Status.Conflict,
      code: AgentSessionFieldMutationErrorCode.StaleName,
      message: NAME_MESSAGE,
      details: {
        staleNames: [name],
        staleStatuses: [status],
        staleProjectIds: [projectId],
        staleOwnerUserIds: [ownerUserId],
      },
    });
  });

  it.each([
    [
      { status, projectId, ownerUserId },
      AgentSessionFieldMutationErrorCode.StaleStatus,
    ],
    [
      { projectId, ownerUserId },
      AgentSessionFieldMutationErrorCode.StaleProjectId,
    ],
  ])("status outranks project, project outranks owner", (stale, code) => {
    expect(staleSessionFieldsConflict(stale)?.code).toBe(code);
  });
});
