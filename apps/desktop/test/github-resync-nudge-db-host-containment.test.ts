/**
 * @file github-resync-nudge-db-host-containment.test.ts
 * @description ISS-8856 — a db-host exit under the resync nudge's renderer
 * refresh must stay contained, and must say what killed it.
 *
 * The captured incident opened with two `GitHub resync nudge … refresh failed;
 * relying on pull recovery` warnings, half a second before the unhandled
 * `db-host exited (code: 1)` that ended the app. Those two lines could not be
 * read: the handler discarded the reason with a bare `catch {}`, so a refresh
 * that failed because the LOCAL STORE PROCESS had just died logged exactly what
 * a renderer-side failure logs. That ambiguity is why the ticket had to record
 * "evidence of the surrounding failure window rather than proof the nudge caused
 * the exit" as an open question.
 *
 * Two properties are pinned here, and they pull in opposite directions on
 * purpose — one says the failure must not propagate, the other says it must not
 * go quiet:
 *
 *  - CONTAINMENT: the nudge resolves, the accept ack stands, and the `done`
 *    event still reaches the cloud so its own pull recovery engages. A db-host
 *    death must not couple to the nudge's own outcome.
 *  - LEGIBILITY: the warning names the db-host exit, so containment is a handled
 *    failure rather than a swallowed one.
 *
 * Both rejection shapes are pinned, because the line must name the exit from
 * either: the raw `DbHostExitError`, and the laundered
 * `Error(LOCAL_BRANCHES_SOURCE_*)` a read behind `rethrowAsBranchSourceError`
 * throws with the original demoted to `cause`. ISS-12638 took the branch reads
 * out of this refresh path, so neither shape is the one production privileges.
 */
import assert from "node:assert/strict";
import {
  GITHUB_RESYNC_NUDGE_METHOD,
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
  GitHubDirtyScopeKind,
} from "@repo/api/src/types/github-dirty-scope";
import { test } from "vitest";
import {
  type DesktopCommandEvent,
  PROTOCOL_VERSION,
} from "../src/main/cloud/cloud-protocol.js";
import type {
  ReservedCommandAckPayload,
  ReservedCommandEventPayload,
} from "../src/main/cloud/reserved-command-handler.js";
import { handleGitHubResyncNudgeCommand } from "../src/main/github/github-resync-nudge.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import { SHARED_BRANCHES_TRANSIENT_ERROR_CODE } from "../src/shared/shared-branches-contract.js";

const COMMAND_ID = "iss-8856-nudge";
const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";
/** The exit code the incident's db-host died with. */
const CRASH_EXIT_CODE = 1;
/** The message `handleExit` mints for the ops abandoned with the child. */
const DB_HOST_EXIT_MESSAGE = `db-host exited (code: ${CRASH_EXIT_CODE})`;

/** A nudge command addressed at this device, as the cloud sends it. */
function makeNudgeCommand(): DesktopCommandEvent {
  return {
    commandId: COMMAND_ID,
    method: GITHUB_RESYNC_NUDGE_METHOD,
    operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
    path: GITHUB_RESYNC_NUDGE_PATH,
    body: {
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          repositoryFullName: "closedloop-ai/closedloop-ai",
          branchName: "feat/nudge",
        },
      ],
      computeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
    },
    timeoutMs: 30_000,
    protocolVersion: PROTOCOL_VERSION,
    messageId: "iss-8856-message",
    timestamp: "2026-09-02T13:07:02.000Z",
  };
}

/**
 * The db-host exit `handleExit` mints and fans out to every op in flight.
 *
 * `restartScheduled` is the caller's argument because the MESSAGE is identical
 * on both branches — it is the only thing that says whether the local store is
 * coming back.
 */
function dbHostExit(restartScheduled: boolean): DbHostExitError {
  return new DbHostExitError(
    CRASH_EXIT_CODE,
    restartScheduled,
    DB_HOST_EXIT_MESSAGE
  );
}

/**
 * The db-host exit as a laundering read boundary rethrows it (see header).
 *
 * Constructed rather than imported: `rethrowAsBranchSourceError` pulls in
 * `persistent-log.ts`, which imports `electron` at module scope and cannot load
 * under `test:node`. The CODE is the canonical constant, not a copied literal,
 * and the `{ cause }` shape mirrors that boundary's single `throw`.
 */
function launderedDbHostExit(restartScheduled = true): Error {
  return new Error(SHARED_BRANCHES_TRANSIENT_ERROR_CODE, {
    cause: dbHostExit(restartScheduled),
  });
}

