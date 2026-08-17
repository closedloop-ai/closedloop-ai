import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { coerceSharedBranchDetailRequest } from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";

describe("shared Branch detail IPC request coercion", () => {
  test("preserves legacy strings and omitted optional fields", () => {
    assert.deepEqual(coerceSharedBranchDetailRequest("branch-id"), {
      id: "branch-id",
    });
    assert.deepEqual(coerceSharedBranchDetailRequest({ id: "branch-id" }), {
      id: "branch-id",
    });
  });

  test("normalizes a complete selected pull-request identity", () => {
    assert.deepEqual(
      coerceSharedBranchDetailRequest({
        id: "branch-id",
        forceRefresh: true,
        repositoryFullName: " /ClosedLoop-AI/Symphony-Alpha.git/ ",
        pullRequestNumber: "4473",
      }),
      {
        id: "branch-id",
        forceRefresh: true,
        repositoryFullName: "closedloop-ai/symphony-alpha",
        pullRequestNumber: 4473,
      }
    );
  });

  test("rejects half-pairs and malformed identities", () => {
    assert.throws(() =>
      coerceSharedBranchDetailRequest({
        id: "branch-id",
        repositoryFullName: "closedloop-ai/symphony-alpha",
      })
    );
    assert.throws(() =>
      coerceSharedBranchDetailRequest({
        id: "branch-id",
        repositoryFullName: "closedloop-ai/symphony-alpha",
        pullRequestNumber: 0,
      })
    );
    assert.throws(
      () =>
        coerceSharedBranchDetailRequest({
          id: "branch-id",
          forceRefresh: "yes",
        }),
      INVALID_FORCE_REFRESH_ERROR
    );
  });

  test("ignores unknown additive object fields from a newer renderer", () => {
    assert.deepEqual(
      coerceSharedBranchDetailRequest({
        id: "branch-id",
        futureOption: { enabled: true },
      }),
      { id: "branch-id" }
    );
  });

  test("fails closed for invalid ids and non-object requests", () => {
    assert.equal(coerceSharedBranchDetailRequest(""), null);
    assert.equal(coerceSharedBranchDetailRequest({ id: "" }), null);
    assert.equal(coerceSharedBranchDetailRequest(null), null);
    assert.equal(coerceSharedBranchDetailRequest(4473), null);
  });
});

const INVALID_FORCE_REFRESH_ERROR = /Invalid Branch detail forceRefresh value/;
