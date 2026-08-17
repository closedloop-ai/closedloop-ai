/**
 * ISS-6455 (wongk, #5099 review): the LOCAL list producer must not answer a
 * corrupt nullable timestamp with a fabricated instant.
 *
 * `parseSessionDate` floors an unparseable value at epoch 0 so a row with a
 * malformed `started_at` still sorts and still falls inside a date window. That
 * floor is an ORDERING device, and the SQL side mirrors it on purpose. Applied
 * to `ended_at` and `awaiting_input_since` it stops being one: those two fields
 * answer "is this run over" and "is it blocked on a human", and 1970 answers
 * both with a confident yes.
 *
 * The display side refuses to time a run on unreadable evidence
 * (`packages/app/agents/lib/session-displayed-status-with-waiting.ts`), but a
 * producer that coerces first hands it a VALID date and the guard never fires —
 * so the row badges Waiting and its Duration climbs against `now()` forever,
 * which is the exact defect for the desktop-local population that module names.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { mapListItem } from "../src/main/session/shared-agent-sessions-api.js";

const STARTED_AT = "2026-05-20T17:00:00.000Z";
const EPOCH_MS = 0;

function session(overrides: Partial<SyncedAgentSession>): SyncedAgentSession {
  return {
    agents: [],
    events: [],
    externalSessionId: "ses-corrupt-instants",
    startedAt: STARTED_AT,
    status: SESSION_STATUS.ACTIVE,
    tokenUsageByModel: [],
    updatedAt: STARTED_AT,
    ...overrides,
  } as SyncedAgentSession;
}

describe("mapListItem nullable instants (ISS-6455)", () => {
  it("serves null for an unparseable ended_at rather than an epoch-0 end", () => {
    const row = mapListItem(session({ endedAt: "13 o'clock" }));

    assert.equal(row.endedAt, null);
  });

  it("serves null for an unparseable awaiting_input_since rather than 1970", () => {
    // The load-bearing one: an epoch-0 value here reads as VALID evidence that
    // the run is blocked on a human, which projects Waiting and starts a clock.
    const row = mapListItem(session({ awaitingInputSince: "not-a-date" }));

    assert.equal(row.awaitingInputSince, null);
  });

  it("still parses a usable value on both fields", () => {
    // The control: `null` everywhere would satisfy the two cases above.
    const endedAt = "2026-05-20T18:30:00.000Z";
    const awaitingInputSince = "2026-05-20T17:45:00.000Z";
    const row = mapListItem(session({ awaitingInputSince, endedAt }));

    assert.equal(row.endedAt?.toISOString(), endedAt);
    assert.equal(row.awaitingInputSince?.toISOString(), awaitingInputSince);
    assert.notEqual(row.endedAt?.getTime(), EPOCH_MS);
  });

  it("keeps the epoch floor on the NON-nullable started_at, which sorting relies on", () => {
    // The narrowing is deliberate: `parseSessionDate` is unchanged, so a row
    // with a malformed start still orders and still falls inside a date window
    // instead of vanishing from the page.
    const row = mapListItem(session({ startedAt: "not-a-date" }));

    assert.equal(row.startedAt.getTime(), EPOCH_MS);
  });
});
