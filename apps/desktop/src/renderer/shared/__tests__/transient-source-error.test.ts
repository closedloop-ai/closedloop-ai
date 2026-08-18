import { ApiError } from "@repo/app/shared/api/api-error";
import { isResponseBackedError } from "@repo/app/shared/query/query-client";
import { describe, expect, it } from "vitest";
import { SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE } from "../../../shared/shared-agent-sessions-contract";
import { SHARED_BRANCHES_TRANSIENT_ERROR_CODE } from "../../../shared/shared-branches-contract";
import {
  isTransientDbHostError,
  isTransientSourceError,
  TransientSourceError,
} from "../transient-source-error";

describe("isTransientDbHostError", () => {
  it.each([
    "db-host exited (code: 5)",
    "db-host is not running (op: list)",
    "db-host is closed (op: pageData)",
    // Case-insensitive + wrapped by the Electron IPC prefix.
    "Error invoking remote method 'x': Error: DB-HOST EXITED (code: 11)",
  ])("classifies the db-host lifecycle signature %s as transient", (message) => {
    expect(isTransientDbHostError(new Error(message))).toBe(true);
  });

  it.each([
    "SQLITE_CORRUPT: database disk image is malformed",
    "TypeError: cannot read properties of undefined",
    "sql error reading /Users/secret/cwd",
    // The generic db-host operation-failure fallback (no message) is NOT a restart —
    // it stays a fatal read, not a masked transient recover.
    "db-host error",
  ])("does not classify a genuine failure %s as transient", (message) => {
    expect(isTransientDbHostError(new Error(message))).toBe(false);
  });

  it("classifies an already-transient error as transient (idempotent)", () => {
    expect(
      isTransientDbHostError(
        new TransientSourceError(
          "Agent sessions source failed.",
          SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE
        )
      )
    ).toBe(true);
  });

  it("handles non-Error inputs without throwing", () => {
    expect(isTransientDbHostError(null)).toBe(false);
    expect(isTransientDbHostError(undefined)).toBe(false);
    expect(isTransientDbHostError("db-host exited (code: 5)")).toBe(true);
    expect(
      isTransientDbHostError({ message: "db-host is closed (op: x)" })
    ).toBe(true);
  });
});

describe("TransientSourceError", () => {
  it("carries the stable transient code and is NOT response-backed (so it retries)", () => {
    const error = new TransientSourceError(
      "Agent sessions source failed.",
      SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.code).toBe(SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE);
    // The whole point of the transient class: the shared query client's retry
    // predicate keys off `isResponseBackedError`. A response-backed error fails
    // fast; a transient one must stay eligible for the bounded retry.
    expect(isResponseBackedError(error)).toBe(false);
  });

  it("does not leak the raw underlying message", () => {
    const error = new TransientSourceError(
      "Agent sessions source failed.",
      SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE
    );
    expect(error.message).toBe("Agent sessions source failed.");
  });
});

describe("isTransientSourceError", () => {
  it("recognizes a TransientSourceError instance", () => {
    expect(
      isTransientSourceError(
        new TransientSourceError(
          "boom",
          SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE
        )
      )
    ).toBe(true);
  });

  it("recognizes an equivalent error carrying the transient code across a boundary", () => {
    // A structured-clone across an IPC/worker boundary loses the prototype but keeps
    // the code; the guard still classifies it.
    expect(
      isTransientSourceError({
        message: "Agent sessions source failed.",
        code: SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE,
      })
    ).toBe(true);
  });

  it("recognizes a bare Error whose message IS a transient code (the sanitized Branches boundary)", () => {
    // ISS-4483 (review cid 3679616167, wongk): the Branches main-process boundary
    // (`rethrowAsSourceError`) discards the raw db-host error and rethrows a bare
    // `Error(SHARED_BRANCHES_TRANSIENT_ERROR_CODE)` with NO `.code` property, so the
    // classification arrives only in the message text. The guard must still route it
    // to the reconnecting surface rather than the fatal `ApiError` it used to become.
    expect(
      isTransientSourceError(new Error(SHARED_BRANCHES_TRANSIENT_ERROR_CODE))
    ).toBe(true);
    // Wrapped by the Electron IPC prefix, the code substring still classifies.
    expect(
      isTransientSourceError(
        new Error(
          `Error invoking remote method 'x': ${SHARED_BRANCHES_TRANSIENT_ERROR_CODE}`
        )
      )
    ).toBe(true);
  });

  it("rejects a fatal ApiError and unrelated values", () => {
    expect(
      isTransientSourceError(new ApiError("nope", 500, "OTHER_CODE"))
    ).toBe(false);
    expect(isTransientSourceError(new Error("db-host exited (code: 5)"))).toBe(
      false
    );
    expect(isTransientSourceError(null)).toBe(false);
  });
});
