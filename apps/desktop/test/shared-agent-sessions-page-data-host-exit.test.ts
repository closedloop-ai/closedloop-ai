/**
 * @file shared-agent-sessions-page-data-host-exit.test.ts
 * @description ISS-5808 (wongk review) — the Sessions page-data usage half must
 * classify a db-host exit by the TYPED error, not by its message.
 *
 * `handleExit` mints the same `db-host exited (code: N)` string whether or not
 * the supervisor armed a replacement fork, so the message form marked a
 * permanently-down host `usageErrorTransient` and the summary cards sat in the
 * quiet reconnecting state retrying against a host nobody was bringing back —
 * the same "transient label that outlives its own truth" this ticket removed
 * from the Branches boundary.
 *
 * This half also CATCHES its own rejection, so the outer read's re-drive never
 * sees the exit and cannot correct the verdict: the classification has to be
 * right here. Sibling file rather than an addition to
 * `shared-agent-sessions-api.test.ts`, which is on the shrink-only
 * `noExcessiveLinesPerFile` grandfather list.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getSharedAgentSessionsPageData } from "../src/main/session/shared-agent-sessions-page-data.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import {
  createFakeSource,
  cursor,
} from "./shared-agent-sessions-test-helpers.js";

const EXIT_MESSAGE = "db-host exited (code: 0)";

function pageDataSource(usageRejection: unknown) {
  return createFakeSource({
    cursorRows: [cursor("session-a"), cursor("session-b")],
    aggregateUsage: () => {
      throw usageRejection;
    },
  });
}

describe("the Sessions usage half classifies a db-host exit by type (ISS-5808)", () => {
  test("an exit with a replacement coming still degrades to the quiet reconnecting state", async () => {
    const pageData = await getSharedAgentSessionsPageData(
      pageDataSource(new DbHostExitError(0, true, EXIT_MESSAGE)),
      { limit: 25 }
    );

    assert.equal(pageData.list.total, 2);
    assert.equal(pageData.usageError, true);
    assert.equal(
      pageData.usageErrorTransient,
      true,
      "a restarting child is exactly the case the quiet surface exists for"
    );
  });

  test("an exit with NO replacement coming is not marked transient", async () => {
    const pageData = await getSharedAgentSessionsPageData(
      pageDataSource(new DbHostExitError(0, false, EXIT_MESSAGE)),
      { limit: 25 }
    );

    assert.equal(pageData.list.total, 2);
    assert.equal(pageData.usageError, true);
    assert.equal(
      pageData.usageErrorTransient,
      undefined,
      "the message is identical to the recoverable case, so only the typed error can tell them apart — and a bounded refetch against a host nobody is restarting never ends"
    );
  });

  test("a sanitized rejection that kept the exit as its cause is still classified", async () => {
    const pageData = await getSharedAgentSessionsPageData(
      pageDataSource(
        new Error("SHARED_AGENT_SESSIONS_SOURCE_ERROR", {
          cause: new DbHostExitError(0, true, EXIT_MESSAGE),
        })
      ),
      { limit: 25 }
    );

    assert.equal(pageData.usageErrorTransient, true);
  });

  test("the untyped lifecycle strings keep classifying exactly as before", async () => {
    for (const message of ["db-host is closed", "db-host is not running"]) {
      const pageData = await getSharedAgentSessionsPageData(
        pageDataSource(new Error(message)),
        { limit: 25 }
      );
      assert.equal(
        pageData.usageErrorTransient,
        true,
        `${message} has no typed form, so the message fallback must still carry it`
      );
    }
  });

  test("a genuine aggregate failure stays an honest error", async () => {
    const pageData = await getSharedAgentSessionsPageData(
      pageDataSource(new Error("no such column: nope")),
      { limit: 25 }
    );

    assert.equal(pageData.usageError, true);
    assert.equal(pageData.usageErrorTransient, undefined);
  });
});
