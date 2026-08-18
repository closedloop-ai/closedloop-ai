import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import {
  importedMainAgentStatus,
  resolveImportedEndsWithError,
  resolveImportedSessionStatus,
} from "../src/main/database/imported-session-status.js";

const ASSISTANT_TS = "2026-07-01T12:00:00.000Z";
const ERROR_TS = "2026-07-01T12:05:00.000Z";

type StatusInput = Pick<
  NormalizedSession,
  "apiErrors" | "endedOnUnrecoveredError" | "messages"
>;

function successfulRun(): StatusInput {
  return {
    apiErrors: [],
    messages: [{ role: "assistant", timestamp: ASSISTANT_TS, text: "done" }],
  };
}

function failedRun(): StatusInput {
  return {
    apiErrors: [
      { type: "overloaded_error", message: "boom", timestamp: ERROR_TS },
    ],
    messages: [{ role: "assistant", timestamp: ASSISTANT_TS, text: "before" }],
  };
}

describe("resolveImportedSessionStatus (FEA-4187 / ISS-4586)", () => {
  it("classifies a failed run (trailing unrecovered API error) as ERROR, never INACTIVE", () => {
    const status = resolveImportedSessionStatus(failedRun(), false);
    assert.equal(status, SESSION_STATUS.ERROR);
    assert.notEqual(status, SESSION_STATUS.INACTIVE);
  });

  it("classifies a genuinely successful run as INACTIVE (the terminal-not-failed state)", () => {
    assert.equal(
      resolveImportedSessionStatus(successfulRun(), false),
      SESSION_STATUS.INACTIVE
    );
  });

  it("honors a precomputed endedOnUnrecoveredError flag even when arrays were truncated away", () => {
    // The worker stamps the flag from the FULL session before clamping; the
    // sliced arrays reaching import may no longer contain the trailing error.
    const truncated: StatusInput = {
      endedOnUnrecoveredError: true,
      apiErrors: [],
      messages: [
        { role: "assistant", timestamp: ASSISTANT_TS, text: "before" },
      ],
    };
    assert.equal(
      resolveImportedSessionStatus(truncated, false),
      SESSION_STATUS.ERROR
    );
  });

  it("degrades an unknown/absent outcome to INACTIVE (no crash, honest terminal default)", () => {
    const unknown: StatusInput = { apiErrors: [], messages: [] };
    assert.equal(
      resolveImportedSessionStatus(unknown, false),
      SESSION_STATUS.INACTIVE
    );
  });

  it("classifies a recently-active run as ACTIVE regardless of the failure signal", () => {
    assert.equal(
      resolveImportedSessionStatus(failedRun(), true),
      SESSION_STATUS.ACTIVE
    );
  });
});

describe("resolveImportedEndsWithError (ISS-4586)", () => {
  it("is true for a run that ended on an unrecovered API error", () => {
    assert.equal(resolveImportedEndsWithError(failedRun()), true);
  });

  it("is false for a genuinely successful run", () => {
    assert.equal(resolveImportedEndsWithError(successfulRun()), false);
  });

  it("is false for an unknown/absent outcome (never fabricates a failure)", () => {
    assert.equal(
      resolveImportedEndsWithError({ apiErrors: [], messages: [] }),
      false
    );
  });

  it("honors a precomputed endedOnUnrecoveredError flag over clamped arrays", () => {
    // The worker stamps the flag from the FULL session before clamping; a `true`
    // flag with empty on-hand arrays must still read as error.
    assert.equal(
      resolveImportedEndsWithError({
        endedOnUnrecoveredError: true,
        apiErrors: [],
        messages: [
          { role: "assistant", timestamp: ASSISTANT_TS, text: "before" },
        ],
      }),
      true
    );
    // ...and a precomputed `false` is trusted even if a trailing error survived
    // the clamp, so a recovered run is not re-flipped to failed.
    assert.equal(
      resolveImportedEndsWithError({
        endedOnUnrecoveredError: false,
        ...failedRun(),
      }),
      false
    );
  });
});

describe("importedMainAgentStatus (FEA-4187 / ISS-4586)", () => {
  it("maps ERROR session -> ERROR agent", () => {
    assert.equal(
      importedMainAgentStatus(SESSION_STATUS.ERROR),
      DESKTOP_AGENT_STATUS.ERROR
    );
  });

  it("maps INACTIVE session -> COMPLETED agent (the agent vocabulary keeps its own terminal)", () => {
    assert.equal(
      importedMainAgentStatus(SESSION_STATUS.INACTIVE),
      DESKTOP_AGENT_STATUS.COMPLETED
    );
  });

  it("maps ACTIVE session -> WAITING agent", () => {
    assert.equal(
      importedMainAgentStatus(SESSION_STATUS.ACTIVE),
      DESKTOP_AGENT_STATUS.WAITING
    );
  });
});
