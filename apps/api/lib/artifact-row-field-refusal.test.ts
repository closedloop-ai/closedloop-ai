import {
  AGENT_SESSION_ROW_FIELD_EDIT,
  AgentSessionPatchField,
  ArtifactRowFieldMutationErrorCode,
  BRANCH_ROW_FIELD_EDIT,
  BranchPatchField,
} from "@repo/api/src/types/artifact-row-field-edit";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { BranchStatus } from "@repo/api/src/types/branch";
import { Status } from "@repo/api/src/types/result";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { unsupportedRowFieldError } from "./artifact-row-field-refusal";

const SESSION_WRITABLE = Object.values(AgentSessionPatchField);
const BRANCH_WRITABLE = Object.values(BranchPatchField);

function sessionRefusal(rawBody: unknown) {
  return unsupportedRowFieldError(
    rawBody,
    AGENT_SESSION_ROW_FIELD_EDIT,
    SESSION_WRITABLE
  );
}

describe("unsupportedRowFieldError (ISS-9485)", () => {
  it("refuses a row field the type does not write, naming it and the writable keys", () => {
    expect(
      sessionRefusal({ status: SESSION_STATUS.ACTIVE, cost: "1.00" })
    ).toEqual({
      status: Status.BadRequest,
      code: ArtifactRowFieldMutationErrorCode.UnsupportedField,
      message: 'Unrecognized key: "cost"',
      details: {
        unsupportedFields: ["cost"],
        writableFields: SESSION_WRITABLE,
      },
    });
  });

  it("names every refused key in Zod's own unrecognized-key text", () => {
    expect(sessionRefusal({ cost: "1.00", harness: "x" })?.message).toBe(
      'Unrecognized keys: "harness", "cost"'
    );
  });

  it("passes a body of writable fields and companion keys", () => {
    expect(
      sessionRefusal({
        name: "n",
        status: SESSION_STATUS.ACTIVE,
        priority: null,
        expectedPriority: null,
        projectId: null,
        ownerUserId: null,
        surface: ArtifactStatusEditSurface.InlineCell,
      })
    ).toBeNull();
  });

  it("points a read-side name at the body key that writes it", () => {
    expect(
      sessionRefusal({ project: {}, assignee: null, harness: "x" })?.details
    ).toEqual({
      unsupportedFields: ["assignee", "harness", "project"],
      writableFields: SESSION_WRITABLE,
      useFields: {
        project: AgentSessionPatchField.ProjectId,
        // ISS-12251 D-1: the Owner is the assignee, which `ownerUserId` writes.
        assignee: AgentSessionPatchField.OwnerUserId,
      },
    });
  });

  it("refuses the recording user with no body key to point at", () => {
    // ISS-12251 D-2: `user` is no longer the Owner, and nothing writes it.
    expect(sessionRefusal({ user: null })?.details).toEqual({
      unsupportedFields: ["user"],
      writableFields: SESSION_WRITABLE,
    });
  });

  it("leaves a key that is not a row field to the validator", () => {
    expect(
      sessionRefusal({ status: SESSION_STATUS.ACTIVE, notARowField: 1 })
    ).toBeNull();
  });

  it("does not match inherited object keys", () => {
    expect(
      sessionRefusal(JSON.parse('{"__proto__": 1, "constructor": 2}'))
    ).toBeNull();
  });

  it.each([null, [], ["cost"], "cost", 5, undefined])(
    "leaves a non-object body (%j) to the validator",
    (rawBody) => {
      expect(sessionRefusal(rawBody)).toBeNull();
    }
  );

  it("reads each type against its own registry", () => {
    expect(
      unsupportedRowFieldError(
        { priority: null, branchName: "main" },
        BRANCH_ROW_FIELD_EDIT,
        BRANCH_WRITABLE
      )?.details
    ).toEqual({
      unsupportedFields: ["branchName"],
      writableFields: BRANCH_WRITABLE,
    });
    // `status` is writable on a Session and derived on a Branch.
    expect(sessionRefusal({ status: SESSION_STATUS.ACTIVE })).toBeNull();
    expect(
      unsupportedRowFieldError(
        { status: BranchStatus.Open },
        BRANCH_ROW_FIELD_EDIT,
        BRANCH_WRITABLE
      )?.details?.unsupportedFields
    ).toEqual(["status"]);
  });
});