/**
 * Drive the handler with a renderer refresh that dies exactly the way a live
 * db-host bounce kills it, and report everything the handler emitted.
 */
async function runNudgeUnderDbHostExit(refreshFailure: unknown): Promise<{
  acks: ReservedCommandAckPayload[];
  events: ReservedCommandEventPayload[];
  warnings: string[];
  threw: unknown;
}> {
  const acks: ReservedCommandAckPayload[] = [];
  const events: ReservedCommandEventPayload[] = [];
  const warnings: string[] = [];
  let threw: unknown = null;
  try {
    await handleGitHubResyncNudgeCommand(makeNudgeCommand(), {
      getActiveTargetContext: () => ({
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
      }),
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: (event) => events.push(event),
      notifyRendererRefresh: () => Promise.reject(refreshFailure),
      log: (_level, message) => warnings.push(message),
    });
  } catch (error) {
    threw = error;
  }
  return { acks, events, warnings, threw };
}

test("a db-host exit under the nudge refresh does not propagate out of the nudge", async () => {
  const run = await runNudgeUnderDbHostExit(launderedDbHostExit());

  assert.equal(
    run.threw,
    null,
    "the nudge absorbed the db-host exit instead of rejecting to its fire-and-forget caller"
  );
  assert.deepEqual(run.acks, [
    { commandId: COMMAND_ID, accepted: true, state: "accepted" },
  ]);
  // The `done` event is what tells the cloud to fall back to its own pull; a
  // db-host death that suppressed it would strand the nudge as accepted-and-
  // never-finished, which is the coupling this AC forbids.
  assert.deepEqual(run.events, [
    {
      commandId: COMMAND_ID,
      sequence: 1,
      eventType: "done",
      data: { type: "done", fallback: false },
    },
  ]);
});

test("the contained nudge failure names the db-host exit behind a laundering boundary", async () => {
  const run = await runNudgeUnderDbHostExit(launderedDbHostExit());

  assert.equal(
    run.warnings.length,
    1,
    "exactly one warning per failed refresh"
  );
  // The `.cause` walk is the whole point: reading `error.message` alone reports
  // the boundary's classification code, which EVERY failure inside those reads
  // shares, so a store that died is indistinguishable from a logic bug — the
  // ambiguity this line exists to remove.
  assert.ok(
    run.warnings[0].includes(DB_HOST_EXIT_MESSAGE),
    `the warning must name the db-host exit behind the sanitized code; saw: ${run.warnings[0]}`
  );
  // The code stays too: it is what the renderer branches on, so a triage read
  // has to be able to line the two up.
  assert.ok(
    run.warnings[0].includes(SHARED_BRANCHES_TRANSIENT_ERROR_CODE),
    `the warning keeps the classification the renderer acts on; saw: ${run.warnings[0]}`
  );
  assert.ok(
    run.warnings[0].includes("relying on pull recovery"),
    `the warning still states the recovery path; saw: ${run.warnings[0]}`
  );
});

test("an unlaundered db-host exit is named once, not doubled", async () => {
  // Not every path launders: `rethrowAsBranchSourceError` rethrows a shutdown
  // error unchanged, and since ISS-12638 this refresh crosses no such boundary.
  // When the top-level message IS the exit, it must be reported once.
  const run = await runNudgeUnderDbHostExit(dbHostExit(true));

  assert.equal(
    run.warnings.length,
    1,
    "exactly one warning per failed refresh"
  );
  assert.equal(
    run.warnings[0],
    `GitHub resync nudge ${COMMAND_ID} refresh failed; relying on pull recovery (${DB_HOST_EXIT_MESSAGE}; db-host restart scheduled)`
  );
});

test("the warning says whether the local store is actually coming back", async () => {
  // The exit MESSAGE is byte-identical either way, so this is the only bit that
  // tells a reader of "relying on pull recovery" whether local recovery is even
  // scheduled — the ISS-8856 second symptom (the ladder did not recover).
  const recovering = await runNudgeUnderDbHostExit(launderedDbHostExit(true));
  const terminal = await runNudgeUnderDbHostExit(launderedDbHostExit(false));

  assert.ok(
    recovering.warnings[0].endsWith("db-host restart scheduled)"),
    `a recoverable exit says a replacement is coming; saw: ${recovering.warnings[0]}`
  );
  assert.ok(
    terminal.warnings[0].endsWith("no db-host restart scheduled)"),
    `an unrecoverable exit says none is; saw: ${terminal.warnings[0]}`
  );
});
